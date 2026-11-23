# Sagas (Process Managers)

A saga coordinates a long-running flow across aggregates and time. It
reacts to events, holds per-instance state, emits commands and timers,
and terminates cleanly when its job is done.

| Package | Contains |
|---|---|
| `@eventfabric/sagas` | `Saga<S, E>` interface, `applySagaTransition` runner, `sagaAsProjection` (projection daemon) and `sagaAsAsyncProjection` (outbox) adapters, `SagaCommandDispatcher`, `SagaTimerScheduler`, in-memory stores, vendor-neutral observer hooks. Sagas emit commands via `@eventfabric/mediator`. |
| `@eventfabric/sagas-postgres` | `PgSagaStateStore`, `PgSagaCommandQueue`, `PgSagaTimerStore`, stuck-claimed watchdogs on all three, `sagasMigrations` (migrations 011-013). |
| `@eventfabric/sagas-opentelemetry` | `createSagaObserver` (tracing + counters + duration histograms for instance lifecycle / command dispatch / timer fire), `createSagaQueueGauges` (observable gauges for queue lag and the overdue-timer alert). |

This is a *snapshot-based* saga — instance state is a JSONB row, not an
event stream. The pattern is intentionally less powerful than Temporal:
no durable execution of arbitrary code, no `await` on side effects, no
time-travel. It covers the 90% case (react → state + commands + timers →
maybe end) without that complexity budget.

## When to use a saga

Use a saga when you need any of:

- **State that crosses event boundaries.** "I started the withdrawal, now
  I'm waiting for the deposit confirmation." That `step` field doesn't
  belong in any one aggregate.
- **A timeout primitive.** "If the deposit hasn't completed in 30
  seconds, fail the transfer." Catch-up projections can't express this;
  sagas can in one line.
- **Compensation that requires history.** Knowing what to undo means
  knowing what was done — saga state is where that history naturally
  lives.

Do **not** use a saga for:

- Pure event-to-read-model derivation. Use an [async or catch-up
  projection](./projections/) — cheaper, no per-instance state.
- Logic that fits in a single aggregate. If `Account.deposit()` handles
  it, don't introduce a saga.

## The mental model

A saga is **a pure reducer plus a list of intents**. The reducer:

```
(state, event_or_timer) → { newState, commands?, schedule?, cancel?, end? }
```

The runner makes the intents real — persisting state via CAS, queueing
commands for a dispatcher, scheduling timers, advancing the
`lastEventPos` checkpoint. All of this commits in **one transaction**
with the saga's state advance, so downstream effects can never observe
a saga that "moved" without its commands or timers landing.

You write the reducer; the runner does everything else.

## Defining a saga

```ts
import type { Saga, SagaReaction, TimerMessage } from "@eventfabric/sagas";
import type { Command } from "@eventfabric/mediator";

type TransferState = {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  step: "started" | "withdrawn";
};

type BankingEvent =
  | { type: "TransactionStarted"; version: 1; transactionId: string; fromAccountId: string; toAccountId: string; amount: number }
  | { type: "WithdrawalCompleted"; version: 1; transactionId: string }
  | { type: "DepositCompleted"; version: 1; transactionId: string }
  | { type: "TransactionFailed"; version: 1; transactionId: string; reason: string };

const fundsTransferSaga: Saga<TransferState, BankingEvent> = {
  name: "FundsTransfer",
  version: 1,

  correlate(env) {
    const e = env.payload;
    if (
      e.type === "TransactionStarted" ||
      e.type === "WithdrawalCompleted" ||
      e.type === "DepositCompleted" ||
      e.type === "TransactionFailed"
    ) return e.transactionId;
    return null;          // not for this saga
  },

  startsNewInstance(env) {
    return env.payload.type === "TransactionStarted";
  },

  initialState(env) {
    const e = env.payload as Extract<BankingEvent, { type: "TransactionStarted" }>;
    return {
      transferId: e.transactionId,
      fromAccountId: e.fromAccountId,
      toAccountId: e.toAccountId,
      amount: e.amount,
      step: "started",
    };
  },

  reactToEvent(state, env, ctx): SagaReaction<TransferState> {
    const e = env.payload;

    if (e.type === "TransactionStarted") {
      return {
        newState: state,
        commands: [buildCommand("WithdrawFromAccount", {
          accountId: state.fromAccountId, amount: state.amount, transferId: state.transferId,
        }, ctx)],
        schedule: [{
          id: "withdraw-timeout",
          fireAt: { afterMs: 30_000 },
          message: { type: "$timer", id: "withdraw-timeout", payload: {} },
        }],
      };
    }

    if (e.type === "WithdrawalCompleted") {
      return {
        newState: { ...state, step: "withdrawn" },
        commands: [buildCommand("DepositToAccount", {
          accountId: state.toAccountId, amount: state.amount, transferId: state.transferId,
        }, ctx)],
        cancel: ["withdraw-timeout"],
      };
    }

    if (e.type === "DepositCompleted") {
      return {
        newState: state,
        commands: [buildCommand("CompleteTransaction", {
          transactionId: state.transferId,
        }, ctx)],
        end: true,
      };
    }

    if (e.type === "TransactionFailed") {
      // Someone else (e.g. the withdraw handler on insufficient funds)
      // already terminated it. Shut down so we don't wait for events
      // that won't arrive.
      return { newState: state, cancel: ["withdraw-timeout"], end: true };
    }

    return { newState: state };
  },

  reactToTimer(state, timer: TimerMessage, ctx): SagaReaction<TransferState> {
    if (timer.id === "withdraw-timeout") {
      return {
        newState: state,
        commands: [buildCommand("FailTransaction", {
          transactionId: state.transferId,
          reason: "Withdrawal timeout — no WithdrawalCompleted within 30s",
        }, ctx)],
        end: true,
      };
    }
    return { newState: state };
  },
};
```

