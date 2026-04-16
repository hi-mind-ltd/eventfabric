# Projections in EventFabric

## What are projections?

In event sourcing, the event log is the system of record. Every state change is captured as an immutable event, and the current state of any aggregate can always be reconstructed by replaying its events from the beginning.

But reading state by replaying events is expensive for queries. A projection transforms events into a read-optimized data structure -- a **read model** -- that can answer queries directly without replaying the full event history. Projections are the bridge between the write side (append-only event log) and the read side (query-friendly tables, caches, or search indexes).

For an in-depth treatment, see [Projections in Event Sourcing](https://www.eventstore.com/blog/projections-in-event-sourcing) on the Event Store blog.

## Why read models exist

Event sourcing separates the write model (the event log) from the read model (the projection). This separation -- the core of the [CQRS pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs) -- lets you optimize reads and writes independently:

- **Write side**: Append events to an immutable log. Optimized for throughput and conflict detection.
- **Read side**: Maintain one or more pre-computed views. Optimized for the exact queries your application needs.

A single event stream can feed many projections. An `AccountDeposited` event might update an `account_read` table for balance queries, feed an audit log for compliance, and trigger a notification email -- each through a different projection with its own lifecycle and consistency guarantee.

For the foundational thinking behind this pattern, see Martin Fowler's [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) article.

## The three tiers of projections

EventFabric organizes projections into three tiers, each with different consistency guarantees and operational characteristics:

| Tier | Consistency | Mechanism | Latency impact | Use case |
|------|------------|-----------|----------------|----------|
| **Inline** | Strong (same transaction) | Runs inside the write transaction via `InlineProjector` | Adds write latency | Read models that must never be stale (balances, inventory counts) |
| **Catch-up** | Eventual (checkpoint-based) | Reads forward from `eventfabric.projection_checkpoints` | None on writes; projection lag depends on polling interval | Process managers, internal state machines, audit logs |
| **Async (outbox)** | Eventual (outbox-based) | Claims rows from `eventfabric.outbox` with `FOR UPDATE SKIP LOCKED` | None on writes; delivery lag depends on polling + processing | External side effects: email, webhooks, third-party API calls |

### Inline projections

Inline projections run inside the same database transaction that appends events. If the projection fails, the entire write rolls back. This guarantees that the read model is always consistent with the event log -- at the cost of increased write latency.

See [Inline Projections](./inline-projections.md) for the full API.

### Catch-up projections

Catch-up projections read events forward from the global event log, starting from their last checkpoint. They run outside the write transaction and are eventually consistent. Each projection tracks its own checkpoint in `eventfabric.projection_checkpoints`, so projections compose independently -- adding a new one doesn't affect existing ones.

See [Catch-Up Projections](./catch-up-projections.md) for the full API.

### Async (outbox) projections

Async projections consume events from a transactional outbox. Events are enqueued atomically with the write, then claimed by a background runner. This tier adds topic filtering, per-message retry, dead-letter queuing, and backoff -- everything needed for reliable delivery of external side effects.

See [Async Projections](./async-projections.md) for the full API.

## Decision matrix

Use this matrix to pick the right tier for your projection:

| Question | Inline | Catch-up | Async (outbox) |
|----------|--------|----------|----------------|
| Must the read model be consistent with the write? | Yes | No | No |
| Does it call external services (email, HTTP, queues)? | No | No | Yes |
| Does it need per-message retry and dead-letter? | No | No | Yes |
| Does it need topic-based routing? | No | No | Yes |
| Is write latency critical? | Avoid | Preferred | Preferred |
| Is it a process manager (reacts to events, emits more events)? | No | Yes | Possible but catch-up is simpler |
| Should it survive application restarts? | N/A (transactional) | Yes (checkpoint) | Yes (outbox + checkpoint) |

**Rules of thumb:**

1. Start with **catch-up** for internal projections. It is the simplest model and has no outbox overhead.
2. Use **inline** only when stale reads are unacceptable and you can tolerate the write-latency cost.
3. Use **async/outbox** when you need to deliver events to external systems with at-least-once guarantees.

## How projections compose

Projections in EventFabric are independent. Each projection:

- Has its own **name** (used as the checkpoint key).
- Tracks its own **checkpoint** (the last processed `globalPosition`).
- Decides independently which events it cares about (via event-type checks or topic filters).

This means you can freely add, remove, or rebuild projections without affecting others. The `CatchUpProjector.catchUpAll()` method runs an array of projections sequentially -- each advances its own checkpoint:

```typescript
import { createCatchUpProjector } from "@eventfabric/postgres";
import type { BankingEvent } from "./domain/events";

const projector = createCatchUpProjector<BankingEvent>(pool, store);

// Each projection tracks its own checkpoint independently
await projector.catchUpAll([
  withdrawalProjection,   // checkpoint: "withdrawal-handler"
  depositProjection,      // checkpoint: "deposit-handler"
  completionProjection,   // checkpoint: "transaction-completion-handler"
  depositAuditProjection  // checkpoint: "deposit-audit"
], { batchSize: 100 });
```

Similarly, async projections compose through topic filtering -- different projections can subscribe to different topics on the same outbox runner, or run on separate runners entirely.

For narrowing a projection to a single event type, see [Single-Event Projections](./single-event-projections.md).

## Further reading

- [Inline Projections](./inline-projections.md) -- strong consistency inside the write transaction
- [Catch-Up Projections](./catch-up-projections.md) -- eventual consistency via checkpoint tracking
- [Async Projections](./async-projections.md) -- eventual consistency via transactional outbox
- [Single-Event Projections](./single-event-projections.md) -- narrowing to a single event type
- [Outbox and DLQ](../outbox-and-dlq.md) -- transactional outbox pattern, dead-letter queue
- [Observability](../observability.md) -- monitoring projection runners with OpenTelemetry
- [Martin Fowler: Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Microsoft: CQRS Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)
- [Event Store Blog: Projections in Event Sourcing](https://www.eventstore.com/blog/projections-in-event-sourcing)
