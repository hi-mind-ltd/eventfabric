# @eventfabric/sagas

## 0.4.0

### Minor Changes

- 015b888: feat(sagas): run sagas on the projection daemon; dead-letter replays are no longer skipped

  - New `sagaAsProjection(saga, stores)` wraps a saga for the `ProjectionDaemon`. Events reach each saga in `global_position` order, never past the high water mark, so the `lastEventPos` duplicate check is correct. Several daemon instances can run side by side. A concurrent state advance throws `ConcurrencyError` and is retried. Events that keep failing are dead-lettered. This is the equivalent of feeding a Wolverine saga from a Marten event subscription.
  - `CatchUpProjection.handle` receives an optional third argument, `ProjectionHandleContext` (`{ replay: boolean }`). `ProjectionDaemon.replayDeadLetter` passes `replay: true`.
  - `applySagaTransition` accepts `{ replay: true }` to bypass the `globalPosition <= lastEventPos` check. Without it, replaying a dead-lettered saga event was a silent no-op. `lastEventPos` never moves backwards now.
  - `sagaAsAsyncProjection` (outbox runner) is documented as unsafe for sagas whose events can be produced concurrently. The outbox does not deliver in position order, so an event that commits after a later one for the same instance is skipped as "already applied".

### Patch Changes

- Updated dependencies [015b888]
- Updated dependencies [015b888]
- Updated dependencies [015b888]
- Updated dependencies [015b888]
- Updated dependencies [015b888]
- Updated dependencies [015b888]
- Updated dependencies [015b888]
  - @eventfabric/core@0.4.0
  - @eventfabric/mediator@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [073ced2]
  - @eventfabric/core@0.3.0
  - @eventfabric/mediator@0.3.0

## 0.2.0

### Minor Changes

- b8b08cc: Initial beta release.

  Six new packages introducing the mediator (command pipeline) and saga primitive:

  - **`@eventfabric/mediator`** — abstract `Command` envelope, `CommandBus`, idempotency middleware framework, built-in `createLoggingMiddleware`, in-memory `IdempotencyStore`. Tenant safety: `tenantValidator` hook + `requireTenantId` flag run before any transaction opens. In-flight conflict waiting happens OUTSIDE the bus transaction so connections + row locks are released during the poll. Backend-agnostic — pair with `@eventfabric/mediator-postgres` for PG-backed idempotency and `@eventfabric/mediator-opentelemetry` for tracing + metrics. Roadmap: queries and notifications.
  - **`@eventfabric/mediator-postgres`** — Postgres-backed `PgIdempotencyStore` with claim-recovery from `failed` rows, `resetStaleInFlight` watchdog, `cleanup` retention method, migration `010_command_idempotency`.
  - **`@eventfabric/mediator-opentelemetry`** — `createCommandBusObserver` middleware (tracing span per command + sent/duration metrics labelled by command type and result), `createCommandIdempotencyGauges` (observable gauges for `in_flight` count and oldest-`in_flight` age — the watchdog alert), and `createCommandRetentionMetrics` (counter for retention sweep row counts).
  - **`@eventfabric/sagas`** — `Saga<S, E>` interface (pure reducer over events + timers), optional `SagaStateUpcaster` for schema evolution, `applySagaTransition` runner, `sagaAsAsyncProjection` adapter, `SagaCommandDispatcher` (with exponential `retryBackoffMs` and bounded `gracefulShutdownMs`), `SagaTimerScheduler` (with safe-by-default `onOrphanedTimer: "fail"` policy), in-memory stores, vendor-neutral observer hooks. Sagas emit commands via `@eventfabric/mediator` — emitted commands always inherit the saga's tenant (authors cannot pivot tenants) and carry `causationId` from the triggering event.
  - **`@eventfabric/sagas-postgres`** — `PgSagaStateStore` (optimistic CAS on `state_version`, `cleanupTerminal` retention, `reactivate` DLQ requeue), `PgSagaCommandQueue` (FOR UPDATE SKIP LOCKED outbox, optional `claimStrategy: "fair-by-tenant"` to prevent starvation, `cleanupFailed` retention, `requeue` DLQ method, retry backoff via `next_attempt_at`), `PgSagaTimerStore` (`markFailed` for orphan handling, `cleanupTerminal` retention — defaults to fired-only so cancelled rows stay for triage), stuck-claimed watchdogs on all three, migrations `011-014`. Migration `014_saga_pipeline_hardening` adds `causation_event_id`, `next_attempt_at`, `last_error`, the `failed` timer status, and a nullable `source` column on `schema_migrations` for package attribution.
  - **`@eventfabric/sagas-opentelemetry`** — OTel adapter for saga tracing + counters + duration histograms, observable gauges `pending_commands_lag_seconds` and `scheduled_messages_overdue_count` (the alert), plus `createSagaRetentionMetrics` (per-table counter for retention sweep counts).

  Also adds the `TenantAwareUnitOfWork<TTx>` type to `@eventfabric/core` (formalises the `forTenant` extension the mediator + sagas rely on).

  See `examples/banking-api-saga/` for a runnable end-to-end example. See `docs/mediator.md`, `docs/sagas.md`, `docs/schema-reference.md`, and `docs/operational-runbook.md` for full reference.

### Patch Changes

- Updated dependencies [b8b08cc]
- Updated dependencies [b8b08cc]
  - @eventfabric/mediator@0.2.0
  - @eventfabric/core@0.2.0

## 0.2.0-beta.0

### Minor Changes

- Initial beta release.

  Six new packages introducing the command pipeline and saga primitive:

  - **`@eventfabric/mediator`** — abstract `Command` envelope, `CommandBus`, idempotency middleware framework, in-memory `IdempotencyStore`.
  - **`@eventfabric/mediator-postgres`** — Postgres-backed `PgIdempotencyStore` with claim-recovery from `failed` rows, `resetStaleInFlight` watchdog, migration `010_command_idempotency`.
  - **`@eventfabric/mediator-opentelemetry`** — `createCommandBusObserver` middleware (tracing span per command + sent/duration metrics labelled by command type and result), plus `createCommandIdempotencyGauges` (observable gauges for `in_flight` count and oldest-`in_flight` age — the watchdog alert).
  - **`@eventfabric/sagas`** — `Saga<S, E>` interface (pure reducer over events + timers), `applySagaTransition` runner, `sagaAsAsyncProjection` adapter, `SagaCommandDispatcher`, `SagaTimerScheduler`, in-memory stores, vendor-neutral observer hooks.
  - **`@eventfabric/sagas-postgres`** — `PgSagaStateStore` (optimistic CAS on `state_version`), `PgSagaCommandQueue` (FOR UPDATE SKIP LOCKED outbox), `PgSagaTimerStore`, stuck-claimed watchdogs on all three, migrations `011-013`.
  - **`@eventfabric/sagas-opentelemetry`** — OTel adapter for saga tracing + counters + duration histograms, plus observable gauges `pending_commands_lag_seconds` and `scheduled_messages_overdue_count` (the alert).

  See `examples/banking-api-saga/` for a runnable end-to-end example.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @eventfabric/mediator@0.2.0-beta.0
  - @eventfabric/core@0.2.0-beta.0