### The four hooks

| Hook | Purpose |
|---|---|
| `correlate(env)` | Returns the saga instance id this event belongs to, or `null` to skip. Typically `env.payload.someId`. |
| `startsNewInstance(env)` | When `correlate` returned an id but no instance exists, should the runner create one? Usually `true` for the "initiating" event. |
| `initialState(env)` | Seed state for a freshly created instance. Only called when `startsNewInstance` returned `true`. |
| `reactToEvent(state, env, ctx)` | The reducer. Pure — no IO. Returns `SagaReaction`. |
| `reactToTimer?(state, timer, ctx)` | Optional. Same shape, called when a previously scheduled timer fires. |

### The reaction shape

```ts
interface SagaReaction<TState> {
  readonly newState: TState;
  readonly commands?: readonly Command[];      // dispatched async
  readonly schedule?: readonly ScheduledMessage[]; // timers to fire later
  readonly cancel?: readonly string[];          // timer ids to cancel
  readonly end?: boolean;                       // → status='completed'
}
```

All four effects (`newState`, `commands`, `schedule`, `cancel`) plus the
status transition commit in one transaction with the runner's
`lastEventPos` advance. There is no partial-success window.

## Wiring a saga

A running saga needs four pieces:

1. **State store** — persists per-instance state with optimistic CAS.
2. **Command queue** — outbox for commands the saga emits.
3. **Timer store** — schedules + claims due timers.
4. **Three workers** — react to events, drain commands, fire timers.

In production:

```ts
import { PgUnitOfWork } from "@eventfabric/postgres";
import { CommandBus } from "@eventfabric/mediator";
import { PgIdempotencyStore } from "@eventfabric/mediator-postgres";
import {
  SagaCommandDispatcher,
  SagaTimerScheduler,
  sagaAsProjection,
  type SagaTimerHandler,
} from "@eventfabric/sagas";
import { createProjectionDaemon } from "@eventfabric/postgres";
import {
  PgSagaStateStore,
  PgSagaCommandQueue,
  PgSagaTimerStore,
  sagasMigrations,
} from "@eventfabric/sagas-postgres";
import { commandsMigrations } from "@eventfabric/mediator-postgres";

const uow = new PgUnitOfWork(pool);

// 1. Command bus + handlers (saga emits commands → these handle them).
const bus = new CommandBus<PgTx>({
  uow,
  idempotencyStore: new PgIdempotencyStore(),
});
bus.register(withdrawFromAccountHandler);
bus.register(depositToAccountHandler);
bus.register(completeTransactionHandler);
bus.register(failTransactionHandler);

// 2. Saga storage.
const sagaStateStore = new PgSagaStateStore<TransferState>();
const sagaCommandQueue = new PgSagaCommandQueue();
const sagaTimerStore = new PgSagaTimerStore();
const sagaStores = {
  stateStore: sagaStateStore,
  commandQueue: sagaCommandQueue,
  timerStore: sagaTimerStore,
};

// 3. Feed the saga from the projection daemon: events arrive in
//    global_position order, never past the high water mark.
const daemon = createProjectionDaemon(pool, eventStore, [
  sagaAsProjection(fundsTransferSaga, sagaStores),
  // ...other projections
]);
daemon.start(abortController.signal).catch((err) => console.error("daemon:", err));

// 4. Two long-lived workers: command dispatcher + timer scheduler.
const dispatcher = new SagaCommandDispatcher(uow, sagaCommandQueue, bus);
const timerHandlers = new Map<string, SagaTimerHandler<PgTx>>([
  ["FundsTransfer", { saga: fundsTransferSaga, stores: sagaStores }],
]);
const scheduler = new SagaTimerScheduler(uow, sagaTimerStore, timerHandlers);

dispatcher.start().catch((err) => console.error("dispatcher:", err));
scheduler.start().catch((err) => console.error("scheduler:", err));

// 5. Schema (apply once at boot).
await migrate(pool, { extensions: [commandsMigrations, sagasMigrations] });
```

