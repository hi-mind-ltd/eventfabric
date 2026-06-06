import type { Command } from "@eventfabric/mediator";
import type { PgTx } from "@eventfabric/postgres";
import type {
  SagaCommandQueue,
  SagaCommandQueueItem,
} from "@eventfabric/sagas";

export interface PgSagaCommandQueueOptions {
  /** Schema-qualified table name. Default: "eventfabric.saga_pending_commands". */
  readonly tableName?: string;
  /**
   * Claim ordering strategy. Default `"fifo"` orders by row id ASC
   * (oldest first). `"fair-by-tenant"` round-robins between tenants
   * with pending work — a tenant with 10k rows cannot starve a tenant
   * with 1 row. Picks one row per tenant per batch via DISTINCT ON.
   */
  readonly claimStrategy?: "fifo" | "fair-by-tenant";
}

interface ClaimRow {
  id: string;
  tenant_id: string;
  saga_name: string;
  instance_id: string;
  command: Command;
  attempts: number;
  causation_event_id: string | null;
}

/**
 * Postgres-backed outbox for commands emitted by sagas. The saga runner
 * `enqueue`s in the same transaction as the saga state advance —
 * atomicity by construction.
 *
 * `claimBatch` uses `SELECT ... FOR UPDATE SKIP LOCKED` so multiple
 * dispatcher workers run in parallel without overlap. Claimed rows are
 * marked `status='claimed'` and assigned a `claimed_at` so a watchdog
 * can detect crashed workers.
 *
 * `ack` deletes the row (no audit table — the events the dispatched
 * command produced are the durable record). `releaseWithError` returns
 * the row to `pending` and bumps `attempts`; the dispatcher decides at
 * what attempts count to flip to `status='failed'`.
 */
export class PgSagaCommandQueue implements SagaCommandQueue<PgTx> {
  private readonly tableName: string;
  private readonly claimStrategy: "fifo" | "fair-by-tenant";

  constructor(opts?: PgSagaCommandQueueOptions) {
    this.tableName = opts?.tableName ?? "eventfabric.saga_pending_commands";
    this.claimStrategy = opts?.claimStrategy ?? "fifo";
  }

