import type { Meter } from "@opentelemetry/api";

export type SagaRetentionMetricsOptions = {
  meter: Meter;
  /** Prefix applied to the emitted counter name. Default: "eventfabric.saga". */
  metricPrefix?: string;
};

/** Logical table key used for the retention counter label. */
export type SagaRetentionTable =
  | "instances"
  | "pending_commands"
  | "scheduled_messages";

/**
 * Records how many rows each saga retention sweep removed. Three tables
 * are bounded by retention:
 *
 *  - `saga_instances` (via `PgSagaStateStore.cleanupTerminal`)
 *  - `saga_pending_commands` (via `PgSagaCommandQueue.cleanupFailed`)
 *  - `saga_scheduled_messages` (via `PgSagaTimerStore.cleanupTerminal`)
 *
 * Without this counter, a misconfigured cron silently lets the tables
 * grow forever.
 */
export type SagaRetentionMetrics = {
  /**
   * Record one cleanup outcome against the given logical table. Call
   * AFTER each `cleanup*` invocation in your cron, with the row count
   * it returned.
   */
  recordCleanup(
    table: SagaRetentionTable,
    rowsDeleted: number,
    attrs?: { tenantId?: string }
  ): void;
};

/**
 * Registers a counter named `${metricPrefix}.retention_rows_total` with
 * a `table` label distinguishing the three retention sweeps. Use this
 * alongside the cleanup helpers in `@eventfabric/sagas-postgres`.
 *
 * ```ts
 * const metrics = createSagaRetentionMetrics({ meter });
 * await uow.withTransaction(async (tx) => {
 *   metrics.recordCleanup(
 *     "instances",
 *     await new PgSagaStateStore().cleanupTerminal(tx, { olderThan }),
 *   );
 *   metrics.recordCleanup(
 *     "pending_commands",
 *     await new PgSagaCommandQueue().cleanupFailed(tx, { olderThan }),
 *   );
 *   metrics.recordCleanup(
 *     "scheduled_messages",
 *     await new PgSagaTimerStore().cleanupTerminal(tx, { olderThan }),
 *   );
 * });
 * ```
 */
export function createSagaRetentionMetrics(
  opts: SagaRetentionMetricsOptions
): SagaRetentionMetrics {
  const prefix = opts.metricPrefix ?? "eventfabric.saga";
  const counter = opts.meter.createCounter(
    `${prefix}.retention_rows_total`,
    {
      description:
        "Rows deleted by saga retention cleanup jobs, broken down by table",
    }
  );
  return {
    recordCleanup(table, rowsDeleted, attrs) {
      counter.add(rowsDeleted, {
        table,
        tenant_id: attrs?.tenantId ?? "all",
      });
    },
  };
}
