import type { Meter } from "@opentelemetry/api";

export type CommandRetentionMetricsOptions = {
  meter: Meter;
  /** Prefix applied to the emitted counter name. Default: "eventfabric.command". */
  metricPrefix?: string;
};

/**
 * A counter that records how many idempotency rows the retention sweep
 * deleted. Without this, retention failures are silent — the table just
 * grows.
 */
export type CommandRetentionMetrics = {
  /**
   * Record one cleanup outcome. Call AFTER your cron has invoked
   * `PgIdempotencyStore.cleanup(tx, { olderThan })` and got the row count.
   *
   * `reason` distinguishes routine retention from watchdog-driven
   * recovery so you can chart them separately.
   */
  recordCleanup(
    rowsDeleted: number,
    attrs?: { tenantId?: string; reason?: "retention" | "watchdog" }
  ): void;
};

/**
 * Registers a counter named
 * `${metricPrefix}.idempotency_cleanup_rows_total` describing how many
 * rows the retention sweep removed. Call `recordCleanup(n)` after every
 * `cleanup(...)` invocation in your cron job. The counter has labels
 * `tenant_id` (default `"all"`) and `reason` (default `"retention"`).
 *
 * Example:
 *
 * ```ts
 * const metrics = createCommandRetentionMetrics({ meter });
 * const deleted = await uow.withTransaction((tx) =>
 *   store.cleanup(tx, { olderThan }),
 * );
 * metrics.recordCleanup(deleted);
 * ```
 */
export function createCommandRetentionMetrics(
  opts: CommandRetentionMetricsOptions
): CommandRetentionMetrics {
  const prefix = opts.metricPrefix ?? "eventfabric.command";
  const counter = opts.meter.createCounter(
    `${prefix}.idempotency_cleanup_rows_total`,
    {
      description: "Rows deleted by PgIdempotencyStore.cleanup retention sweeps",
    }
  );
  return {
    recordCleanup(rowsDeleted, attrs) {
      counter.add(rowsDeleted, {
        tenant_id: attrs?.tenantId ?? "all",
        reason: attrs?.reason ?? "retention",
      });
    },
  };
}
