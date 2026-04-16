export type { PgTx } from "./unitofwork/pg-transaction";

export { PgEventStore, ConcurrencyError, RowShapeError } from "./pg-event-store";
export { PgSnapshotStore } from "./snapshots/pg-snapshot-store";

export { PgProjectionCheckpointStore } from "./projections/pg-projection-checkpoint-store";
export { PgCatchUpProjector, createCatchUpProjector } from "./projections/pg-catch-up-projector";

export { PgOutboxStore } from "./outbox/pg-outbox-store";
export { PgAsyncProjectionRunner, createAsyncProjectionRunner } from "./projections/pg-async-projection-runner";

export { PgDlqService } from "./outbox/pg-dlq-service";
export { PgOutboxStatsService } from "./outbox/pg-outbox-stats";

export { Session, SessionFactory } from "./session";
export type { SnapshotPolicy } from "./session";
export { InlineProjector } from "@eventfabric/core";

// Query builder (Pg implementation of core's QueryBuilder interface)
export { PgQueryBuilder, query } from "./query/pg-query-builder";
export type { PgQueryOptions } from "./query/pg-query-builder";

// Partitioning
export { PgPartitionManager } from "./partitioning/pg-partition-manager";
export type { PartitionInfo } from "./partitioning/pg-partition-manager";

// Migrator
export { migrate } from "./pg-migrator";
export type { MigrateOptions, MigrateResult, MigrateObserver } from "./pg-migrator";
