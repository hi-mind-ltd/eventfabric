# Async Projections

Async projections consume events through a transactional outbox. Events are enqueued atomically with the write, then claimed by a background runner that delivers them to projection handlers with at-least-once guarantees, per-message retry, dead-letter support, and topic-based routing.

This tier is designed for **external side effects** -- sending emails, calling webhooks, publishing to message brokers -- where you need reliable delivery and graceful failure handling.

For an overview of all projection tiers, see [Projections Overview](./overview.md).

## Core interface

```typescript
// @eventfabric/core

export interface AsyncProjection<E extends AnyEvent, TTx extends Transaction = Transaction> {
  name: string;
  topicFilter?: TopicFilter;
  routes?: readonly string[];
  handle(tx: TTx, env: EventEnvelope<E>): Promise<void>;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique identifier. Used as the checkpoint key in `eventfabric.projection_checkpoints`. |
| `topicFilter` | `TopicFilter` (optional) | Controls which outbox messages this projection sees. See [Topic filtering](#topic-filtering). |
| `routes` | `readonly string[]` (optional) | Adapter-specific routing. For Kafka: topic names. For queues: queue names. Outbox adapter uses `topicFilter` instead. |
| `handle` | `(tx, env) => Promise<void>` | Called once per event. Must be **idempotent** (safe to retry). |

## AsyncProjectionRunner

The `AsyncProjectionRunner` is the core orchestration engine. It polls the outbox, claims batches, dispatches events to matching projections, and handles ack/release/dead-letter lifecycle.

```typescript
// @eventfabric/core

export class AsyncProjectionRunner<E extends AnyEvent, TTx extends Transaction = Transaction> {
  constructor(
    uow: UnitOfWork<TTx>,
    eventStore: EventStore<E, TTx>,
    outbox: OutboxStore<TTx>,
    checkpoints: ProjectionCheckpointStore<TTx>,
    projections: AsyncProjection<E, TTx>[],
    opts: AsyncRunnerOptions
  ) {}

