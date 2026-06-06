import type { PgTx } from "@eventfabric/postgres";
import type {
  TimerMessage,
  SagaTimerStore,
  SagaTimerStoreItem,
} from "@eventfabric/sagas";

export interface PgSagaTimerStoreOptions {
  /** Schema-qualified table name. Default: "eventfabric.saga_scheduled_messages". */
  readonly tableName?: string;
}

interface ClaimRow {
  tenant_id: string;
  saga_name: string;
  instance_id: string;
  id: string;
  fire_at: Date;
  message: TimerMessage;
}

/**
 * Postgres-backed timer store. The saga runner schedules timers in the
 * same transaction as the saga's state advance — atomic by construction.
 *
 * The scheduler worker (SagaTimerScheduler) polls due timers using
 * FOR UPDATE SKIP LOCKED and marks them claimed. Cancelled rows are kept
 * for ops visibility and pruned by a separate cleanup job.
 *
 * `schedule` uses ON CONFLICT to replace any existing pending row with
 * the same key — re-scheduling is the documented way to update fireAt
 * or payload for a timer id that the saga previously scheduled.
 */
export class PgSagaTimerStore implements SagaTimerStore<PgTx> {
  private readonly tableName: string;

  constructor(opts?: PgSagaTimerStoreOptions) {
    this.tableName = opts?.tableName ?? "eventfabric.saga_scheduled_messages";
  }

