import type { Pool } from "pg";
import type { DlqService, DlqItem, ListDlqOptions } from "@eventfabric/core";
import { PgUnitOfWork } from "../unitofwork/pg-unit-of-work";
import type { PgTx } from "../unitofwork/pg-transaction";

export class PgDlqService implements DlqService {
  private readonly uow: PgUnitOfWork;

  constructor(
    pool: Pool,
    private readonly outboxTable: string = "eventfabric.outbox",
    private readonly dlqTable: string = "eventfabric.outbox_dead_letters"
  ) {
    this.uow = new PgUnitOfWork(pool);
  }

  async list(options: ListDlqOptions = {}): Promise<{ items: DlqItem[]; total: number }> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return this.uow.withTransaction(async (tx) => {
      const where = `($1::text IS NULL OR topic = $1)`;

      const totalRes = await tx.client.query(
        `SELECT COUNT(*)::int AS total FROM ${this.dlqTable} WHERE ${where}`,
        [options.topic ?? null]
      );

      const res = await tx.client.query(
        `SELECT id, outbox_id, global_position, topic, attempts, last_error, dead_lettered_at
         FROM ${this.dlqTable}
         WHERE ${where}
         ORDER BY dead_lettered_at DESC
         LIMIT $2 OFFSET $3`,
        [options.topic ?? null, limit, offset]
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
         WHERE id = $1`,
        [dlqId]
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
       WHERE id = $1
       FOR UPDATE`,
      [dlqId]
    );

    if (dlqRes.rowCount === 0) return { requeued: false, reason: "DLQ item not found" };

    const row = dlqRes.rows[0];
    const globalPosition = BigInt(row.global_position);
    const topic = row.topic ?? null;

    await tx.client.query(
      `INSERT INTO ${this.outboxTable} (global_position, topic, locked_at, locked_by, attempts, last_error)
       VALUES ($1, $2, NULL, NULL, 0, NULL)
       ON CONFLICT (global_position) DO NOTHING`,
      [globalPosition.toString(), topic]
    );

    await tx.client.query(`DELETE FROM ${this.dlqTable} WHERE id = $1`, [dlqId]);
    return { requeued: true };
  }

  async requeueByGlobalPosition(globalPosition: bigint): Promise<{ requeued: boolean; reason?: string }> {
    return this.uow.withTransaction(async (tx) => {
      const res = await tx.client.query(
        `SELECT id FROM ${this.dlqTable} WHERE global_position = $1 FOR UPDATE`,
        [globalPosition.toString()]
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
         WHERE global_position BETWEEN $1 AND $2
         ORDER BY global_position ASC
         FOR UPDATE`,
        [from.toString(), to.toString()]
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
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

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

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const res = await tx.client.query(
        `DELETE FROM ${this.dlqTable} ${whereClause}`,
        params
      );
      return { purged: res.rowCount ?? 0 };
    });
  }
}