  async enqueue(
    tx: PgTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      command: Command;
      causationEventId?: string | null;
    }
  ): Promise<void> {
    await tx.client.query(
      `INSERT INTO ${this.tableName}
         (tenant_id, saga_name, instance_id, command, causation_event_id, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'pending')`,
      [
        params.tenantId,
        params.sagaName,
        params.instanceId,
        JSON.stringify(params.command),
        params.causationEventId ?? null,
      ]
    );
  }

  async claimBatch(
    tx: PgTx,
    params: { batchSize: number }
  ): Promise<SagaCommandQueueItem[]> {
    // Both strategies share: skip rows held back by retry backoff
    // (next_attempt_at in the future) and use FOR UPDATE SKIP LOCKED so
    // parallel dispatchers don't overlap.
    //
    // PG forbids DISTINCT ON together with FOR UPDATE in the same SELECT,
    // so fair-by-tenant runs DISTINCT ON in a CTE that picks one
    // candidate per tenant, then a second SELECT applies FOR UPDATE on
    // those specific IDs.
    const cteSql =
      this.claimStrategy === "fair-by-tenant"
        ? `WITH candidates AS (
             SELECT DISTINCT ON (tenant_id) id FROM ${this.tableName}
              WHERE status = 'pending'
                AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
              ORDER BY tenant_id, id ASC
           ),
           claimed AS (
             SELECT id FROM ${this.tableName}
              WHERE id IN (SELECT id FROM candidates)
              ORDER BY id ASC
              FOR UPDATE SKIP LOCKED
              LIMIT $1
           )`
        : `WITH claimed AS (
             SELECT id FROM ${this.tableName}
              WHERE status = 'pending'
                AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
              ORDER BY id ASC
              FOR UPDATE SKIP LOCKED
              LIMIT $1
           )`;
    const res = await tx.client.query(
      `${cteSql}
       UPDATE ${this.tableName} t
          SET status = 'claimed',
              attempts = t.attempts + 1,
              claimed_at = NOW()
         FROM claimed c
        WHERE t.id = c.id
       RETURNING t.id, t.tenant_id, t.saga_name, t.instance_id, t.command, t.attempts, t.causation_event_id`,
      [params.batchSize]
    );
    return res.rows.map((r: ClaimRow) => ({
      id: String(r.id),
      tenantId: r.tenant_id,
      sagaName: r.saga_name,
      instanceId: r.instance_id,
      command: r.command,
      attempts: Number(r.attempts),
      causationEventId: r.causation_event_id,
    }));
  }

  async ack(tx: PgTx, params: { id: string }): Promise<void> {
    await tx.client.query(
      `DELETE FROM ${this.tableName} WHERE id = $1`,
      [params.id]
    );
  }

  async releaseWithError(
    tx: PgTx,
    params: { id: string; error: Error; delayUntil?: Date }
  ): Promise<void> {
    await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'pending',
              last_error = $1,
              claimed_at = NULL,
              next_attempt_at = $2
        WHERE id = $3`,
      [
        params.error.message,
        params.delayUntil ? params.delayUntil.toISOString() : null,
        params.id,
      ]
    );
  }

  /** Mark a row dead — keeps it visible to ops without re-claiming. */
  async markFailed(
    tx: PgTx,
    params: { id: string; error: Error }
  ): Promise<void> {
    await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'failed',
              last_error = $1
        WHERE id = $2`,
      [params.error.message, params.id]
    );
  }

  /**
   * Ops: requeue a `failed` row back to `pending` after the operator has
   * fixed the downstream issue. Resets `attempts` to 0 so the row gets a
   * full retry budget. Returns true if the row was found and requeued,
   * false if it didn't exist or wasn't in `failed` state.
   */
  async requeue(tx: PgTx, params: { id: string }): Promise<boolean> {
    const res = await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'pending',
              attempts = 0,
              claimed_at = NULL,
              next_attempt_at = NULL,
              last_error = NULL
        WHERE id = $1 AND status = 'failed'`,
      [params.id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async pendingCount(tx: PgTx): Promise<number> {
    const res = await tx.client.query(
      `SELECT COUNT(*)::int AS n FROM ${this.tableName} WHERE status = 'pending'`
    );
    return res.rows[0]?.n ?? 0;
  }

  /**
   * Retention: deletes `failed` rows older than `olderThan`. Successful
   * dispatches are already ack-deleted; only `failed` rows persist. Run
   * from a cron after the operator has had time to triage them. Returns
   * the number of rows deleted.
   */
  async cleanupFailed(
    tx: PgTx,
    params: { olderThan: Date; tenantId?: string }
  ): Promise<number> {
    if (params.tenantId !== undefined) {
      const res = await tx.client.query(
        `DELETE FROM ${this.tableName}
          WHERE status = 'failed'
            AND enqueued_at < $1::timestamptz
            AND tenant_id = $2`,
        [params.olderThan.toISOString(), params.tenantId]
      );
      return res.rowCount ?? 0;
    }
    const res = await tx.client.query(
      `DELETE FROM ${this.tableName}
        WHERE status = 'failed'
          AND enqueued_at < $1::timestamptz`,
      [params.olderThan.toISOString()]
    );
    return res.rowCount ?? 0;
  }

  /**
   * Watchdog: flips `claimed` rows whose `claimed_at` is older than
   * `olderThan` back to `pending`. These rows are leaks from dispatcher
   * workers that crashed between `claimBatch` and `ack`/`releaseWithError`.
   * The next dispatcher round will re-claim them.
   *
   * Attempts is not bumped — it was already bumped by the original
   * `claimBatch` call, so the dispatcher's max-attempts policy still
   * applies. `last_error` is stamped so ops can see the recovery path
   * was taken. Returns the number of rows reset.
   *
   * Choose `olderThan` larger than your dispatcher's slowest dispatch
   * time. A 5-minute window matches the default for command idempotency.
   */
  async resetStaleClaimed(
    tx: PgTx,
    params: { olderThan: Date; tenantId?: string; reason?: string }
  ): Promise<number> {
    const reason = params.reason ?? "watchdog: stale claimed";
    if (params.tenantId !== undefined) {
      const res = await tx.client.query(
        `UPDATE ${this.tableName}
            SET status = 'pending',
                claimed_at = NULL,
                last_error = COALESCE(last_error, $1)
          WHERE status = 'claimed'
            AND claimed_at < $2::timestamptz
            AND tenant_id = $3`,
        [reason, params.olderThan.toISOString(), params.tenantId]
      );
      return res.rowCount ?? 0;
    }
    const res = await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'pending',
              claimed_at = NULL,
              last_error = COALESCE(last_error, $1)
        WHERE status = 'claimed'
          AND claimed_at < $2::timestamptz`,
      [reason, params.olderThan.toISOString()]
    );
    return res.rowCount ?? 0;
  }
}
