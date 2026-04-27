# Proposal 0002 — Saga / process manager primitive

**Status:** Draft
**Author:** Architecture
**Target package:** `@eventfabric/core` (new module), `@eventfabric/postgres` (storage)
**Depends on:** Proposal 0001 (Command pipeline & idempotency)
**Related code:** [examples/banking-api/src/projections/eventual-transfer-projections.ts](examples/banking-api/src/projections/eventual-transfer-projections.ts) — current hand-rolled approach

## 1. Problem

There is no first-class concept for long-running, stateful coordination across multiple events and aggregates. Today users have two options, neither good:

1. **Hand-roll as catch-up projections.** The banking example does exactly this — its [eventual-transfer-projections.ts:13](examples/banking-api/src/projections/eventual-transfer-projections.ts#L13) opens with a comment that explicitly calls the construct "a *process manager*". Three projections coordinate `TransactionStarted → WithdrawalCompleted → DepositCompleted → TransactionCompleted`. Problems with this approach:
   - Saga state is reconstructed each tick from event replay — expensive and easy to get wrong.
   - No timeout primitive ("if `WithdrawalCompleted` doesn't arrive in 30s, fail the transfer").
   - Compensation is ad-hoc: each projection has to know how to undo prior steps.
   - Correlation is implicit (matching on `transactionId`) — easy to leak state across instances.
   - One bug means the projection drops a checkpoint and a transfer is silently stuck.

2. **Inline orchestration in command handlers.** Doesn't work: the steps cross aggregate boundaries and can't be a single transaction.

The **lack of a saga primitive is the biggest gap** between EventFabric and mature toolkits (Axon, Marten, NServiceBus, Temporal). Without it, every non-trivial domain reinvents one — usually badly.

This proposal adds a `Saga<S, E>` primitive that is **strictly less powerful than Temporal** (no durable execution, no time-travel) but covers the 90% case: react to events, hold state, dispatch commands, schedule timeouts, terminate cleanly.

## 2. Goals & non-goals

**Goals**

- A typed `Saga<S, E>` with state, event handlers, and a runner.
- **Correlation**: each event routes to one saga instance via a caller-defined `correlationId`. New events with no matching instance can optionally start one.
- **Command dispatch**: sagas emit commands — delivered through `CommandBus` (proposal 0001) with at-least-once semantics.
- **Timers**: sagas schedule `at | after` messages; a scheduler delivers them as events to the saga.
- **Termination**: `endSaga()` marks the instance complete; further events are ignored.
- **Idempotency**: each event delivered to a saga is checkpointed; replay is safe.
- **Atomic state updates**: state mutation, command-emission, and timer-scheduling commit in one transaction with the saga's checkpoint advance.

**Non-goals**

- Not Temporal. No durable execution of arbitrary code, no `await` on side effects, no automatic retries of arbitrary user code.
- No visual saga designer, no DSL.
- No cross-tenant sagas. A saga instance is scoped to one tenant.
- No GUI for saga inspection — that's a future ops concern. CLI/SQL queries are sufficient initially.
- No hierarchical sagas (a saga starting a saga). Achievable via command dispatch but not first-class.

## 3. Design

### 3.1 Saga shape

```ts
// packages/core/src/sagas/saga.ts
export interface Saga<TState, TEvent extends AnyEvent> {
  readonly name: string;                     // e.g. "FundsTransfer"
  readonly version: number;                  // saga schema version

  /**
   * Decides which saga instance an incoming event routes to.
   * Returning `null` means "no instance — ignore this event".
   * Returning a string is the correlationId for the saga instance.
   */
  correlate(event: EventEnvelope<TEvent>): string | null;

  /**
   * Whether an event with no matching saga instance should start a new one.
   * If `true`, a fresh instance is created with `initialState`.
   */
  startsNewInstance(event: EventEnvelope<TEvent>): boolean;
  initialState(event: EventEnvelope<TEvent>): TState;

  /**
   * Reaction to an event. Returns the new state and a list of effects.
   * Pure-ish: should not perform IO. Effects are dispatched by the runner
   * inside the same transaction as state persistence.
   */
  react(
    state: TState,
    event: EventEnvelope<TEvent> | TimerMessage,
    ctx: SagaReactContext
  ): SagaReaction<TState>;
}

export interface SagaReaction<TState> {
  readonly newState: TState;
  readonly commands?: Command[];                 // dispatched through CommandBus
  readonly schedule?: ScheduledMessage[];        // timers
  readonly cancel?: string[];                    // cancel previously-scheduled messages by id
  readonly end?: boolean;                        // terminate this saga instance
}

export interface ScheduledMessage {
  readonly id: string;                           // caller-chosen, unique per saga instance
  readonly fireAt: Date | { afterMs: number };
  readonly message: TimerMessage;                // arbitrary payload visible to react()
}

export interface TimerMessage {
  readonly type: "$timer";
  readonly id: string;
  readonly payload: unknown;
}

export interface SagaReactContext {
  readonly metadata: { correlationId: string; instanceId: string; tenantId: string };
}
```

The saga is **a pure reducer plus a list of intents**. The runner is what makes intents real — dispatching commands, persisting timers, advancing checkpoints. This separation is intentional: the saga is fully unit-testable without IO, just like an aggregate.

### 3.2 State storage

**Default model: snapshot-only.** Saga state lives as a row in `eventfabric.saga_instances`:

```sql
CREATE TABLE eventfabric.saga_instances (
  saga_name        TEXT        NOT NULL,
  instance_id      TEXT        NOT NULL,
  tenant_id        TEXT        NOT NULL DEFAULT 'default',
  state            JSONB       NOT NULL,
  state_version    INTEGER     NOT NULL,           -- optimistic locking
  status           TEXT        NOT NULL CHECK (status IN ('active','completed','failed')),
  schema_version   INTEGER     NOT NULL DEFAULT 1, -- for state upcasting
  last_event_pos   BIGINT,                         -- highest globalPosition processed
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, saga_name, instance_id)
);

CREATE INDEX saga_instances_active_idx
  ON eventfabric.saga_instances (saga_name, status, tenant_id)
  WHERE status = 'active';
```

State updates use `UPDATE ... WHERE state_version = $expected` for optimistic concurrency, mirroring the aggregate pattern. Two parallel runners trying to advance the same saga both lose the race except one — the loser releases the event and retries.

**Why snapshot-only by default.**
Saga state is rarely interesting as history. It's a state machine with maybe 5 fields. Full event-sourcing is overkill, and re-deriving state on every event tick would dominate runtime cost. Marten and NServiceBus both use the snapshot model for the same reason.

**Audit trail (opt-in).** A second table `saga_state_log` records `(saga_name, instance_id, state_version, event_id, transition_at, prior_state, new_state)`. Off by default — consumers enable it per-saga via `{ auditTrail: true }`. Useful for debugging, off-by-default to avoid storage cost.

**Event-sourced sagas.** Reserved for a future proposal (0002b) if a real need emerges. The shape would be: saga state is an aggregate whose events are saga transitions. Costs more, gains audit + replay. Not on this proposal's path.

### 3.3 Saga runner

The runner is structurally a specialized async projection — it reads the outbox, routes each event through `correlate`, loads/creates a saga instance, runs `react`, persists. It can be built as either:

- **Reuse `AsyncProjectionRunner`** — the saga becomes an async projection with extra storage. Cleanest reuse.
- **Dedicated `SagaRunner`** — separate runner with its own outbox queue.

Recommend: **reuse**. Sagas are routed via async projections that the framework provides:

```ts
function asAsyncProjection<S, E>(saga: Saga<S, E>): AsyncProjection<E, PgTx> {
  return {
    name: `saga:${saga.name}`,
    topicFilter: undefined,                    // saga handles its own filtering via correlate()
    async handle(tx, env) {
      const instanceId = saga.correlate(env);
      if (instanceId === null) return;          // not for any instance

      const instance = await loadOrCreate(tx, saga, instanceId, env);
      if (!instance) return;                    // event matched no instance and doesn't start one

      if (instance.lastEventPos !== null && env.globalPosition <= instance.lastEventPos) {
        return;                                 // already processed; idempotent skip
      }

      const reaction = saga.react(instance.state, env, {
        metadata: { correlationId: env.correlationId ?? instanceId, instanceId, tenantId: tx.tenantId },
      });

      await persistReaction(tx, saga, instance, reaction, env.globalPosition);
    },
  };
}
```

This means **all the existing async-projection plumbing** — outbox, checkpointing, retries, dead-lettering, observability hooks — works for sagas with zero additional infrastructure. That's a big win.

### 3.4 Command emission

When `react` returns commands, the runner inserts them into a new `saga_pending_commands` table inside the same transaction:

```sql
CREATE TABLE eventfabric.saga_pending_commands (
  id              BIGSERIAL    PRIMARY KEY,
  tenant_id       TEXT         NOT NULL,
  saga_name       TEXT         NOT NULL,
  instance_id     TEXT         NOT NULL,
  command         JSONB        NOT NULL,
  enqueued_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  attempts        INTEGER      NOT NULL DEFAULT 0,
  status          TEXT         NOT NULL CHECK (status IN ('pending','dispatched','failed'))
);
```

A separate worker (`SagaCommandDispatcher`) claims rows in batches and sends through `CommandBus.send()`. Why a second outbox instead of dispatching directly?

- **Atomicity.** The saga's state update and the decision to dispatch commands must commit together. Direct dispatch creates a nested-Tx problem: if the bus's idempotency claim fails, do we roll back the saga state? Cleaner: persist the intent, drain it asynchronously.
- **Idempotency for free.** The bus already has idempotency middleware (proposal 0001). The dispatcher uses `idempotencyKey = ${saga.name}:${instance.id}:${row.id}` — guarantees a saga's command emission is dispatched exactly once even if the dispatcher crashes mid-batch.

### 3.5 Timers / scheduled messages

```sql
CREATE TABLE eventfabric.saga_scheduled_messages (
  id              TEXT         NOT NULL,           -- caller-supplied id, scoped per instance
  tenant_id       TEXT         NOT NULL,
  saga_name       TEXT         NOT NULL,
  instance_id     TEXT         NOT NULL,
  fire_at         TIMESTAMPTZ  NOT NULL,
  message         JSONB        NOT NULL,           -- the TimerMessage
  status          TEXT         NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','fired','cancelled')),
  PRIMARY KEY (tenant_id, saga_name, instance_id, id)
);

CREATE INDEX saga_scheduled_due_idx
  ON eventfabric.saga_scheduled_messages (fire_at)
  WHERE status = 'pending';
```

A `SagaTimerScheduler` worker polls due messages (`SELECT ... WHERE status='pending' AND fire_at <= NOW() FOR UPDATE SKIP LOCKED`), and for each one:

1. Loads the target saga instance.
2. Runs `saga.react(state, timerMessage, ctx)`.
3. Persists the reaction (state, new commands, new timers, optional `end`).
4. Marks the message `fired`.

All in one transaction. The timer scheduler is essentially a saga runner whose "events" come from the timers table instead of the outbox.

**Granularity.** Default poll interval 1s. Adequate for human-scale timeouts (seconds to days). Sub-second timers are explicitly out of scope — this is not a real-time scheduler.

**Cancellation.** `react` can return `cancel: ["timer-id-1", "timer-id-2"]`. The runner UPDATEs those rows to `cancelled` in the same transaction.

**Time skew.** Timers fire at-or-after `fire_at`, never before. If the scheduler is down for 10 minutes and 200 timers are due, they all fire on resume in `fire_at` order. Documented behavior.

### 3.6 Correlation patterns

Three common patterns supported, all via the user-defined `correlate()`:

1. **Existing-aggregate-id correlation** — saga instance id = aggregate id from event payload. Used when one saga tracks one aggregate's lifecycle. Example: `correlate(env) => env.payload.transactionId`.
2. **Message-supplied id** — caller stamps a `correlationId` on the originating command, all derived events carry it (proposal 0001 already does this), saga uses it directly.
3. **Lookup table** — for the rare case where correlation requires a query (e.g., "find the saga managing the order this payment ID belongs to"), `correlate` can be `async`. Documented as the slow path — used sparingly, can dominate runtime.

(2) is the recommended default once 0001 ships, because correlation is automatic.

### 3.7 Saga lifecycle

```
┌──────────┐  startsNewInstance=true   ┌────────┐
│ no inst  │ ────────────────────────► │ active │
└──────────┘                            └────┬───┘
                                             │ react() returns end:true
                                             ▼
                                       ┌───────────┐
                                       │ completed │ (terminal)
                                       └───────────┘

active → failed: react() throws after maxAttempts; instance dead-lettered
                  separately from the underlying event.
```

`completed` and `failed` instances are retained — they're the audit record. A separate retention policy (e.g., delete after 90d) is documented but not built into the framework.

### 3.8 Failure handling

When `react` throws:

1. Same retry path as async projections (release event back to outbox, exponential backoff).
2. After `maxAttempts`, the **event** dead-letters via the existing DLQ flow.
3. The **saga instance** is marked `status = 'failed'` and stops accepting events.
4. Operator can inspect `saga_instances` + `eventfabric.dead_letters` to diagnose.
5. Recovery: operator manually edits state and flips status back to `active`, or starts a fresh instance. No automatic recovery — sagas hold business state, and silent recovery is dangerous.

This is conservative. Stuck sagas are visible (`status='failed'` index). Better than the alternative (silent retry forever).

### 3.9 Schema evolution

State carries `schema_version`. A `SagaStateUpcaster<S>` runs on load if version mismatches the current saga's `version`. Same shape as `EventUpcaster`. Keeps saga refactors viable without a migration sweep.

For event reaction: sagas consume events that already pass through `EventUpcaster` at load time (existing infra). No new mechanism needed.

### 3.10 Observability

Reuses the existing `AsyncRunnerObserver` since sagas run as async projections. Additional saga-specific metrics emitted by the saga wrapper:

- `saga_instances_started{saga_name}`
- `saga_instances_completed{saga_name}`
- `saga_instances_failed{saga_name}`
- `saga_instance_age_seconds{saga_name}` (histogram, sampled at completion)
- `saga_pending_commands_lag_seconds`
- `saga_scheduled_messages_overdue_count` — gauge — number of due-but-not-fired timers; this is the alert.

OTel adapter (`@eventfabric/opentelemetry`) gets a `createSagaObserver()` mirroring the existing async/catch-up wrappers.

## 4. API sketch — banking funds-transfer saga

The current banking example's three catch-up projections collapse into one saga:

```ts
type TransferState = {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  step: "started" | "withdrawn" | "deposited";
};

const fundsTransferSaga: Saga<TransferState, BankingEvent> = {
  name: "FundsTransfer",
  version: 1,

  correlate(env) {
    const e = env.payload;
    if (e.type === "TransactionStarted") return e.transactionId;
    if (e.type === "WithdrawalCompleted") return e.transactionId;
    if (e.type === "DepositCompleted") return e.transactionId;
    return null;
  },

  startsNewInstance(env) {
    return env.payload.type === "TransactionStarted";
  },

  initialState(env) {
    const e = env.payload as TransactionStarted;
    return {
      transferId: e.transactionId,
      fromAccountId: e.fromAccountId,
      toAccountId: e.toAccountId,
      amount: e.amount,
      step: "started",
    };
  },

  react(state, msg, ctx) {
    if ("type" in msg.payload && msg.payload.type === "TransactionStarted") {
      return {
        newState: state,
        commands: [
          buildCommand("WithdrawFromAccount", {
            accountId: state.fromAccountId,
            amount: state.amount,
            transferId: state.transferId,
          }, ctx),
        ],
        schedule: [
          { id: "withdraw-timeout", fireAt: { afterMs: 30_000 },
            message: { type: "$timer", id: "withdraw-timeout", payload: {} } },
        ],
      };
    }

    if ("type" in msg.payload && msg.payload.type === "WithdrawalCompleted") {
      return {
        newState: { ...state, step: "withdrawn" },
        commands: [
          buildCommand("DepositToAccount", {
            accountId: state.toAccountId,
            amount: state.amount,
            transferId: state.transferId,
          }, ctx),
        ],
        cancel: ["withdraw-timeout"],
      };
    }

    if ("type" in msg.payload && msg.payload.type === "DepositCompleted") {
      return {
        newState: { ...state, step: "deposited" },
        commands: [
          buildCommand("CompleteTransaction", { transferId: state.transferId }, ctx),
        ],
        end: true,
      };
    }

    if (msg.type === "$timer" && msg.id === "withdraw-timeout") {
      return {
        newState: state,
        commands: [
          buildCommand("FailTransaction", {
            transferId: state.transferId,
            reason: "Withdrawal timeout",
          }, ctx),
        ],
        end: true,
      };
    }

    return { newState: state };
  },
};
```

This replaces three coordinated catch-up projections with one self-contained state machine. The timeout — currently impossible — is one line.

## 5. Migration & compatibility

- **Zero break.** Sagas are additive. Existing catch-up "process manager" projections keep working.
- **New core exports**: `Saga`, `SagaReaction`, `SagaReactContext`, `ScheduledMessage`, `TimerMessage`, `SagaStateUpcaster`.
- **New postgres exports**: `PgSagaStateStore`, `PgSagaCommandQueue`, `PgSagaTimerStore`, `createSagaRunner`, `createSagaCommandDispatcher`, `createSagaTimerScheduler`.
- **New migrations**: `011_saga_instances.sql`, `012_saga_pending_commands.sql`, `013_saga_scheduled_messages.sql`.
- **Banking example**: a new `examples/banking-api/src/sagas/funds-transfer.saga.ts` demonstrating the rewrite. Old projections retained for comparison; docs note the recommended path.

## 6. Risks & open questions

1. **Long-lived sagas keep growing pending-command rows.** A saga that emits one command per event over months could accumulate millions of `dispatched` rows. Mitigation: the dispatcher should DELETE rows after successful dispatch, not UPDATE. Trade-off: lose audit trail of what commands a saga emitted. Acceptable — the *events* those commands produced are the real audit trail.

2. **Timer fan-out under DB load.** A saga that schedules 1k timers per instance and runs 10k instances → 10M rows. The partial index on `status='pending'` keeps query cost OK, but VACUUM pressure rises. Documented; ops can partition the timer table by `fire_at` if it becomes a problem.

3. **Saga re-entrancy.** What if `react` returns commands AND those commands' resulting events route back to the same saga in the same batch? The runner processes events sequentially per saga instance (the `state_version` lock serializes them) — safe but can stall if a saga produces a tight loop. No automatic cycle detection; documented as a domain bug.

4. **Cross-event ordering.** Two events arriving for the same saga from different aggregates can reach the saga out of order (one outbox row per aggregate). The saga's `react` must tolerate this — reject events that don't fit the current `step`, or buffer them in state. Same constraint as today's catch-up "process manager" approach. Documented prominently.

5. **Async-projection runner contention.** Sagas run alongside other async projections claiming from the same outbox. A slow saga (one that holds a Tx open for 200ms) reduces throughput for other projections. Recommend: dedicated runner instance per saga in production, sharing in dev. The framework supports both — it's a configuration choice.

6. **Distinguishing replay from new delivery.** The runner skips events with `globalPosition <= last_event_pos` (idempotency). But during a re-process of a single event (after a crash mid-Tx), the saga's `react` runs again, which is fine — the whole Tx rolls back if it fails, so partial state is impossible.

7. **CommandBus circular dependency.** The saga runner calls `CommandBus.send` indirectly. If a command handler emits an event that triggers a saga that emits a command, you have a feedback loop. Loop is fine if it's short; pathological if it's not. No automatic detection; documented as a domain concern.

## 7. Phasing

- **Phase 1** — `Saga<S, E>` interface, in-memory `SagaStateStore` and `SagaTimerStore`. Pure-reducer unit tests. No PG yet.
- **Phase 2** — `PgSagaStateStore` + migration 011. Wire to `AsyncProjectionRunner`. End-to-end test: a saga reacting to events from the events table.
- **Phase 3** — `PgSagaCommandQueue` + migration 012 + `SagaCommandDispatcher` worker. Integrates with CommandBus from proposal 0001.
- **Phase 4** — `PgSagaTimerStore` + migration 013 + `SagaTimerScheduler` worker.
- **Phase 5** — Banking example rewrite; OTel `createSagaObserver`; ops docs.

Phase 1 is independently shippable for testing the API shape. Phases 2–4 must ship together — a saga without commands or timers isn't useful. Phase 5 is documentation/polish.

## 8. Open design questions worth a call

The proposal makes default choices on these; flag them if you disagree:

1. **State model**: snapshot-only by default. Event-sourced sagas deferred to 0002b. (See §3.2.)
2. **Failure recovery**: stuck sagas require manual intervention. No auto-retry of `failed` instances. (See §3.8.)
3. **Command dispatch indirection**: separate `saga_pending_commands` table + dispatcher, not direct CommandBus call. (See §3.4.)
4. **Timer granularity**: 1s minimum poll. Sub-second use cases pushed to a different mechanism. (See §3.5.)

## 9. Out of scope, tracked elsewhere

- Event-sourced sagas → proposal 0002b (deferred until demand emerges).
- Cross-tenant orchestration → not planned.
- Visual saga inspector / state-machine diagram tooling → ops concern, not framework.
- Sub-second timers → would require a separate scheduler design (probably in-memory).