  async start(signal: AbortSignal): Promise<void>;
}
```

### `start(signal)`

Enters an infinite poll loop:

1. Claim a batch of outbox rows (locked with `FOR UPDATE SKIP LOCKED`).
2. If the batch is empty, sleep for `idleSleepMs` and try again.
3. Process each row according to the configured `transactionMode`.
4. On success, acknowledge (delete) the outbox row.
5. On failure, release the row (unlock + increment attempts) or dead-letter it.
6. Repeat until `signal` is aborted.

The loop is abort-aware: pass an `AbortSignal` from an `AbortController` and abort it on `SIGINT`/`SIGTERM` for graceful shutdown.

## AsyncRunnerOptions

```typescript
export type AsyncRunnerOptions = {
  workerId: string;
  batchSize?: number;
  idleSleepMs?: number;
  claimTopic?: string | null;
  includeDismissed?: boolean;
  maxAttempts?: number;
  transactionMode?: "batch" | "perRow";
  backoff?: BackoffOptions;
  observer?: AsyncRunnerObserver;
};
```

| Option | Default | Description |
|--------|---------|-------------|
| `workerId` | *required* | Identifies this runner instance in logs, metrics, and lock ownership. |
| `batchSize` | 100 | Number of outbox rows claimed per poll cycle. |
| `idleSleepMs` | 500 | Milliseconds to sleep when the outbox is empty. |
| `claimTopic` | `null` | If set, only claim rows matching this topic. `null` claims all topics. |
| `includeDismissed` | `false` | Whether to process events that have been dismissed. |
| `maxAttempts` | 10 | After this many failed attempts, the message is dead-lettered. |
| `transactionMode` | `"batch"` | How to group processing into transactions. See below. |
| `backoff` | `{ minMs: 250, maxMs: 15000, factor: 2, jitter: 0.2 }` | Exponential backoff between runner-level retries after unrecoverable errors. |
| `observer` | `undefined` | Hooks for tracing and metrics. See [Observability](../observability.md). |

## Transaction modes

The `transactionMode` option controls how the runner groups event processing into database transactions. This is one of the most important configuration decisions for async projections.

### `"batch"` mode (default)

All claimed rows are processed in a **single transaction**. If all handlers succeed, the transaction commits and all rows are acknowledged. If any handler fails, the transaction rolls back and all rows are released in a fresh transaction.

```
┌─────────────────────────────────────────────┐
│ BEGIN                                       │
│   process(row1) -> OK                       │
│   process(row2) -> OK                       │
│   process(row3) -> FAIL                     │
│ ROLLBACK                                    │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ BEGIN  (fresh tx)                           │
│   releaseWithError(row1)                    │
│   releaseWithError(row2)                    │
│   releaseWithError(row3)                    │
│ COMMIT                                      │
└─────────────────────────────────────────────┘
```

**Benefits:**
- Lower overhead: one transaction per batch instead of one per row.
- All-or-nothing semantics.

**Risks:**
- A poison message (one that always fails) temporarily affects the entire batch. On the next poll, the batch will be different (due to `SKIP LOCKED`), so the poison message will eventually isolate itself.

**Best for:** High-throughput idempotent handlers where all processing is database work.

### `"perRow"` mode

Each row is processed in its **own transaction**. If one handler fails, only that row is released. Other rows in the batch continue processing normally.

```
┌────────────────────────┐   ┌────────────────────────┐
│ BEGIN                  │   │ BEGIN                  │
│   process(row1) -> OK  │   │   process(row2) -> OK  │
│   ack(row1)            │   │   ack(row2)            │
│ COMMIT                 │   │ COMMIT                 │
└────────────────────────┘   └────────────────────────┘
┌────────────────────────────────┐
│ BEGIN                          │
│   process(row3) -> FAIL        │
│ ROLLBACK                       │
└────────────────────────────────┘
┌────────────────────────────────┐
│ BEGIN  (fresh tx)              │
│   releaseWithError(row3)       │
│ COMMIT                         │
└────────────────────────────────┘
```

**Benefits:**
- Failure isolation: a poison message affects only itself.
- Safer for external side effects that cannot be rolled back.

**Risks:**
- Higher overhead: one transaction per row.
- A partially processed batch means some rows are acked and some are released.

**Best for:** Handlers that call external services (email, webhooks, HTTP APIs) where you need per-message failure isolation.

### When to use which

| Scenario | Recommended mode |
|----------|-----------------|
| Updating read model tables (idempotent SQL) | `"batch"` |
| High-throughput internal processing | `"batch"` |
| Sending emails | `"perRow"` |
| Calling webhooks / external APIs | `"perRow"` |
| Publishing to a message broker | `"perRow"` |
| Mixed: some handlers are external, some internal | Run two separate runners |

## Topic filtering

The `TopicFilter` type controls which outbox messages a projection receives:

```typescript
export type TopicFilter =
  | { mode: "all" }                          // Process all topics
  | { mode: "include"; topics: string[] }    // Only these topics
  | { mode: "exclude"; topics: string[] };   // Everything except these topics
```

The `matchesTopic` function evaluates the filter:

```typescript
import { matchesTopic } from "@eventfabric/core";

