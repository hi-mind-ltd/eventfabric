import type { Pool } from "pg";
import type { AnyEvent, CatchUpProjection, ProjectionDaemonOptions } from "@eventfabric/core";
import { ProjectionDaemon } from "@eventfabric/core";
import { PgUnitOfWork } from "../unitofwork/pg-unit-of-work";
import { PgEventStore } from "../pg-event-store";
import { PgProjectionCheckpointStore } from "./pg-projection-checkpoint-store";
import { PgProjectionDeadLetterStore } from "./pg-projection-dead-letter-store";
import { PgHighWaterMark, type PgHighWaterMarkOptions } from "./pg-high-water-mark";
import type { PgTx } from "../unitofwork/pg-transaction";

export type PgProjectionDaemonOptions = ProjectionDaemonOptions & {
  highWaterMark?: Omit<PgHighWaterMarkOptions, "eventsTable">;
};

/**
 * Factory for a PostgreSQL-backed projection daemon: runs `projections`
 * continuously against the event log, with checkpoints per (projection,
 * tenant), a high water mark against late commits, per-batch checkpoint
 * claims so several instances can run side by side, retries with backoff
 * and a dead-letter table for events that keep failing.
 *
 * @example
 * const daemon = createProjectionDaemon(pool, eventStore, [accountSummary, emailNotifier]);
 * const ac = new AbortController();
 * process.on("SIGTERM", () => ac.abort());
 * await daemon.start(ac.signal);
 */
export function createProjectionDaemon<E extends AnyEvent>(
  pool: Pool,
  eventStore: PgEventStore<E>,
  projections: CatchUpProjection<E, PgTx>[],
  opts: PgProjectionDaemonOptions = {}
): ProjectionDaemon<E, PgTx> {
  const { highWaterMark, ...daemonOpts } = opts;
  return new ProjectionDaemon(
    new PgUnitOfWork(pool),
    eventStore,
    new PgProjectionCheckpointStore(),
    new PgHighWaterMark(pool, { ...highWaterMark, eventsTable: eventStore.eventsTableName }),
    new PgProjectionDeadLetterStore(),
    projections,
    daemonOpts
  );
}
