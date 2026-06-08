export type { PgTx } from "./unitofwork/pg-transaction";
export { PgUnitOfWork } from "./unitofwork/pg-unit-of-work";

export { PgEventStore, ConcurrencyError, RowShapeError } from "./pg-event-store";
export type { PgEventStoreOptions } from "./pg-event-store";
// Re-exported from core for convenience (the tamper-evidence contract + result
// type live in @eventfabric/core; PgEventStore implements TamperEvidentEventStore).
export type { ChainVerificationResult, TamperEvidentEventStore } from "@eventfabric/core";
export { PgChainAnchorSealer, PgChainAnchorRunner } from "./chain-anchor-sealer";
export type {
  PgChainAnchorSealerOptions,
  SealResult,
  AnchorVerificationResult,
  AnchorFailureKind,
  ChainAnchorRunnerOptions,
} from "./chain-anchor-sealer";
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
export type { MigrateOptions, MigrateResult, MigrateObserver, MigrationSet } from "./pg-migrator";

// Tenancy
export type { TenantResolver } from "./tenancy/tenant-resolver";
export { ConjoinedTenantResolver, PerDatabaseTenantResolver } from "./tenancy/tenant-resolver";
