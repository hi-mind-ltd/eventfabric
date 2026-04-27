export * from './types';
export * from './aggregates/aggregate-root';
export * from './repository';
export * from './events/event-helpers';

// Outbox interfaces
export * from './outbox/outbox-store';
export * from './outbox/dlq-service';

// Snapshot interfaces
export * from './snapshots/snapshot';
export * from './snapshots/snapshot-policy';
export * from './snapshots/snapshot-store';

// Projection interfaces
export * from './projections/inline-projection';
export * from './projections/async-projection';
export * from './projections/catch-up-projection';
export * from './projections/projection-checkpoint-store';
export * from './projections/topic-filter';
export * from './projections/async-processor-config';

// Projection runners (core orchestration logic)
export * from './projections/async-projection-runner';
export * from './projections/catch-up-projector';
export * from './projections/inline-projector';

// Projection builders / ergonomic helpers
export * from './projections/for-event-type';

// Observability hooks (vendor-neutral — adapters live in @eventfabric/opentelemetry etc.)
export * from './projections/async-runner-observer';
export * from './projections/catch-up-observer';

// Query builder interface (database-agnostic — adapters implement for their target)
export * from './query/query-builder';

// Resilience utilities
export * from './resilience/backoff';
export * from './resilience/with-concurrency-retry';
