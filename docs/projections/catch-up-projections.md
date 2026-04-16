# Catch-Up Projections

Catch-up projections read events forward from the global event log, starting from their last saved checkpoint. They run **outside** the write transaction and are eventually consistent. Each projection tracks its own position in `eventfabric.projection_checkpoints`, so projections compose independently -- adding a new one doesn't affect existing ones.

For an overview of all projection tiers, see [Projections Overview](./overview.md).

## Core interface

```typescript
// @eventfabric/core

export interface CatchUpProjection<E extends AnyEvent, TTx extends Transaction = Transaction> {
  name: string;
  handle(tx: TTx, env: EventEnvelope<E>): Promise<void>;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique identifier. Used as the key in `eventfabric.projection_checkpoints`. |
| `handle` | `(tx, env) => Promise<void>` | Called once per event envelope. Must be **idempotent** (safe to retry). |

The `name` is critical: it is the checkpoint key. If you rename a projection, it starts over from global position 0. If two projections share a name, they corrupt each other's checkpoint.

## CatchUpProjector class

The `CatchUpProjector` is the core orchestration engine. It is database-agnostic and composes three interfaces:

```typescript
// @eventfabric/core

export class CatchUpProjector<E extends AnyEvent, TTx extends Transaction = Transaction> {
  constructor(
    private readonly uow: UnitOfWork<TTx>,
    private readonly eventStore: EventStore<E, TTx>,
    private readonly checkpoints: ProjectionCheckpointStore<TTx>
  ) {}

  async catchUpProjection(
    projection: CatchUpProjection<E, TTx>,
    options?: CatchUpOptions
  ): Promise<void>;

