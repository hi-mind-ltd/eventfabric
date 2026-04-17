import type { OutboxStore, OutboxRow as CoreOutboxRow } from "@eventfabric/core";
import type { PgTx } from "../unitofwork/pg-transaction";
import { RowShapeError } from "../pg-event-store";

export type OutboxRow = CoreOutboxRow;

/** Shape of an `eventfabric.outbox` row as returned by `claimBatch`'s RETURNING clause. */
type PgOutboxRow = {
  id: number | string;
  global_position: number | string | bigint;
  topic: string | null;
  attempts: number | string;
};

function assertOutboxRow(r: unknown): asserts r is PgOutboxRow {
  if (r === null || typeof r !== "object") {
    throw new RowShapeError("eventfabric.outbox row is not an object");
  }
  const o = r as Record<string, unknown>;
  // id, global_position, attempts are NOT NULL in the schema; topic is nullable.
  for (const field of ["id", "global_position", "attempts"] as const) {
    if (o[field] === undefined || o[field] === null) {
      throw new RowShapeError(`eventfabric.outbox row missing required field '${field}'`);
    }
  }
}

export class PgOutboxStore implements OutboxStore<PgTx> {
  constructor(
    private readonly outboxTable: string = "eventfabric.outbox",
    private readonly dlqTable: string = "eventfabric.outbox_dead_letters"
  ) {}

  async claimBatch(tx: PgTx, opts: { batchSize: number; workerId: string; topic?: string | null }): Promise<OutboxRow[]> {
    const { batchSize, workerId, topic } = opts;

    const res = await tx.client.query(
      `WITH cte AS (
         SELECT id
         FROM ${this.outboxTable}
         WHERE tenant_id = $4
           AND dead_lettered_at IS NULL
           AND locked_at IS NULL
           AND ($3::text IS NULL OR topic = $3)
         ORDER BY id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE ${this.outboxTable} o
       SET locked_at = now(),
           locked_by = $2,
           attempts = attempts + 1
       FROM cte
       WHERE o.id = cte.id
       RETURNING o.id, o.global_position, o.topic, o.attempts`,
      [batchSize, workerId, topic ?? null, tx.tenantId]
    );

    return res.rows.map((r: unknown) => {
      assertOutboxRow(r);
      return {
        id: Number(r.id),
        globalPosition: BigInt(r.global_position as string | number | bigint),
        topic: r.topic ?? null,
        attempts: Number(r.attempts)
      };
    });
  }

  async ack(tx: PgTx, id: OutboxRow["id"]): Promise<void> {
    await tx.client.query(`DELETE FROM ${this.outboxTable} WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id]);
  }

  async releaseWithError(tx: PgTx, id: OutboxRow["id"], error: string): Promise<void> {
    await tx.client.query(
      `UPDATE ${this.outboxTable}
       SET locked_at = NULL, locked_by = NULL, last_error = $3
       WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, id, error]
    );
  }

  async deadLetter(tx: PgTx, row: OutboxRow, reason: string): Promise<void> {
    // copy details then delete from outbox
    await tx.client.query(
      `INSERT INTO ${this.dlqTable} (tenant_id, outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
       SELECT tenant_id, id, global_position, topic, attempts, last_error, now()
       FROM ${this.outboxTable}
       WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, row.id]
    );

    await tx.client.query(
      `UPDATE ${this.outboxTable}
       SET dead_lettered_at = now(), dead_letter_reason = $3
       WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, row.id, reason]
    );

    // remove from active queue
    await tx.client.query(`DELETE FROM ${this.outboxTable} WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, row.id]);
  }
}
