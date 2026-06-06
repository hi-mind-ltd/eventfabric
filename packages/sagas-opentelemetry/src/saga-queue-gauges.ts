import type { Meter } from "@opentelemetry/api";

export type SagaQueueGaugeOptions = {
  meter: Meter;
  /** Prefix applied to all emitted metric names. Default: "eventfabric.saga". */
  metricPrefix?: string;
  /**
   * Returns the wall-clock seconds since the oldest still-pending row in
   * `saga_pending_commands` was enqueued. `0` means no rows (or the queue
   * is fully drained). Implementations typically run:
   *
   * ```sql
   * SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(enqueued_at))), 0)
   *   FROM eventfabric.saga_pending_commands
   *  WHERE status = 'pending'
   * ```
   *
   * The callback is invoked at every metric collection cycle. Keep it
   * fast — it should be a single indexed SELECT.
   */
  pendingCommandsLagSeconds: () => Promise<number>;
  /**
   * Returns the count of rows in `saga_scheduled_messages` whose
   * `fire_at <= NOW()` and `status = 'pending'` — timers that should
   * have fired by now but haven't. Persistent non-zero values indicate
   * the scheduler is down or starved. This is the alert metric.
   */
  overdueScheduledMessagesCount: () => Promise<number>;
};

/**
 * Registers two observable gauges describing the health of the saga
 * persistence layer:
 *
 *  - `eventfabric.saga.pending_commands_lag_seconds` — age of the
 *    oldest unread row in the saga command queue. Sustained growth
 *    means the dispatcher can't keep up.
 *
 *  - `eventfabric.saga.scheduled_messages_overdue_count` — number of
 *    timers past their fire time. Should trend to zero on a healthy
 *    scheduler. Persistent non-zero values are the alert.
 *
 * The functions you pass run on every metric export — a few times per
 * minute by default. They should be small indexed SELECTs against the
 * saga tables. Errors thrown inside them are swallowed; the gauge
 * simply reports nothing for that cycle.
 *
 * Example wiring with `@eventfabric/postgres`:
 *
 * ```ts
 * import { Pool } from "pg";
 * import { createSagaQueueGauges } from "@eventfabric/sagas/opentelemetry";
 *
 * const pool = new Pool({ ... });
 * createSagaQueueGauges({
 *   meter,
 *   pendingCommandsLagSeconds: async () => {
 *     const r = await pool.query(
 *       `SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(enqueued_at))), 0)::float8 AS v
 *          FROM eventfabric.saga_pending_commands
 *         WHERE status = 'pending'`
 *     );
 *     return r.rows[0]?.v ?? 0;
 *   },
 *   overdueScheduledMessagesCount: async () => {
 *     const r = await pool.query(
 *       `SELECT COUNT(*)::int AS n
 *          FROM eventfabric.saga_scheduled_messages
 *         WHERE status = 'pending' AND fire_at <= NOW()`
 *     );
 *     return r.rows[0]?.n ?? 0;
 *   },
 * });
 * ```
 */
export function createSagaQueueGauges(opts: SagaQueueGaugeOptions): void {
  const prefix = opts.metricPrefix ?? "eventfabric.saga";

  const lagGauge = opts.meter.createObservableGauge(
    `${prefix}.pending_commands_lag_seconds`,
    {
      description: "Age in seconds of the oldest pending row in saga_pending_commands",
      unit: "s",
    }
  );
  lagGauge.addCallback(async (result) => {
    try {
      const v = await opts.pendingCommandsLagSeconds();
      result.observe(v);
    } catch {
      // Skip this collection cycle on query failure.
    }
  });

  const overdueGauge = opts.meter.createObservableGauge(
    `${prefix}.scheduled_messages_overdue_count`,
    {
      description: "Count of pending timers whose fire_at is in the past — alert when persistent",
    }
  );
  overdueGauge.addCallback(async (result) => {
    try {
      const v = await opts.overdueScheduledMessagesCount();
      result.observe(v);
    } catch {
      // Skip this collection cycle on query failure.
    }
  });
}
