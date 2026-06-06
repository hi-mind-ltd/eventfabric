# Banking API — saga variant

This is the sibling of [`examples/banking-api`](../banking-api). The domain model is
the same (customers, accounts, transactions), but **transfers are saga-only**:
there is no atomic `/transfers` path, no manual `/transactions/:id/initiate|complete|fail`.
Every transition through pending → started → withdrawn → deposited →
completed (or failed) is driven by the `FundsTransfer` saga reacting to events.

If you want the projection-based or atomic versions for comparison, those
are in [`examples/banking-api`](../banking-api).

## What's different from `banking-api`

| Concern | `banking-api` (projections) | `banking-api-saga` (this) |
|---|---|---|
| Transfer chain | three catch-up projections coordinating via emitted events | one `FundsTransfer` saga emitting `WithdrawFromAccount` / `DepositToAccount` / `CompleteTransaction` commands |
| Where the workflow lives | spread across 3 `handle` functions, coupled by event-type matching | one `reactToEvent` reducer in [`src/sagas/funds-transfer.saga.ts`](src/sagas/funds-transfer.saga.ts) |
| Per-instance state | re-derived from event history each tick | persisted snapshot in `eventfabric.saga_instances` |
| Withdrawal timeout | not expressible | one line — saga schedules a 30s `withdraw-timeout` timer; on fire it emits `FailTransaction` |
| Command-dispatch idempotency | n/a (projections write events directly) | bus dedup key `saga:FundsTransfer:<instance>:<rowId>` — worker crash mid-dispatch cannot produce duplicate effects |
| Failure path | each projection retries via the catch-up runner; cross-step recovery is ad-hoc | saga returns `end: true` on `TransactionFailed`; timer drives the timeout path |
| Tables added | (none beyond core) | `command_idempotency`, `saga_instances`, `saga_pending_commands`, `saga_scheduled_messages` |

## How the saga path flows

```
POST /transfers
  emits TransactionInitiated + TransactionStarted
       │
       ▼
  sagaAsAsyncProjection (on the outbox runner)
       │  correlate(TransactionStarted) → fresh instance, state seeded
       │  reaction:
       │    commands: [WithdrawFromAccount]
       │    schedule: [withdraw-timeout @ 30s]
       ▼
  SagaCommandDispatcher (long-running loop)
       │  claims pending row → CommandBus.send → handler
       │    handler emits WithdrawalCompleted
       ▼
  sagaAsAsyncProjection sees WithdrawalCompleted
       │  reaction:
       │    commands: [DepositToAccount]
       │    cancel:   [withdraw-timeout]
       ▼
  ... (same loop) DepositToAccount → DepositCompleted → CompleteTransaction → TransactionCompleted
       ▼
  saga returns end: true → instance marked completed
```

If `WithdrawalCompleted` doesn't arrive in 30s, `SagaTimerScheduler` fires the
timer instead, and the saga emits `FailTransaction`.

## Code map

| File | Purpose |
|---|---|
| [`src/app.ts`](src/app.ts) | Wires `CommandBus`, registers handlers, builds saga stores + observer, starts `SagaCommandDispatcher` + `SagaTimerScheduler`, adds the saga as an async projection on the outbox runner |
| [`src/sagas/funds-transfer.saga.ts`](src/sagas/funds-transfer.saga.ts) | The state machine — pure reducer, no IO |
| [`src/sagas/funds-transfer.commands.ts`](src/sagas/funds-transfer.commands.ts) | Command envelope types the saga emits |
| [`src/sagas/funds-transfer.handlers.ts`](src/sagas/funds-transfer.handlers.ts) | Command handlers — port of the projection logic, run via the bus |

## HTTP surface

| Route | Notes |
|---|---|
| `POST /customers/:id/register`, `PUT /customers/:id/email`, `GET /customers/:id` | Identical to `banking-api`. |
| `POST /accounts/:id/open`, `/open-with-stream`, `/deposit`, `/withdraw`, `/close`, `GET /accounts/:id` | Identical to `banking-api`. Saga is not involved — these are single-aggregate writes. |
| `POST /transfers` | **Saga-only.** Emits `TransactionInitiated + TransactionStarted`; the saga drives the rest. There is no atomic version. |
| `GET /transactions/:id` | Read the terminal state of a saga-driven transaction. |
| `GET /accounts/search`, `/accounts/with-customers` | Same read-model queries as `banking-api`. |
| `/ops/dlq`, `/ops/outbox`, `/ops/partitions` | Same ops routers. |
| `GET /ops/sagas/active` | **New.** Lists active `FundsTransfer` instances for triage. |

## What's kept from `banking-api`

- `domain/` (identical aggregates + events)
- `projections/email-projection.ts` — external delivery, runs on the outbox
- `projections/deposit-audit.ts` — single-event-type audit, runs catch-up
- `ops/` routers

## Observability

The saga path emits everything the OTel adapter ships in
`@eventfabric/sagas-opentelemetry`:

- Counters: `eventfabric.saga.instances_started/completed/failed`,
  `command_dispatch_total{result}`, `timer_fire_total{result}`
- Histograms: `instance_age_seconds`, `command_dispatch_duration_ms`,
  `timer_fire_duration_ms`
- Observable gauges: `pending_commands_lag_seconds`,
  **`scheduled_messages_overdue_count`** (the alert)
- Spans: `saga:FundsTransfer.react`, `saga:FundsTransfer.dispatch`

## Running

```sh
pnpm install
DATABASE_URL=postgresql://... pnpm --filter banking-api-saga-example dev
```

The schema is applied automatically on startup via
`migrate(pool, { extensions: [commandsMigrations, sagasMigrations] })` —
the four extra tables (`command_idempotency`, `saga_instances`,
`saga_pending_commands`, `saga_scheduled_messages`) are created on the
first boot.
