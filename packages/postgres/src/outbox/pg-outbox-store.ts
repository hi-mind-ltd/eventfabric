import { LeaseLostError, type OutboxStore, type OutboxRow as CoreOutboxRow } from "@eventfabric/core";
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

  async claimBatch(
    tx: PgTx,
    opts: { batchSize: number; workerId: string; topic?: string | null; leaseMs?: number }
  ): Promise<OutboxRow[]> {
    const { batchSize, workerId, topic, leaseMs } = opts;

    // A row is claimable when unlocked, or (with a lease) when its lock is
    // older than the lease — i.e. its worker died after claiming it.
    const res = await tx.client.query(
      `WITH cte AS (
         SELECT id
         FROM ${this.outboxTable}
         WHERE dead_lettered_at IS NULL
           AND (
             locked_at IS NULL
             OR ($4::bigint IS NOT NULL AND locked_at < now() - $4::bigint * interval '1 millisecond')
           )
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
      [batchSize, workerId, topic ?? null, leaseMs ?? null]
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

  // Every write below takes an optional workerId. With it, the statement only
  // touches the row while that worker still holds the lease (locked_by), so a
  // worker whose handler outlived leaseMs cannot ack, release or dead-letter
  // a row another worker has taken over.

  async ack(tx: PgTx, id: OutboxRow["id"], workerId?: string): Promise<void> {
    const res = await tx.client.query(
      `DELETE FROM ${this.outboxTable} WHERE id = $1 AND ($2::text IS NULL OR locked_by = $2)`,
      [id, workerId ?? null]
    );
    if (workerId !== undefined && res.rowCount === 0) throw new LeaseLostError(id, workerId);
  }

  async releaseWithError(tx: PgTx, id: OutboxRow["id"], error: string, workerId?: string): Promise<void> {
    await tx.client.query(
      `UPDATE ${this.outboxTable}
       SET locked_at = NULL, locked_by = NULL, last_error = $2
       WHERE id = $1 AND ($3::text IS NULL OR locked_by = $3)`,
      [id, error, workerId ?? null]
    );
  }

  async release(tx: PgTx, ids: OutboxRow["id"][], workerId?: string): Promise<void> {
    if (ids.length === 0) return;
    await tx.client.query(
      `UPDATE ${this.outboxTable}
       SET locked_at = NULL, locked_by = NULL, attempts = GREATEST(attempts - 1, 0)
       WHERE id = ANY($1::bigint[]) AND ($2::text IS NULL OR locked_by = $2)`,
      [ids.map(String), workerId ?? null]
    );
  }

  async deadLetter(tx: PgTx, row: OutboxRow, reason: string, workerId?: string): Promise<void> {
    // Delete first so the lease check and the removal are one statement, then
    // copy the deleted row's details into the DLQ.
    const del = await tx.client.query(
      `DELETE FROM ${this.outboxTable}
       WHERE id = $1 AND ($2::text IS NULL OR locked_by = $2)
       RETURNING tenant_id, id, global_position, topic, attempts, last_error`,
      [row.id, workerId ?? null]
    );
    if (del.rowCount === 0) {
      if (workerId !== undefined) throw new LeaseLostError(row.id, workerId);
      return;
    }
    const r = del.rows[0];
    await tx.client.query(
      `INSERT INTO ${this.dlqTable} (tenant_id, outbox_id, global_position, topic, attempts, last_error, reason, dead_lettered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [r.tenant_id, r.id, r.global_position, r.topic, r.attempts, r.last_error, reason]
    );
  }
}
