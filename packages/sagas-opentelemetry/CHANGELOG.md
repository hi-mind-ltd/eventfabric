# @eventfabric/sagas-opentelemetry

## 0.4.1

### Patch Changes

- 6d1ca13: Fix data-loss and false-alarm bugs found in review.

  - **Outbox:** `ack`, `release`, `releaseWithError` and `deadLetter` take an optional `workerId` and only act while that worker still holds the lease. The async runner passes it, so a handler that outlived `leaseMs` can no longer commit twice (a late ack throws `LeaseLostError` and rolls back) or free another worker's lock. In batch mode a failure is charged only to the row that failed, so one poison row no longer sends its whole batch to the dead-letter queue.
  - **Saga timers:** new optional `SagaTimerStore.lockClaimed`. The scheduler re-checks each claimed timer at delivery and skips one that was cancelled or re-scheduled after the claim (round result `skipped`, observer hook `onTimerSkipped`, and `result="skipped"` on `eventfabric.saga.timer_fire_total`). `PgSagaTimerStore.markFired` only changes a claimed row, so a timer that re-schedules its own id keeps running.
  - **Session:** a snapshot written by `saveChangesAsync` now holds the state at the saved version. Before, a direct `append` snapshotted only the events of that save.
  - **Hash chain:** a process that has not registered a tamper-evident aggregate now extends its chained streams instead of breaking them (or refuses, without `hashChain.secret`). Payloads containing a `Date` no longer fail verification.
  - **Idempotency:** reusing an idempotency key for a different command type, or for the same type with a different payload, throws `IdempotencyKeyConflictError` instead of returning the other command's result. `@eventfabric/mediator-postgres` adds migration `018_command_request_hash` (a `request_hash` column), applied by `migrate(pool, { extensions: [commandsMigrations] })`.

- 9ce0828: Fix robustness bugs found in review.

  - **Query builder (postgres):** the fluent builder no longer puts column names, operators, sort direction, JSONB keys, `limit` or `offset` into the SQL text unchecked. JSONB keys, `limit` and `offset` are parameters; column names must be plain identifiers; operators and sort direction must come from a fixed set. Invalid input throws.
  - **Migrations (postgres):** concurrent `migrate()` calls (several app instances starting at once) are serialized with an advisory lock, and `enablePartitioning()` re-checks under the table lock, so a second caller backs off instead of breaking the new partitioned table. New `PgPartitionManager.enablePartitioningOn(client)`.
  - **Saga loops (sagas):** the timer scheduler and command dispatcher keep running after a round throws (e.g. the database is down). They report via the new `onLoopError` observer hook, back off (`errorBackoff` option), and `stop()` interrupts the sleep. `sagas-opentelemetry` counts `eventfabric.saga.loop_error_total`.
  - **Failed saves (core, postgres):** `Repository.save()` and `saveChangesAsync()` change the in-memory aggregate only after the commit. A failed save keeps the pending events and old version, so a retry writes them instead of silently returning `null`. New `AggregateRoot.peekPendingEvents()` and `markCommitted()`.
  - **Backoff (core):** the first retry waits `minMs`, not `minMs * factor`.
  - **OpenTelemetry:** per-event, per-command and per-instance ids (`global_position`, positions, `command_id`, `idempotency_key`, `principal_id`, `correlation_id`, `saga_instance`, `timer_id`) are no longer metric attributes; they stay on spans. Dashboards that grouped metrics by these labels need updating.

- Updated dependencies [6d1ca13]
- Updated dependencies [9ce0828]
  - @eventfabric/sagas@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [015b888]
  - @eventfabric/sagas@0.4.0

## 0.3.0

### Patch Changes

- @eventfabric/sagas@0.3.0

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
  - @eventfabric/sagas@0.2.0

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
  - @eventfabric/sagas@0.2.0-beta.0