### `sagaAsProjection` — feeding events to a saga

Run sagas on the [Projection Daemon](./projections/projection-daemon.md).
`sagaAsProjection(saga, stores)` returns a `CatchUpProjection` that:

- Sees each tenant's events in `global_position` order, never past the
  high water mark, so an event whose transaction commits late is waited
  for, not skipped
- Calls `correlate()` and skips events with no instance
- Applies the reaction (state, commands, timers, `lastEventPos`) inside
  the daemon's batch transaction, together with the checkpoint
- Throws a `ConcurrencyError` if the state CAS misses (e.g. a timer fired
  at the same moment); the daemon retries the event with backoff
- Gets dead-lettered by the daemon after `maxAttempts`;
  `daemon.replayDeadLetter(id)` re-applies the event against the
  instance's current state, out of order

Several daemon instances can run side by side: each tenant's batches are
claimed by one instance at a time, so a saga instance never sees two
events concurrently from the daemon.

Don't `rebuild` a saga projection: replaying the log would re-run
reactions.

#### Duplicate protection: `lastEventPos`

Each instance stores `lastEventPos`, the highest `global_position` it has
applied, and skips events at or below it. That check is only correct
when events arrive in position order, which the daemon guarantees.
Dead-letter replays bypass it (`ProjectionHandleContext.replay`), and
`lastEventPos` never moves backwards.

#### Moving an existing saga from the outbox runner

A projection the daemon has never seen starts at checkpoint 0 and reads
the whole log. Existing instances skip what they have already applied,
but an old flow whose instance row has since been deleted would be
started again. Seed the checkpoint before the first daemon start, with
the outbox runner stopped:

```sql
-- One checkpoint per tenant: just before the oldest event still waiting
-- in the outbox (or the newest event, if the outbox is empty). Overlap
-- with what the old runner already delivered is skipped by lastEventPos.
INSERT INTO eventfabric.projection_checkpoints (projection_name, tenant_id, last_global_position)
SELECT 'saga:FundsTransfer', e.tenant_id,
       COALESCE((SELECT MIN(o.global_position) - 1
                   FROM eventfabric.outbox o
                  WHERE o.tenant_id = e.tenant_id),
                MAX(e.global_position))
FROM eventfabric.events e
GROUP BY e.tenant_id
ON CONFLICT (projection_name, tenant_id)
DO UPDATE SET last_global_position = EXCLUDED.last_global_position;
```

Saga rows already in `outbox_dead_letters` are not picked up by the
daemon. Requeue them before switching (and let the old runner drain
them), or handle them by hand.

### `sagaAsAsyncProjection` (outbox runner) — limitations

`sagaAsAsyncProjection(saga, stores)` runs a saga on the outbox
`AsyncProjectionRunner`. **It can lose events.** The outbox does not
deliver in `global_position` order:

- rows are claimed in insertion order, not commit order, so an event
  whose transaction commits late arrives after later events;
- released and retried rows come back after rows behind them;
- runner replicas overtake each other.

When a later event for an instance is applied first, `lastEventPos` moves
past the earlier one, and the earlier one is then skipped as "already
applied". The saga never sees it. A saga row requeued from the outbox DLQ
is skipped the same way.