  async catchUpAll(
    projections: CatchUpProjection<E, TTx>[],
    options?: CatchUpOptions
  ): Promise<void>;
}
```

### `catchUpProjection(projection, options?)`

Processes a single projection from its last checkpoint to the end of the event log. Loads events in batches, calls `projection.handle()` for each one (inside a transaction), then advances the checkpoint to the last processed position. Repeats until there are no more events.

### `catchUpAll(projections, options?)`

Runs `catchUpProjection` for each projection in the array, **sequentially**. Each projection has its own checkpoint, so they process events independently.

## CatchUpOptions

```typescript
export type CatchUpOptions = {
  batchSize?: number;        // Events per batch. Default: 500.
  maxBatches?: number;       // Stop after this many batches. Default: unlimited.
  includeDismissed?: boolean; // Process dismissed events? Default: false.
  observer?: CatchUpProjectorObserver; // Observability hooks. See observability docs.
};
```

| Option | Default | Description |
|--------|---------|-------------|
| `batchSize` | 500 | Number of events loaded per iteration. Larger batches reduce round-trips but hold transactions longer. |
| `maxBatches` | unlimited | Cap the number of batches per `catchUpProjection` call. Useful for testing or rate-limiting. |
| `includeDismissed` | `false` | Whether to include events that have been dismissed (soft-deleted). |
| `observer` | `undefined` | Hooks for tracing and metrics. See [Observability](../observability.md). |

## Checkpoint tracking

Checkpoints are stored in the `eventfabric.projection_checkpoints` table:

```sql
CREATE TABLE eventfabric.projection_checkpoints (
  projection_name TEXT PRIMARY KEY,
  last_global_position BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The `PgProjectionCheckpointStore` implements the `ProjectionCheckpointStore` interface:

- **`get(tx, projectionName)`**: Returns the checkpoint, creating one at position 0 if it doesn't exist (using `INSERT ... ON CONFLICT DO NOTHING`).
- **`set(tx, projectionName, lastGlobalPosition)`**: Updates the checkpoint only if the new position is greater than or equal to the current one. This prevents accidental backwards movement.

Both operations run inside the same transaction as the event processing, so the checkpoint and the projection's side effects are atomic.

## Creating a catch-up projector (PostgreSQL)

Use the factory function from `@eventfabric/postgres`:

```typescript
import { createCatchUpProjector, PgEventStore } from "@eventfabric/postgres";
import { Pool } from "pg";
import type { BankingEvent } from "./domain/events";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PgEventStore<BankingEvent>();
const projector = createCatchUpProjector<BankingEvent>(pool, store);
```

The factory wires up `PgUnitOfWork`, `PgEventStore`, and `PgProjectionCheckpointStore` for you.

## Polling loop pattern

Catch-up projections need a polling loop that repeatedly calls `catchUpAll` and sleeps when there's nothing to process. The standard pattern uses an async IIFE with the `sleep` utility:

```typescript
import { createCatchUpProjector } from "@eventfabric/postgres";
import { sleep } from "@eventfabric/core";
import type { BankingEvent } from "./domain/events";

const projector = createCatchUpProjector<BankingEvent>(pool, store);
const abortController = new AbortController();

const catchUpProjections = [
  withdrawalProjection,
  depositProjection,
  completionProjection,
  depositAuditProjection
];

// Background polling loop
(async () => {
  const idleMs = 500;
  while (!abortController.signal.aborted) {
    try {
      await projector.catchUpAll(catchUpProjections, { batchSize: 100 });
    } catch (err) {
      console.error("Catch-up projector error:", err);
    }
    try {
      await sleep(idleMs, abortController.signal);
    } catch {
      // AbortError on shutdown -- fall through and exit the loop
      break;
    }
  }
})();

// Graceful shutdown
process.on("SIGINT", () => {
  abortController.abort();
  pool.end();
});
```

Key points:

- `sleep(ms, signal)` is abort-aware. When the `AbortController` fires, `sleep` throws an `AbortError` that breaks the loop.
- Errors in `catchUpAll` are caught and logged, but the loop continues. This makes the projector resilient to transient failures.
- `catchUpAll` runs projections sequentially. If you need parallel processing, run separate polling loops for different projection groups.

## Process manager pattern

Catch-up projections are the natural home for **process managers** -- projections that react to events and emit follow-up events, forming a chain of state transitions.

The banking-api example implements a transfer chain as a process manager with three catch-up projections:

```
TransactionStarted  --> [withdrawal-handler]  --> AccountWithdrawn + WithdrawalCompleted
WithdrawalCompleted --> [deposit-handler]      --> AccountDeposited + DepositCompleted
DepositCompleted    --> [transaction-completion-handler] --> TransactionCompleted
```

Each step loads the relevant aggregate, applies a domain operation, and appends the resulting events. The next step picks up those events on its next catch-up tick.

### Withdrawal handler

```typescript
import type { CatchUpProjection, EventEnvelope } from "@eventfabric/core";
import type { PgTx } from "@eventfabric/postgres";
import { PgEventStore } from "@eventfabric/postgres";
import type { BankingEvent } from "./domain/events";
import { AccountAggregate } from "./domain/account.aggregate";

export function createWithdrawalProjection(
  eventStore: PgEventStore<BankingEvent>
): CatchUpProjection<BankingEvent, PgTx> {
  return {
    name: "withdrawal-handler",
    async handle(tx: PgTx, env: EventEnvelope<BankingEvent>) {
      const event = env.payload;
      if (event.type !== "TransactionStarted") return;

      // Load source account and perform withdrawal
      const history = await eventStore.loadStream(tx, event.fromAccountId, AccountAggregate);
      const account = new AccountAggregate(event.fromAccountId);
      account.loadFromHistory(
        history.map((h) => ({ payload: h.payload, aggregateVersion: h.aggregateVersion }))
      );

      account.withdraw(event.amount, event.transactionId);
      const newBalance = account.balance;

      // Persist the withdrawal
      const withdrawalEvents = account.pullPendingEvents();
      if (withdrawalEvents.length > 0) {
        const result = await eventStore.append(tx, {
          aggregateName: "Account",
          aggregateId: account.id,
          expectedAggregateVersion: account.version,
          events: withdrawalEvents
        });
        account.version = result.nextAggregateVersion;
      }

      // Emit WithdrawalCompleted for the next step
      await eventStore.append(tx, {
        aggregateName: "Account",
        aggregateId: account.id,
        expectedAggregateVersion: account.version,
        events: [{
          type: "WithdrawalCompleted",
          version: 1,
          accountId: event.fromAccountId,
          transactionId: event.transactionId,
          amount: event.amount,
          balance: newBalance,
          completedAt: new Date().toISOString()
        }]
      });
    }
  };
}
```

### Why catch-up (not outbox) for process managers

The transfer chain is a series of **internal state transitions** -- events trigger domain logic that produces more events. There are no external side effects (no HTTP calls, no emails).

Catch-up projections are the better fit because:

- **No outbox overhead.** No extra row per event in the outbox table.
- **No topic routing.** Each projection simply checks `event.type` and returns early for events it doesn't care about. The checkpoint still advances.
- **Simpler failure model.** If a handler fails, the transaction rolls back and the checkpoint doesn't advance. The next catch-up tick retries from the same position.

Use the outbox/async tier when you need **external delivery** with at-least-once guarantees, per-message retry, and dead-letter support. See [Async Projections](./async-projections.md) and [Outbox and DLQ](../outbox-and-dlq.md).

## When to use catch-up vs outbox

| Criterion | Catch-up | Outbox (async) |
|-----------|----------|----------------|
| Internal state transitions | Preferred | Possible but heavier |
| External side effects (email, webhook) | Not recommended | Preferred |
| Per-message retry & DLQ | Not built-in | Built-in |
| Topic-based routing | Not built-in | Built-in |
| Overhead per event | None (reads from events table) | One outbox row per event |
| Process managers | Natural fit | Possible but catch-up is simpler |

## Related docs

- [Projections Overview](./overview.md) -- the three projection tiers and decision matrix
- [Inline Projections](./inline-projections.md) -- strong consistency inside the write transaction
- [Async Projections](./async-projections.md) -- eventual consistency via outbox
- [Single-Event Projections](./single-event-projections.md) -- narrowing to a single event type with `forEventType`
- [Observability](../observability.md) -- `CatchUpProjectorObserver` hooks and the OpenTelemetry adapter
- [Outbox and DLQ](../outbox-and-dlq.md) -- when external delivery requires the outbox pattern
