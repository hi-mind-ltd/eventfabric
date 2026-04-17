import type { Pool } from "pg";
import type { DlqService, DlqItem, ListDlqOptions } from "@eventfabric/core";
import { PgUnitOfWork } from "../unitofwork/pg-unit-of-work";
import type { PgTx } from "../unitofwork/pg-transaction";

export class PgDlqService implements DlqService {
  private readonly uow: PgUnitOfWork;

  constructor(
    pool: Pool,
    private readonly outboxTable: string = "eventfabric.outbox",
    private readonly dlqTable: string = "eventfabric.outbox_dead_letters",
    tenantId: string = "default"
  ) {
    this.uow = new PgUnitOfWork(pool, tenantId);
  }

  async list(options: ListDlqOptions = {}): Promise<{ items: DlqItem[]; total: number }> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return this.uow.withTransaction(async (tx) => {
      const where = `tenant_id = $1 AND ($2::text IS NULL OR topic = $2)`;

      const totalRes = await tx.client.query(
        `SELECT COUNT(*)::int AS total FROM ${this.dlqTable} WHERE ${where}`,
        [tx.tenantId, options.topic ?? null]
      );

      const res = await tx.client.query(
        `SELECT id, outbox_id, global_position, topic, attempts, last_error, dead_lettered_at
         FROM ${this.dlqTable}
         WHERE ${where}
         ORDER BY dead_lettered_at DESC
         LIMIT $3 OFFSET $4`,
        [tx.tenantId, options.topic ?? null, limit, offset]
      );

      return {
        total: totalRes.rows[0]?.total ?? 0,
        items: res.rows.map((r: any) => ({
          id: Number(r.id),
          outboxId: Number(r.outbox_id),
          globalPosition: BigInt(r.global_position),
          topic: r.topic ?? null,
          attempts: Number(r.attempts),
          lastError: r.last_error ?? null,
          deadLetteredAt: new Date(r.dead_lettered_at).toISOString()
        }))
      };
    });
  }

  async get(dlqId: DlqItem["id"]): Promise<DlqItem | null> {
    return this.uow.withTransaction(async (tx) => {
      const res = await tx.client.query(
        `SELECT id, outbox_id, global_position, topic, attempts, last_error, dead_lettered_at
         FROM ${this.dlqTable}
         WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, dlqId]
      );
      if (res.rowCount === 0) return null;
      const r: any = res.rows[0];
      return {
        id: Number(r.id),
        outboxId: Number(r.outbox_id),
        globalPosition: BigInt(r.global_position),
        topic: r.topic ?? null,
        attempts: Number(r.attempts),
        lastError: r.last_error ?? null,
        deadLetteredAt: new Date(r.dead_lettered_at).toISOString()
      };
    });
  }

  async requeue(dlqId: DlqItem["id"]): Promise<{ requeued: boolean; reason?: string }> {
    return this.uow.withTransaction(async (tx: PgTx) => {
      return this.requeueInternal(tx, dlqId);
    });
  }

  private async requeueInternal(tx: PgTx, dlqId: DlqItem["id"]): Promise<{ requeued: boolean; reason?: string }> {
    const dlqRes = await tx.client.query(
      `SELECT id, global_position, topic
       FROM ${this.dlqTable}
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tx.tenantId, dlqId]
    );

    if (dlqRes.rowCount === 0) return { requeued: false, reason: "DLQ item not found" };

    const row = dlqRes.rows[0];
    const globalPosition = BigInt(row.global_position);
    const topic = row.topic ?? null;

    await tx.client.query(
      `INSERT INTO ${this.outboxTable} (tenant_id, global_position, topic, locked_at, locked_by, attempts, last_error)
       VALUES ($1, $2, $3, NULL, NULL, 0, NULL)
       ON CONFLICT (global_position) DO NOTHING`,
      [tx.tenantId, globalPosition.toString(), topic]
    );

    await tx.client.query(`DELETE FROM ${this.dlqTable} WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, dlqId]);
    return { requeued: true };
  }

  async requeueByGlobalPosition(globalPosition: bigint): Promise<{ requeued: boolean; reason?: string }> {
    return this.uow.withTransaction(async (tx) => {
      const res = await tx.client.query(
        `SELECT id FROM ${this.dlqTable} WHERE tenant_id = $1 AND global_position = $2 FOR UPDATE`,
        [tx.tenantId, globalPosition.toString()]
      );
      if (res.rowCount === 0) return { requeued: false, reason: "DLQ item not found" };
      return this.requeueInternal(tx, Number(res.rows[0].id));
    });
  }

  async requeueRange(from: bigint, to: bigint): Promise<{ requeued: number }> {
    return this.uow.withTransaction(async (tx) => {
      const res = await tx.client.query(
        `SELECT id
         FROM ${this.dlqTable}
         WHERE tenant_id = $1 AND global_position BETWEEN $2 AND $3
         ORDER BY global_position ASC
         FOR UPDATE`,
        [tx.tenantId, from.toString(), to.toString()]
      );

      let count = 0;
      for (const r of res.rows) {
        const result = await this.requeueInternal(tx, Number(r.id));
        if (result.requeued) count++;
      }
      return { requeued: count };
    });
  }

  async purge(options?: { topic?: string | null; olderThan?: Date }): Promise<{ purged: number }> {
    return this.uow.withTransaction(async (tx) => {
      const conditions: string[] = [`tenant_id = $1`];
      const params: any[] = [tx.tenantId];
      let paramIndex = 2;

      if (options?.topic !== undefined) {
        conditions.push(`($${paramIndex}::text IS NULL OR topic = $${paramIndex})`);
        params.push(options.topic ?? null);
        paramIndex++;
      }

      if (options?.olderThan) {
        conditions.push(`dead_lettered_at < $${paramIndex}`);
        params.push(options.olderThan.toISOString());
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(" AND ")}`;

      const res = await tx.client.query(
        `DELETE FROM ${this.dlqTable} ${whereClause}`,
        params
      );
      return { purged: res.rowCount ?? 0 };
    });
  }
}