It is only safe when each instance's events are produced strictly one
after another (each caused by the previous step), with a single runner,
and you never requeue saga rows. Wolverine documents the same limitation
for its at-commit "event forwarding" ("There is no guarantee about
ordering in this case") and recommends its daemon-based event
subscriptions instead. Prefer `sagaAsProjection`.

## Workers

### `SagaCommandDispatcher`

Drains the saga command queue and routes each row through the
`CommandBus`. Key behaviors:

- `claimBatch` uses `FOR UPDATE SKIP LOCKED` (multiple replicas safe).
- Rewrites the dispatched command's `idempotencyKey` to
  `saga:${sagaName}:${instanceId}:${rowId}` — so a worker crash
  mid-dispatch can re-claim and re-dispatch without producing duplicate
  effects (the bus dedups on the rewritten key).
- After `maxAttempts` (default 5), the row is flipped to
  `status = 'failed'` for ops triage.

Configure:

```ts
new SagaCommandDispatcher(uow, queue, bus, {
  batchSize: 32,        // rows claimed per round
  maxAttempts: 5,       // before marking failed
  idleSleepMs: 1000,    // sleep between empty rounds
  busySleepMs: 0,       // sleep between busy rounds
  observer,             // OTel observer (see below)
});
```

### When a round fails

If a whole round of the dispatcher or the scheduler throws (for example,
the database is unreachable), the loop does not exit. It reports the error
through `observer.onLoopError({ component, error, consecutiveErrors,
retryInMs })`, waits with exponential backoff, and tries again. The backoff
resets after the next successful round. Configure it with `errorBackoff`
(default `{ minMs: 250, maxMs: 15_000, factor: 2, jitter: 0.2 }`).
`stop()` cuts the current sleep or backoff short.

### `SagaTimerScheduler`

Polls due timers and delivers each to its saga's `reactToTimer`. The
delivery + `markFired` commit in one transaction so a delivery is
exactly-once with its effects.

- `claimDue` uses `FOR UPDATE SKIP LOCKED` (multiple replicas safe).
- If a saga is not registered for an incoming timer (the saga code was
  removed but rows still exist), the row is marked `fired` so it doesn't
  loop forever. The `orphaned` count is returned from `runOnce()` for
  monitoring.
- Concurrent state advances are released back to `pending` and re-fired
  on the next round.
- The claim commits on its own, so a timer can be cancelled or
  re-scheduled between its claim and its delivery. The delivery
  transaction re-checks and locks the row first (`lockClaimed`), and skips
  a timer that is no longer claimed. The `skipped` count is returned from
  `runOnce()`, and `onTimerSkipped` is emitted. A custom `SagaTimerStore`
  without `lockClaimed` delivers every claimed timer.
- A reaction can re-schedule the timer being delivered (a recurring
  timer). The row goes back to `pending` with the new `fireAt`, because
  `markFired` only changes a row that is still `claimed`.

Configure:

```ts
new SagaTimerScheduler(uow, timerStore, handlers, {
  batchSize: 32,
  idleSleepMs: 1000,
  busySleepMs: 0,
  now: () => new Date(),  // override for tests
  observer,
});
```

## Concurrency & failure handling

| Scenario | Behavior |
|---|---|
| Two workers process the same event for the same instance | State CAS on `state_version` lets one win; the other gets `result: "concurrent"` and the runner releases the message for retry. |
| Two events for the same instance arrive out of order | `correlate()` routes both to the same instance; the runner processes them sequentially (the CAS lock serializes). Your `reactToEvent` must tolerate ordering — usually by checking `state.step`. |
| Replay of an already-processed event | The runner skips events where `globalPosition <= state.lastEventPos`. Replay is a no-op. |
| Handler throws after `maxAttempts` | The command row is flipped to `status='failed'`. The event itself dead-letters via the runner's existing DLQ path. The saga instance does **not** auto-fail — operator decides whether to retry or abandon. |
| Sagas without commands or timers | The reducer can return just `{ newState }`. No outbox row, no timer, no fan-out. |

## Schema evolution

Sagas are snapshot-persisted (state lives as a JSONB row, not a stream
of events), so schema evolution uses a single upcaster declared on the
saga rather than per-version migrations.

```ts
import type { Saga, SagaStateUpcaster } from "@eventfabric/sagas";

// v1 state shape: { from, to, amount, step }
// v2 state shape: { fromAccountId, toAccountId, amount, step }
type TransferStateV2 = {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  step: "started" | "withdrawn";
};

const upcaster: SagaStateUpcaster<TransferStateV2> = (raw, fromVersion) => {
  if (fromVersion === 1) {
    const v1 = raw as { from: string; to: string; amount: number; step: "started" | "withdrawn" };
    return {
      fromAccountId: v1.from,
      toAccountId: v1.to,
      amount: v1.amount,
      step: v1.step,
    };
  }
  return raw as TransferStateV2;
};

const fundsTransferSaga: Saga<TransferStateV2, BankingEvent> = {
  name: "FundsTransfer",
  version: 2,            // ← bumped from 1
  upcaster,
  // ... rest of the saga unchanged ...
};
```

### When the upcaster runs

- On every load where `instance.schemaVersion < saga.version`.
- Before `reactToEvent` / `reactToTimer` — your reducer always sees
  current-shape state.
- Once per load — there is no in-memory cache; the next load runs it
  again until the row's persisted `schemaVersion` reaches the saga's
  current version.

### When it doesn't run

- Fresh instances (`startsNewInstance` → `initialState`) — that state
  is current-shape by construction.
- Loads where `instance.schemaVersion === saga.version` — fast path,
  no upcast call.

### How rows reach the new shape

The runner persists the upgraded state on the next CAS update. So the
moment an old-shape instance receives any event or timer, its row gets
rewritten with `schemaVersion = saga.version` and the new state shape.
There is no bulk migration step — instances upgrade lazily as they
advance. Long-quiescent instances that never receive another event
remain at their old `schemaVersion` (and are re-upcast on every load
until they do).

### Chained version bumps

For sagas that go through multiple version bumps without you holding
two upcasters, write one upcaster that dispatches on `fromVersion`:

```ts
const upcaster: SagaStateUpcaster<TransferStateV3> = (raw, fromVersion) => {
  let s: unknown = raw;
  if (fromVersion <= 1) s = upcastV1ToV2(s as V1);
  if (fromVersion <= 2) s = upcastV2ToV3(s as V2);
  return s as TransferStateV3;
};
```

The single upcaster covers any chain. `fromVersion` is the persisted
version, not the saga's current one, so this works regardless of how
many minor versions ago an instance was last written.

## Retention

The saga tables grow forever without intervention. Three `cleanup`
methods on the PG stores keep them bounded; schedule them from a cron
alongside the existing watchdogs.

| Method | Removes | Typical cadence |
|---|---|---|
| `PgSagaStateStore.cleanupTerminal({ olderThan, statuses? })` | Saga instances with `status IN ('completed','failed')` past the cutoff | Daily |
| `PgSagaCommandQueue.cleanupFailed({ olderThan })` | Rows with `status='failed'` past the cutoff (dispatched commands are already ack-deleted) | Daily |
| `PgSagaTimerStore.cleanupTerminal({ olderThan, statuses? })` | Timers with `status IN ('fired','cancelled')` past the cutoff | Daily |

Each method takes an optional `tenantId` to scope to a single tenant.
The `statuses` filter on the state and timer cleanups lets you keep
`failed` instances or `cancelled` timers around longer for triage
while still pruning the bulk of the table.

```ts
import { Pool } from "pg";
import { PgUnitOfWork } from "@eventfabric/postgres";
import { PgSagaStateStore, PgSagaCommandQueue, PgSagaTimerStore } from "@eventfabric/sagas-postgres";

const pool = new Pool({ ... });
const uow = new PgUnitOfWork(pool);

// Run once per day from cron / pg_cron / k8s CronJob.
const olderThan = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days

await uow.withTransaction(async (tx) => {
  await new PgSagaStateStore().cleanupTerminal(tx, { olderThan });
  await new PgSagaCommandQueue().cleanupFailed(tx, { olderThan });
  await new PgSagaTimerStore().cleanupTerminal(tx, { olderThan });
});
```

The framework deliberately does not start its own retention daemon —
cadence is an ops choice, and your retention window depends on your
business's audit + compliance requirements.

## Multi-tenancy

All three saga tables and every saga API take an explicit `tenantId`, so
same-keyed saga instances in different tenants are independent:

- `saga_instances` PK is `(tenant_id, saga_name, instance_id)`
- `saga_pending_commands` and `saga_scheduled_messages` rows carry
  `tenant_id`
- `applySagaTransition(saga, delivery, { tx, tenantId }, stores)`
  requires `tenantId` on its context
- `sagaAsProjection` / `sagaAsAsyncProjection` read `tenantId` from the
  event envelope (`env.tenantId`); the daemon processes one tenant per
  batch transaction, so this is automatic

For workers that serve **many tenants from one process** (the typical
dispatcher and scheduler setup), the framework narrows the UoW per
item:

- **`SagaCommandDispatcher`** stamps the queue row's `tenantId` onto
  the dispatched command's `metadata.tenantId` (author-supplied takes
  precedence). The `CommandBus` then auto-narrows its UoW from
  `cmd.metadata.tenantId` — see the
  [mediator multi-tenancy section](./mediator.md#multi-tenancy).
- **`SagaTimerScheduler`** calls `uow.forTenant(item.tenantId)` before
  the per-item transaction (saga reaction + `markFired` commit
  together under the right tenant).

Both workers work correctly with single-tenant UoWs too — `forTenant`
on a non-tenant-aware UoW is a no-op; the dispatched command's
`metadata.tenantId` is set regardless. So the same dispatcher + scheduler
code runs unchanged from a single-tenant dev environment to a
many-tenant production deployment.

```ts
// One dispatcher process, all tenants.
const dispatcher = new SagaCommandDispatcher(
  new PgUnitOfWork(pool),            // tenant-scoped factory
  sagaCommandQueue,                  // claims across tenants
  bus,                               // bus auto-narrows per cmd.metadata.tenantId
);
dispatcher.start();

// Same for the timer scheduler.
const scheduler = new SagaTimerScheduler(
  new PgUnitOfWork(pool),
  sagaTimerStore,
  handlers,
);
scheduler.start();
```

The `SagaReactContext.metadata.tenantId` passed into `reactToEvent` and
`reactToTimer` is always the current saga's tenant — your saga author
typically forwards it into commands via `buildCommand()`:

```ts
const buildCommand = (type, payload, ctx) => ({
  type,
  version: 1,
  payload,
  metadata: {
    commandId: ulid(),
    idempotencyKey: `${type}:${ctx.metadata.instanceId}`,
    issuedAt: new Date().toISOString(),
    correlationId: ctx.metadata.correlationId,
    causationId: ctx.metadata.instanceId,
    tenantId: ctx.metadata.tenantId,    // explicit — clearest
  },
});
```

If you forget to thread `tenantId` through (or are migrating older
saga code), the dispatcher fills it in from the queue row — but the
explicit version is preferable because it documents intent at the
saga site.

## OpenTelemetry

```ts
import { trace, metrics } from "@opentelemetry/api";
import { createSagaObserver, createSagaQueueGauges } from "@eventfabric/sagas-opentelemetry";

const sagaObserver = createSagaObserver({
  tracer: trace.getTracer("my-app"),
  meter: metrics.getMeter("my-app"),
});

// Thread the observer into all three workers.
const projection = sagaAsProjection(saga, stores, { observer: sagaObserver });
const dispatcher = new SagaCommandDispatcher(uow, queue, bus, { observer: sagaObserver });
const scheduler = new SagaTimerScheduler(uow, timerStore, handlers, { observer: sagaObserver });
```

Spans emitted:

- `saga:${name}.react` — wraps every saga reaction; child spans (pg,
  http) attach automatically
- `saga:${name}.dispatch` — wraps every `bus.send` from the dispatcher

Metrics emitted:

- `eventfabric.saga.instances_started`, `instances_completed`,
  `instances_failed` — counters
- `eventfabric.saga.instance_age_seconds` — histogram, recorded at
  completion
- `eventfabric.saga.command_dispatch_total{result}` — counter, results
  `dispatched` / `released` / `failed`
- `eventfabric.saga.command_dispatch_duration_ms` — histogram
- `eventfabric.saga.timer_fire_total{result}` — counter, results
  `fired` / `released` / `skipped` / `orphaned`
- `eventfabric.saga.timer_fire_duration_ms` — histogram
- `eventfabric.saga.loop_error_total{component}` — counter, components
  `timer-scheduler` / `command-dispatcher`; rounds that threw and were
  retried (see [When a round fails](#when-a-round-fails))

### Queue gauges

Observable gauges polled from the DB at each metric export. The package
stays free of `pg` — you supply the queries:

```ts
import { Pool } from "pg";

createSagaQueueGauges({
  meter: metrics.getMeter("my-app"),
  pendingCommandsLagSeconds: async () => {
    const r = await pool.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(enqueued_at))), 0)::float8 AS v
         FROM eventfabric.saga_pending_commands
        WHERE status = 'pending'`
    );
    return r.rows[0]?.v ?? 0;
  },
  overdueScheduledMessagesCount: async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM eventfabric.saga_scheduled_messages
        WHERE status = 'pending' AND fire_at <= NOW()`
    );
    return r.rows[0]?.n ?? 0;
  },
});
```

Two gauges:

- `eventfabric.saga.pending_commands_lag_seconds` — age of the oldest
  unread row in the saga command queue. Sustained growth means the
  dispatcher can't keep up.
- `eventfabric.saga.scheduled_messages_overdue_count` — **the alert.**
  Number of timers past their `fire_at` that haven't fired. Should
  trend to zero on a healthy scheduler.

## Operational concerns

The PG stores ship watchdog methods for worker crashes:

- `PgSagaCommandQueue.resetStaleClaimed({ olderThan })` — recover rows
  claimed by a crashed dispatcher.
- `PgSagaTimerStore.resetStaleClaimed({ olderThan })` — recover timers
  claimed by a crashed scheduler.

See the [operational runbook](./operational-runbook.md) for cadences,
sample cron wiring, and the triage path for persistent `failed` rows
and `status = 'failed'` saga instances.

## Testing

Sagas are pure reducers — test them without a database:

```ts
import { applySagaTransition, InMemorySagaStateStore, InMemorySagaCommandQueue, InMemorySagaTimerStore } from "@eventfabric/sagas";

const stores = {
  stateStore: new InMemorySagaStateStore<TransferState>(),
  commandQueue: new InMemorySagaCommandQueue(),
  timerStore: new InMemorySagaTimerStore(),
};

const outcome = await applySagaTransition(
  fundsTransferSaga,
  { kind: "event", envelope: transactionStartedEnvelope },
  { tx: {} as any, tenantId: "default" },
  stores
);

expect(outcome.result).toBe("applied");
expect(stores.commandQueue.pendingRows()[0]!.command.type).toBe("WithdrawFromAccount");
expect(stores.timerStore.pendingTimers()[0]!.id).toBe("withdraw-timeout");
```

`applySagaTransition` is the same function the production runner uses;
the in-memory stores mirror the PG ones. What works in tests works in
prod.

## Schema

Three tables. See the [schema reference](./schema-reference.md) for
column-level detail.

| Table | Migration | Purpose |
|---|---|---|
| `eventfabric.saga_instances` | `011_saga_instances.sql` | Per-instance state + version + status. Optimistic CAS on `state_version`. |
| `eventfabric.saga_pending_commands` | `012_saga_pending_commands.sql` | Outbox for commands emitted by sagas. `FOR UPDATE SKIP LOCKED` claim. |
| `eventfabric.saga_scheduled_messages` | `013_saga_scheduled_messages.sql` | Scheduled timer messages keyed by `(tenant, saga, instance, id)`. |

Apply via:

```ts
import { migrate } from "@eventfabric/postgres";
import { sagasMigrations } from "@eventfabric/sagas-postgres";

await migrate(pool, { extensions: [sagasMigrations] });
```

## What this is not

By design, this is **not** Temporal. There is no durable execution of
arbitrary code, no `await` on external calls, no automatic retries of
your business logic, no time-travel debugging. The saga reduces over
events the framework already records; the runner makes the intent data
real. That gap is deliberate — it keeps the framework's complexity
budget small and the saga API testable as pure functions.

## See also

- [Mediator](./mediator.md) — sagas emit commands through the mediator;
  the dispatcher routes them via `CommandBus.send`.
- [Operational runbook](./operational-runbook.md) — watchdog cadences,
  the overdue-timer alert, triage for persistent failures.
- [Schema reference](./schema-reference.md) — column-level reference for
  all three saga tables.
- [`examples/banking-api-saga`](../examples/banking-api-saga) — runnable
  end-to-end example: a funds-transfer saga with a 30-second
  withdraw-timeout, three command handlers, and full OTel.
