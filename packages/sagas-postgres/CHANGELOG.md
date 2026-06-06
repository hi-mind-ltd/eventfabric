# @eventfabric/sagas-postgres

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
  - @eventfabric/mediator@0.2.0-beta.0
  - @eventfabric/mediator-postgres@0.2.0-beta.0
  - @eventfabric/sagas@0.2.0-beta.0
  - @eventfabric/postgres@0.2.0-beta.0