  async schedule(
    tx: PgTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
      fireAt: Date;
      message: TimerMessage;
    }
  ): Promise<void> {
    await tx.client.query(
      `INSERT INTO ${this.tableName}
         (tenant_id, saga_name, instance_id, id, fire_at, message, status)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb, 'pending')
       ON CONFLICT (tenant_id, saga_name, instance_id, id)
       DO UPDATE SET
         fire_at = EXCLUDED.fire_at,
         message = EXCLUDED.message,
         status = 'pending',
         scheduled_at = NOW(),
         claimed_at = NULL`,
      [
        params.tenantId,
        params.sagaName,
        params.instanceId,
        params.id,
        params.fireAt.toISOString(),
        JSON.stringify(params.message),
      ]
    );
  }

  async cancel(
    tx: PgTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      ids: readonly string[];
    }
  ): Promise<number> {
    if (params.ids.length === 0) return 0;
    const res = await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'cancelled'
        WHERE tenant_id = $1
          AND saga_name = $2
          AND instance_id = $3
          AND id = ANY($4::text[])
          AND status IN ('pending', 'claimed')`,
      [params.tenantId, params.sagaName, params.instanceId, [...params.ids]]
    );
    return res.rowCount ?? 0;
  }

  async claimDue(
    tx: PgTx,
    params: { now: Date; batchSize: number }
  ): Promise<SagaTimerStoreItem[]> {
    const res = await tx.client.query(
      `WITH claimed AS (
         SELECT tenant_id, saga_name, instance_id, id
           FROM ${this.tableName}
          WHERE status = 'pending' AND fire_at <= $1::timestamptz
          ORDER BY fire_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE ${this.tableName} t
          SET status = 'claimed', claimed_at = NOW()
         FROM claimed c
        WHERE t.tenant_id = c.tenant_id
          AND t.saga_name = c.saga_name
          AND t.instance_id = c.instance_id
          AND t.id = c.id
       RETURNING t.tenant_id, t.saga_name, t.instance_id, t.id, t.fire_at, t.message`,
      [params.now.toISOString(), params.batchSize]
    );
    return res.rows.map((r: ClaimRow) => ({
      tenantId: r.tenant_id,
      sagaName: r.saga_name,
      instanceId: r.instance_id,
      id: r.id,
      fireAt: new Date(r.fire_at),
      message: r.message,
    }));
  }

  async markFired(
    tx: PgTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
    }
  ): Promise<void> {
    await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'fired'
        WHERE tenant_id = $1 AND saga_name = $2 AND instance_id = $3 AND id = $4`,
      [params.tenantId, params.sagaName, params.instanceId, params.id]
    );
  }

  /**
   * Mark a claimed timer as `failed` (visible to ops, not re-claimed).
   * Used by the scheduler when it claims a row whose saga has no
   * registered handler — see `SagaTimerScheduler.onOrphanedTimer = "fail"`.
   */
  async markFailed(
    tx: PgTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
      error: Error;
    }
  ): Promise<void> {
    await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'failed',
              last_error = $5
        WHERE tenant_id = $1 AND saga_name = $2 AND instance_id = $3 AND id = $4`,
      [
        params.tenantId,
        params.sagaName,
        params.instanceId,
        params.id,
        params.error.message,
      ]
    );
  }

  /**
   * Release a claimed row back to pending — used by the scheduler when
   * delivery to the saga fails (e.g. concurrent state advance). The
   * fire_at remains the original; the next claim picks it up immediately.
   */
  async release(
    tx: PgTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
    }
  ): Promise<void> {
    await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'pending', claimed_at = NULL
        WHERE tenant_id = $1 AND saga_name = $2 AND instance_id = $3 AND id = $4
          AND status = 'claimed'`,
      [params.tenantId, params.sagaName, params.instanceId, params.id]
    );
  }

  /**
   * Retention: deletes terminal timer rows (status `fired` or
   * `cancelled`) older than `olderThan`. Pending and claimed rows are
   * never touched. Use this from a cron to keep the table bounded —
   * a saga that schedules 1k timers per instance over months will
   * otherwise accumulate millions of fired rows.
   *
   * `statuses` defaults to `["fired"]` only — `cancelled` rows are kept
   * around for "why didn't this timer fire?" triage. Pass
   * `["fired", "cancelled"]` to prune both, or `["cancelled"]` to only
   * prune cancellations. Returns the number of rows deleted.
   */
  async cleanupTerminal(
    tx: PgTx,
    params: {
      olderThan: Date;
      tenantId?: string;
      statuses?: readonly ("fired" | "cancelled")[];
    }
  ): Promise<number> {
    const statuses = params.statuses ?? ["fired"];
    if (statuses.length === 0) return 0;
    if (params.tenantId !== undefined) {
      const res = await tx.client.query(
        `DELETE FROM ${this.tableName}
          WHERE status = ANY($1::text[])
            AND scheduled_at < $2::timestamptz
            AND tenant_id = $3`,
        [[...statuses], params.olderThan.toISOString(), params.tenantId]
      );
      return res.rowCount ?? 0;
    }
    const res = await tx.client.query(
      `DELETE FROM ${this.tableName}
        WHERE status = ANY($1::text[])
          AND scheduled_at < $2::timestamptz`,
      [[...statuses], params.olderThan.toISOString()]
    );
    return res.rowCount ?? 0;
  }

  /**
   * Watchdog: flips `claimed` rows whose `claimed_at` is older than
   * `olderThan` back to `pending`. These rows are leaks from scheduler
   * workers that crashed between `claimDue` and `markFired` / `release`.
   * The next scheduler round will re-claim them; `fire_at` is unchanged
   * so they fire as soon as a worker picks them up.
   *
   * Choose `olderThan` larger than your scheduler's slowest delivery
   * time. A 5-minute window matches the default for the command queue.
   * Returns the number of rows reset.
   */
  async resetStaleClaimed(
    tx: PgTx,
    params: { olderThan: Date; tenantId?: string }
  ): Promise<number> {
    if (params.tenantId !== undefined) {
      const res = await tx.client.query(
        `UPDATE ${this.tableName}
            SET status = 'pending', claimed_at = NULL
          WHERE status = 'claimed'
            AND claimed_at < $1::timestamptz
            AND tenant_id = $2`,
        [params.olderThan.toISOString(), params.tenantId]
      );
      return res.rowCount ?? 0;
    }
    const res = await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'pending', claimed_at = NULL
        WHERE status = 'claimed'
          AND claimed_at < $1::timestamptz`,
      [params.olderThan.toISOString()]
    );
    return res.rowCount ?? 0;
  }
}
