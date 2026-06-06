---
"@eventfabric/mediator": minor
"@eventfabric/mediator-postgres": minor
"@eventfabric/mediator-opentelemetry": minor
"@eventfabric/sagas": minor
"@eventfabric/sagas-postgres": minor
"@eventfabric/sagas-opentelemetry": minor
---

Initial beta release.

Six new packages introducing the mediator (command pipeline) and saga primitive:

- **`@eventfabric/mediator`** — abstract `Command` envelope, `CommandBus`, idempotency middleware framework, built-in `createLoggingMiddleware`, in-memory `IdempotencyStore`. Tenant safety: `tenantValidator` hook + `requireTenantId` flag run before any transaction opens. In-flight conflict waiting happens OUTSIDE the bus transaction so connections + row locks are released during the poll. Backend-agnostic — pair with `@eventfabric/mediator-postgres` for PG-backed idempotency and `@eventfabric/mediator-opentelemetry` for tracing + metrics. Roadmap: queries and notifications.
- **`@eventfabric/mediator-postgres`** — Postgres-backed `PgIdempotencyStore` with claim-recovery from `failed` rows, `resetStaleInFlight` watchdog, `cleanup` retention method, migration `010_command_idempotency`.
- **`@eventfabric/mediator-opentelemetry`** — `createCommandBusObserver` middleware (tracing span per command + sent/duration metrics labelled by command type and result), `createCommandIdempotencyGauges` (observable gauges for `in_flight` count and oldest-`in_flight` age — the watchdog alert), and `createCommandRetentionMetrics` (counter for retention sweep row counts).
- **`@eventfabric/sagas`** — `Saga<S, E>` interface (pure reducer over events + timers), optional `SagaStateUpcaster` for schema evolution, `applySagaTransition` runner, `sagaAsAsyncProjection` adapter, `SagaCommandDispatcher` (with exponential `retryBackoffMs` and bounded `gracefulShutdownMs`), `SagaTimerScheduler` (with safe-by-default `onOrphanedTimer: "fail"` policy), in-memory stores, vendor-neutral observer hooks. Sagas emit commands via `@eventfabric/mediator` — emitted commands always inherit the saga's tenant (authors cannot pivot tenants) and carry `causationId` from the triggering event.
- **`@eventfabric/sagas-postgres`** — `PgSagaStateStore` (optimistic CAS on `state_version`, `cleanupTerminal` retention, `reactivate` DLQ requeue), `PgSagaCommandQueue` (FOR UPDATE SKIP LOCKED outbox, optional `claimStrategy: "fair-by-tenant"` to prevent starvation, `cleanupFailed` retention, `requeue` DLQ method, retry backoff via `next_attempt_at`), `PgSagaTimerStore` (`markFailed` for orphan handling, `cleanupTerminal` retention — defaults to fired-only so cancelled rows stay for triage), stuck-claimed watchdogs on all three, migrations `011-014`. Migration `014_saga_pipeline_hardening` adds `causation_event_id`, `next_attempt_at`, `last_error`, the `failed` timer status, and a nullable `source` column on `schema_migrations` for package attribution.
- **`@eventfabric/sagas-opentelemetry`** — OTel adapter for saga tracing + counters + duration histograms, observable gauges `pending_commands_lag_seconds` and `scheduled_messages_overdue_count` (the alert), plus `createSagaRetentionMetrics` (per-table counter for retention sweep counts).

Also adds the `TenantAwareUnitOfWork<TTx>` type to `@eventfabric/core` (formalises the `forTenant` extension the mediator + sagas rely on).

See `examples/banking-api-saga/` for a runnable end-to-end example. See `docs/mediator.md`, `docs/sagas.md`, `docs/schema-reference.md`, and `docs/operational-runbook.md` for full reference.
