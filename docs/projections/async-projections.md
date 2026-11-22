# Async Projections

Async projections consume events through a transactional outbox. Events are enqueued atomically with the write, then claimed by a background runner that delivers them to projection handlers with at-least-once guarantees, per-message retry, dead-letter support, and topic-based routing.

This tier is for **per-message outbox delivery with topic routing**.

> **For projections, prefer the [Projection Daemon](./projection-daemon.md).** It reads the event log with a checkpoint per projection, so it can back-fill new projections, rebuild them, and run projections on separate nodes that each see every event. The outbox runner delivers each row once, to whichever runner claims it, and the row is gone afterwards.

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
| `name` | `string` | Unique identifier, used in logs, metrics and traces. |
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
    checkpoints: ProjectionCheckpointStore<TTx> | undefined, // deprecated, ignored
    projections: AsyncProjection<E, TTx>[],
    opts: AsyncRunnerOptions
  ) {}

  async start(signal: AbortSignal): Promise<void>;
}
```

### Delivery tracking

The outbox row is the only record of whether an event still has to be delivered. The runner deletes (acks) a row in the same transaction as the handlers that processed it, so a committed handler run and a deleted row always go together. If the transaction rolls back, the row stays and is retried.

The runner does **not** use projection checkpoints. Global positions are allocated when an event is inserted, not when its transaction commits, so a rule like "position at or below the checkpoint means already handled" would silently drop:

- events whose transaction commits after a higher position was already processed,
- rows requeued from the DLQ, and
- rows processed out of order by concurrent workers.

Delivery is at least once. A row can be handled more than once, for example when its lock expires (`leaseMs`) while a slow worker is still processing it, or when a requeued event had in fact succeeded. Handlers must be idempotent.

The `checkpoints` constructor argument is deprecated and ignored; `createAsyncProjectionRunner` no longer passes one.

### `start(signal)`

Enters an infinite poll loop:

1. Claim a batch of outbox rows (locked with `FOR UPDATE SKIP LOCKED`).
2. If the batch is empty, sleep for `idleSleepMs` and try again.
3. Process each row according to the configured `transactionMode`.
4. On success, acknowledge (delete) the outbox row, in the same transaction as the handlers.
5. On failure, release the row (unlock; `attempts` was already incremented when the row was claimed) or dead-letter it.
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
  leaseMs?: number;
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
| `leaseMs` | 300000 (5 min) | How long a claimed row stays locked before another worker may reclaim it. Recovers rows held by a crashed worker. Must exceed the worst-case time to process one batch. |
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
- A poison message (one that always fails) fails the entire batch on every attempt. The next poll claims the same rows again (`ORDER BY id`), so its siblings keep failing alongside it until every row in the batch reaches `maxAttempts` and is dead-lettered, siblings included. Use `"perRow"` if a single bad message must not take its neighbours with it.

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
| Mixed: some handlers are external, some internal | Two runners **with disjoint `claimTopic`s** (each row goes to only one runner), or the [Projection Daemon](./projection-daemon.md) for the internal ones |

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
    AND (
      locked_at IS NULL
      OR ($4::bigint IS NOT NULL AND locked_at < now() - $4::bigint * interval '1 millisecond')
    )
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

- **Non-blocking.** `SKIP LOCKED` skips rows already locked by another worker. Several replicas of the **same** runner can poll concurrently. Runners with **different** projections must not share rows: each row is delivered to whichever runner claims it, so split them with `claimTopic`.
- **Atomic lock + increment.** The `UPDATE` sets `locked_at`, `locked_by`, and increments `attempts` in one statement.
- **Lease.** `$4` is the runner's `leaseMs`. A row whose lock is older than the lease is treated as abandoned (its worker crashed or lost its connection after claiming) and can be claimed again. Choose a lease well above the worst-case time to process one batch; otherwise a slow-but-alive worker's rows can be reclaimed and processed twice.
- **Roughly ordered.** Rows are claimed in `id` order, i.e. the order they were **inserted**, not the order their transactions committed. With several replicas, or after a release or retry, events can also be handled out of order. Do not rely on outbox order across streams.

## Ack, release, and dead-letter

After processing, each outbox row follows one of three paths:

| Outcome | Method | Effect |
|---------|--------|--------|
| **Success** | `ack(tx, id)` | Deletes the row from the outbox. |
| **Failure (retryable)** | `releaseWithError(tx, id, error)` | Clears `locked_at` and `locked_by`, stores the error in `last_error`. The row becomes claimable again. |
| **Not attempted** (runner stopped, or an earlier row in a `perRow` batch failed) | `release(tx, ids)` | Clears the lock and undoes the claim's `attempts` increment, so the row is claimable again without counting towards `maxAttempts`. |
| **Event missing** (no event at the row's `global_position`) | `deadLetter(tx, row, reason)` | Dead-lettered with reason `Event not found for globalPosition=…`, in both transaction modes. |
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

The factory wires up `PgUnitOfWork` and `PgOutboxStore` for you.

## Related docs

- [Projections Overview](./overview.md) -- the three projection tiers and decision matrix
- [Projection Daemon](./projection-daemon.md) -- the recommended way to run asynchronous projections
- [Inline Projections](./inline-projections.md) -- strong consistency inside the write transaction
- [Catch-Up Projections](./catch-up-projections.md) -- eventual consistency via checkpoint
- [Single-Event Projections](./single-event-projections.md) -- narrowing to a single event type
- [Outbox and DLQ](../outbox-and-dlq.md) -- transactional outbox pattern, claim mechanism, DLQ management
- [Observability](../observability.md) -- `AsyncRunnerObserver` hooks and the OpenTelemetry adapter