matchesTopic({ mode: "all" }, "account");           // true
matchesTopic({ mode: "include", topics: ["account"] }, "account");  // true
matchesTopic({ mode: "include", topics: ["account"] }, "audit");    // false
matchesTopic({ mode: "exclude", topics: ["audit"] }, "account");    // true
matchesTopic({ mode: "exclude", topics: ["audit"] }, "audit");      // false
matchesTopic(undefined, "anything");                 // true (defaults to "all")
```

Topic filtering composes with the runner's `claimTopic` option. The runner claims rows matching `claimTopic` from the outbox, then each projection's `topicFilter` narrows further inside the runner.

## Claim/lock mechanism

The outbox uses PostgreSQL's `FOR UPDATE SKIP LOCKED` for concurrent claim processing:

```sql
WITH cte AS (
  SELECT id
  FROM eventfabric.outbox
  WHERE dead_lettered_at IS NULL
    AND locked_at IS NULL
    AND ($3::text IS NULL OR topic = $3)
  ORDER BY id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE eventfabric.outbox o
SET locked_at = now(),
    locked_by = $2,
    attempts = attempts + 1
FROM cte
WHERE o.id = cte.id
RETURNING o.id, o.global_position, o.topic, o.attempts
```

Key properties:

- **Non-blocking.** `SKIP LOCKED` skips rows already locked by another worker. Multiple runners can poll concurrently without deadlocks.
- **Atomic lock + increment.** The `UPDATE` sets `locked_at`, `locked_by`, and increments `attempts` in one statement.
- **Ordered.** Rows are claimed in `id` order, preserving insertion order within a topic.

## Ack, release, and dead-letter

After processing, each outbox row follows one of three paths:

| Outcome | Method | Effect |
|---------|--------|--------|
| **Success** | `ack(tx, id)` | Deletes the row from the outbox. |
| **Failure (retryable)** | `releaseWithError(tx, id, error)` | Clears `locked_at` and `locked_by`, stores the error in `last_error`. The row becomes claimable again. |
| **Failure (exceeded max attempts)** | `deadLetter(tx, row, reason)` | Copies the row to `eventfabric.outbox_dead_letters`, then deletes it from the active outbox. |

The dead-letter check happens at claim time: if `row.attempts > maxAttempts`, the runner dead-letters the message immediately instead of attempting to process it again.

## Backoff strategy

The runner uses exponential backoff with jitter for runner-level errors (e.g., database connection failures):

```typescript
export type BackoffOptions = {
  minMs: number;   // Minimum delay
  maxMs: number;   // Maximum delay (cap)
  factor: number;  // Exponential growth factor
  jitter: number;  // Random jitter factor (0-1)
};

// Default: { minMs: 250, maxMs: 15000, factor: 2, jitter: 0.2 }
```

The formula: `base = min(maxMs, minMs * factor^attempt)`, then apply jitter: `delay = base + base * jitter * random(-1, 1)`.

This prevents thundering-herd problems when multiple runners recover from the same database outage simultaneously.

## Example: email notification projection

From the banking-api example -- an async projection that sends email notifications for banking transactions:

```typescript
import type { AsyncProjection, EventEnvelope } from "@eventfabric/core";
import type { PgTx } from "@eventfabric/postgres";
import type { BankingEvent } from "./domain/events";

export const emailNotificationProjection: AsyncProjection<BankingEvent, PgTx> = {
  name: "email-notifications",
  topicFilter: {
    mode: "include",
    topics: ["transaction", "account"]
  },
  async handle(tx: PgTx, env: EventEnvelope<BankingEvent>) {
    const event = env.payload;

    if (event.type === "TransactionCompleted") {
      await emailService.sendEmail(
        `customer-${event.fromAccountId}@example.com`,
        "Transaction Completed",
        `Your transfer of $${event.amount} to account ${event.toAccountId} has been completed.`
      );
    }

    if (event.type === "AccountDeposited") {
      await emailService.sendEmail(
        `customer-${event.accountId}@example.com`,
        "Deposit Confirmed",
        `Your account has been credited with $${event.amount}. New balance: $${event.balance}`
      );
    }
  }
};
```

Wire it up with a runner:

```typescript
import { createAsyncProjectionRunner } from "@eventfabric/postgres";

const emailRunner = createAsyncProjectionRunner(pool, store, [emailNotificationProjection], {
  workerId: "email-worker-1",
  batchSize: 10,
  idleSleepMs: 1000,
  maxAttempts: 5,
  transactionMode: "perRow",  // perRow because email is an external side effect
  backoff: { minMs: 100, maxMs: 5000, factor: 2, jitter: 0.1 }
});

const abortController = new AbortController();
emailRunner.start(abortController.signal).catch(console.error);

process.on("SIGINT", () => abortController.abort());
```

Note `transactionMode: "perRow"` -- because sending an email is an external side effect that cannot be rolled back, we process each message in its own transaction. If one email fails, the others are unaffected.

## Creating an async runner (PostgreSQL)

Use the factory function from `@eventfabric/postgres`:

```typescript
import { createAsyncProjectionRunner, PgEventStore } from "@eventfabric/postgres";
import { Pool } from "pg";
import type { BankingEvent } from "./domain/events";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PgEventStore<BankingEvent>();

const runner = createAsyncProjectionRunner(pool, store, [projection1, projection2], {
  workerId: "worker-1",
  batchSize: 50,
  transactionMode: "batch"
});
```

The factory wires up `PgUnitOfWork`, `PgOutboxStore`, and `PgProjectionCheckpointStore` for you.

## Related docs

- [Projections Overview](./overview.md) -- the three projection tiers and decision matrix
- [Inline Projections](./inline-projections.md) -- strong consistency inside the write transaction
- [Catch-Up Projections](./catch-up-projections.md) -- eventual consistency via checkpoint
- [Single-Event Projections](./single-event-projections.md) -- narrowing to a single event type
- [Outbox and DLQ](../outbox-and-dlq.md) -- transactional outbox pattern, claim mechanism, DLQ management
- [Observability](../observability.md) -- `AsyncRunnerObserver` hooks and the OpenTelemetry adapter
