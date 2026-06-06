import type { Meter } from "@opentelemetry/api";

export type CommandIdempotencyGaugeOptions = {
  meter: Meter;
  /** Prefix applied to all emitted metric names. Default: "eventfabric.command". */
  metricPrefix?: string;
  /**
   * Returns the count of rows in `eventfabric.command_idempotency` with
   * `status = 'in_flight'`. Implementations typically run:
   *
   * ```sql
   * SELECT COUNT(*)::int FROM eventfabric.command_idempotency
   *  WHERE status = 'in_flight'
   * ```
   *
   * Persistent non-zero values may indicate worker crashes (slots are
   * being claimed but never completed). The `resetStaleInFlight`
   * watchdog from `@eventfabric/mediator-postgres` is the corrective
   * action; this gauge tells you whether it needs to fire.
   */
  inFlightCount: () => Promise<number>;
  /**
   * Returns the wall-clock seconds since the oldest `in_flight` row was
   * claimed. `0` if no in_flight rows exist. Implementations typically
   * run:
   *
   * ```sql
   * SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)
   *   FROM eventfabric.command_idempotency
   *  WHERE status = 'in_flight'
   * ```
   *
   * Sustained growth past your handler-runtime SLO is the alert:
   * something is holding a slot far longer than any legitimate command
   * should take.
   */
  oldestInFlightSeconds: () => Promise<number>;
};

/**
 * Registers two observable gauges describing the health of the command
 * idempotency table:
 *
 *  - `eventfabric.command.idempotency_in_flight_count` — number of
 *    rows currently in the `in_flight` state. Should normally hover
 *    near the in-flight command concurrency you expect.
 *
 *  - `eventfabric.command.idempotency_oldest_in_flight_seconds` — age
 *    of the oldest in_flight row. Sustained growth means worker
 *    crashes have leaked slots; run `PgIdempotencyStore.resetStaleInFlight`
 *    on a schedule (see operational runbook).
 *
 * The functions you pass run on every metric export — a few times per
 * minute by default. They should be small indexed SELECTs against the
 * idempotency table. Errors thrown inside them are swallowed; the gauge
 * simply reports nothing for that cycle.
 *
 * Example wiring with `@eventfabric/mediator-postgres`:
 *
 * ```ts
 * import { Pool } from "pg";
 * import { createCommandIdempotencyGauges } from "@eventfabric/mediator-opentelemetry";
 *
 * const pool = new Pool({ ... });
 * createCommandIdempotencyGauges({
 *   meter,
 *   inFlightCount: async () => {
 *     const r = await pool.query(
 *       `SELECT COUNT(*)::int AS n FROM eventfabric.command_idempotency
 *         WHERE status = 'in_flight'`
 *     );
 *     return r.rows[0]?.n ?? 0;
 *   },
 *   oldestInFlightSeconds: async () => {
 *     const r = await pool.query(
 *       `SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::float8 AS v
 *          FROM eventfabric.command_idempotency
 *         WHERE status = 'in_flight'`
 *     );
 *     return r.rows[0]?.v ?? 0;
 *   },
 * });
 * ```
 */
export function createCommandIdempotencyGauges(opts: CommandIdempotencyGaugeOptions): void {
  const prefix = opts.metricPrefix ?? "eventfabric.command";

  const inFlightGauge = opts.meter.createObservableGauge(
    `${prefix}.idempotency_in_flight_count`,
    {
      description: "Number of rows in eventfabric.command_idempotency with status = 'in_flight'",
    }
  );
  inFlightGauge.addCallback(async (result) => {
    try {
      const v = await opts.inFlightCount();
      result.observe(v);
    } catch {
      // Skip this collection cycle on query failure.
    }
  });

  const oldestGauge = opts.meter.createObservableGauge(
    `${prefix}.idempotency_oldest_in_flight_seconds`,
    {
      description: "Age in seconds of the oldest in_flight row in eventfabric.command_idempotency",
      unit: "s",
    }
  );
  oldestGauge.addCallback(async (result) => {
    try {
      const v = await opts.oldestInFlightSeconds();
      result.observe(v);
    } catch {
      // Skip this collection cycle on query failure.
    }
  });
}
