import type { PgTx } from "@eventfabric/postgres";
import type { ClaimResult, IdempotencyStore } from "@eventfabric/mediator";

export interface PgIdempotencyStoreOptions {
  /** Schema-qualified table name. Default: "eventfabric.command_idempotency". */
  readonly tableName?: string;
}

/**
 * Postgres-backed idempotency store. The slot lifetime is bound to the
 * caller's transaction:
 *
 *   - `claim` INSERTs the slot row inside the bus's open transaction with
 *     `ON CONFLICT DO NOTHING`. If it inserts, the slot is claimed; if it
 *     conflicts, the SELECT that follows reports the existing row's state.
 *   - `complete` UPDATEs the row to `status='completed'` with the JSON-
 *     serialized handler result, in the same transaction.
 *   - `release` is a no-op: when the handler throws, the bus's transaction
 *     rolls back, which removes the row implicitly.
 *
 * Concurrency: Postgres serializes conflicting INSERTs on the unique
 * constraint, so a second worker attempting the same key blocks on the
 * first worker's transaction rather than seeing `in_flight`. This is by
 * design — it gives us free queue-up semantics without polling. The
 * trade-off is connection holding under contention; for long-running
 * handlers, callers should split work across smaller commands.
 */
export class PgIdempotencyStore implements IdempotencyStore<PgTx> {
  private readonly tableName: string;

  constructor(opts?: PgIdempotencyStoreOptions) {
    this.tableName = opts?.tableName ?? "eventfabric.command_idempotency";
  }

  async claim(
    tx: PgTx,
    params: { key: string; commandType: string; commandId: string; tenantId?: string }
  ): Promise<ClaimResult> {
    const tenantId = params.tenantId ?? tx.tenantId;
    // Single-statement claim that also recovers from 'failed' rows the
    // watchdog left behind: ON CONFLICT DO UPDATE WHERE status='failed'
    // re-claims a stale terminal slot atomically. INSERT path returns the
    // row; UPDATE path also returns when its WHERE matches; both mean
    // we now own the slot. If the existing row is 'in_flight' or
    // 'completed' the WHERE excludes the UPDATE and 0 rows return — we
    // then SELECT to distinguish the two.
    const claimed = await tx.client.query(
      `INSERT INTO ${this.tableName}
         (tenant_id, idempotency_key, command_type, command_id, status)
       VALUES ($1, $2, $3, $4, 'in_flight')
       ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
         SET command_type = EXCLUDED.command_type,
             command_id = EXCLUDED.command_id,
             status = 'in_flight',
             result = NULL,
             error_message = NULL,
             created_at = NOW(),
             completed_at = NULL
         WHERE ${this.tableName}.status = 'failed'
       RETURNING idempotency_key`,
      [tenantId, params.key, params.commandType, params.commandId]
    );

    if (claimed.rowCount && claimed.rowCount > 0) {
      return { state: "claimed" };
    }

    const existing = await tx.client.query(
      `SELECT status, result FROM ${this.tableName}
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, params.key]
    );

    if (existing.rowCount === 0) {
      // The row vanished between our failed INSERT and this SELECT — the
      // other transaction must have rolled back. Try the INSERT again.
      const retry = await tx.client.query(
        `INSERT INTO ${this.tableName}
           (tenant_id, idempotency_key, command_type, command_id, status)
         VALUES ($1, $2, $3, $4, 'in_flight')
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [tenantId, params.key, params.commandType, params.commandId]
      );
      if (retry.rowCount && retry.rowCount > 0) {
        return { state: "claimed" };
      }
      // Another worker beat us in the race — fall through to in_flight.
      return { state: "in_flight" };
    }

    const row = existing.rows[0] as { status: string; result: unknown };
    if (row.status === "completed") {
      return { state: "completed", result: row.result };
    }
    return { state: "in_flight" };
  }

  async complete(
    tx: PgTx,
    params: { key: string; tenantId?: string; result: unknown }
  ): Promise<void> {
    const tenantId = params.tenantId ?? tx.tenantId;
    await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'completed',
              result = $1::jsonb,
              completed_at = NOW()
        WHERE tenant_id = $2 AND idempotency_key = $3`,
      [JSON.stringify(params.result ?? null), tenantId, params.key]
    );
  }

  async release(_tx: PgTx, _params: { key: string; tenantId?: string; error: Error }): Promise<void> {
    // No-op: when the handler throws, the bus's transaction rolls back,
    // which removes the in_flight row implicitly. Keeping this as a
    // method (rather than removing it from the interface) lets the in-
    // memory and PG stores share a single contract.
  }

  /**
   * Prunes idempotency rows older than `olderThan`. Call from a cron job
   * or pg_cron — the framework does not start a daemon for this. Returns
   * the number of rows deleted.
   */
  async cleanup(tx: PgTx, params: { olderThan: Date }): Promise<number> {
    const res = await tx.client.query(
      `DELETE FROM ${this.tableName}
        WHERE created_at < $1::timestamptz`,
      [params.olderThan.toISOString()]
    );
    return res.rowCount ?? 0;
  }

  /**
   * Watchdog: flips `in_flight` rows whose `created_at` is older than
   * `olderThan` to `failed`. These rows are leaks from worker processes
   * that crashed mid-handler — their bus transaction never rolled the
   * slot back, so future retries with the same key would otherwise see
   * `in_flight` forever.
   *
   * After a row is flipped to `failed`, the next `claim` for the same
   * key recovers it atomically (see the `ON CONFLICT DO UPDATE WHERE
   * status='failed'` branch above) — clients can retry transparently.
   *
   * Run from the same cron that calls `cleanup`. Choose `olderThan`
   * larger than your slowest legitimate handler runtime; a 5-minute
   * window is the documented default. Returns the number of rows reset.
   */
  async resetStaleInFlight(
    tx: PgTx,
    params: { olderThan: Date; tenantId?: string; reason?: string }
  ): Promise<number> {
    const reason = params.reason ?? "watchdog: stale in_flight";
    if (params.tenantId !== undefined) {
      const res = await tx.client.query(
        `UPDATE ${this.tableName}
            SET status = 'failed',
                error_message = COALESCE(error_message, $1),
                completed_at = NOW()
          WHERE status = 'in_flight'
            AND created_at < $2::timestamptz
            AND tenant_id = $3`,
        [reason, params.olderThan.toISOString(), params.tenantId]
      );
      return res.rowCount ?? 0;
    }
    const res = await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'failed',
              error_message = COALESCE(error_message, $1),
              completed_at = NOW()
        WHERE status = 'in_flight'
          AND created_at < $2::timestamptz`,
      [reason, params.olderThan.toISOString()]
    );
    return res.rowCount ?? 0;
  }
}
