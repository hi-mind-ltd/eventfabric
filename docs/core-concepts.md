# Core Concepts

This document explains the ideas behind EventFabric and why the library is
shaped the way it is. If you are already comfortable with event sourcing and
CQRS, skim the headers and jump to the sections that are new to you.

## Event sourcing

> "Capture all changes to an application state as a sequence of events."
> -- [Martin Fowler, Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)

Traditional applications store the **current state** in a database row and
overwrite it with every mutation. Event sourcing flips this around: you store
the sequence of **domain events** that caused the state to change, and derive
the current state by replaying them.

```
Traditional:  UPDATE accounts SET balance = 750 WHERE id = 'acc-1';
Event sourced: INSERT INTO events (payload) VALUES ('AccountDeposited { amount: 250, balance: 750 }');
```

Because events are immutable and append-only, you get a complete audit trail for
free, the ability to rebuild state at any point in time, and a natural
integration boundary -- downstream systems subscribe to the same event stream
rather than polling your database.

### Events are the source of truth

In EventFabric the `eventfabric.events` table is the single source of truth.
Everything else -- read models, snapshots, projections -- is derived from it and
can be rebuilt at any time.

```typescript
// An event is a plain object with a type discriminator and a literal version.
export type AccountDepositedV1 = {
  type: "AccountDeposited";
  version: 1;
  accountId: string;
  amount: number;
  balance: number;
};
```

See [Events](./events.md) for naming conventions, discriminated unions, and the
full `EventEnvelope` type.

## Aggregates as consistency boundaries

> "A cluster of domain objects that can be treated as a single unit."
> -- [Martin Fowler, DDD Aggregate](https://martinfowler.com/bliki/DDD_Aggregate.html)

An aggregate is a consistency boundary. All business rules that must hold
**transactionally** live inside the aggregate. EventFabric enforces this by
requiring every event to belong to exactly one aggregate stream, identified by
`(aggregateName, aggregateId)`.

```typescript
export class AccountAggregate extends AggregateRoot<AccountState, AccountEvent> {
  static readonly aggregateName = "Account" as const;

  withdraw(amount: number) {
    // Business rule: balance must not go negative.
    if (this.state.balance < amount) {
      throw new Error("Insufficient funds");
    }
    this.raise({
      type: "AccountWithdrawn",
      version: 1,
      accountId: this.id,
      amount,
      balance: this.state.balance - amount,
    });
  }
}
```

The optimistic concurrency check in `PgEventStore.append()` guarantees that two
concurrent commands targeting the same aggregate will not silently overwrite each
other -- one will succeed and the other will receive a `ConcurrencyError`.

See [Aggregates](./aggregates.md) for the full `AggregateRoot` API and
[Event Store](./event-store.md) for concurrency mechanics.

## CQRS -- separating reads from writes

> [CQRS (Command Query Responsibility Segregation)](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)
> uses separate models for reading and writing data.

EventFabric's write model is the aggregate + event store. Its read model is
whatever projection or query you build on top. This separation matters because:

1. **Write-side optimisation** -- Aggregates load only their own stream. They
   never join across aggregates.
2. **Read-side optimisation** -- Projections denormalise events into flat tables,
   caches, or search indices shaped exactly for the query at hand.
3. **Independent scaling** -- The write side is bounded by aggregate stream
   contention. The read side can scale horizontally with replicas or caches.

You can still do simple reads by replaying the aggregate stream directly
(`session.loadAggregateAsync<T>(id)`), but for list pages, searches, or
dashboards you will want a projection.

## Projections and read models

> "Projections transform event streams into read-optimised data structures."
> -- [Projections in Event Sourcing, Event Store](https://www.eventstore.com/blog/projections-in-event-sourcing)

A projection subscribes to one or more event types and writes to a read model.
EventFabric provides three projection tiers, each with a different consistency
and complexity trade-off.

### The three projection tiers

#### 1. Inline projections

```typescript
export interface InlineProjection<E extends AnyEvent, TTx extends Transaction> {
  name: string;
  handle(tx: TTx, env: EventEnvelope<E>): Promise<void>;
}
```

**When to use:** The read model must be updated in the **same transaction** that
appends the event. If the projection fails, the event append rolls back too.

**Trade-off:** Strong consistency, but the write transaction holds more locks and
does more work. The projection must use the same PostgreSQL transaction (the
`TTx` parameter) so it cannot call external services.

**Example:** Maintaining an `account_read` table that is queried by `GET /accounts/:id`
immediately after a deposit.

**Why it exists:** Some read models need to be consistent with the write
immediately -- for example, a unique-email check or a balance summary that the
API returns in the same response as the command.

#### 2. Catch-up projections

```typescript
export interface CatchUpProjection<E extends AnyEvent, TTx extends Transaction> {
  name: string;
  handle(tx: TTx, env: EventEnvelope<E>): Promise<void>;
}
```

**When to use:** The read model can tolerate a short delay (milliseconds to
seconds). The projection reads directly from `eventfabric.events` using its own
checkpoint in `eventfabric.projection_checkpoints`.

**Trade-off:** Eventually consistent but simple. No outbox rows, no topic
routing, no dead-letter footgun. The `CatchUpProjector` polls the events table
in batches and advances each projection's checkpoint independently.

**Example:** A process manager that reacts to `TransactionStarted` by
withdrawing from the source account, then reacts to `WithdrawalCompleted` by
depositing into the target account.

**Why it exists:** Most projections do not need the outbox's at-least-once
delivery guarantee. They only transform events into internal state. Reading
straight from the events table is cheaper, simpler, and avoids outbox
contention.

#### 3. Async (outbox-based) projections

```typescript
export interface AsyncProjection<E extends AnyEvent, TTx extends Transaction> {
  name: string;
  topicFilter?: TopicFilter;
  handle(tx: TTx, env: EventEnvelope<E>): Promise<void>;
}
```

**When to use:** The projection calls an external service (send an email, push
to a webhook, publish to Kafka). It needs per-message retry, dead-letter
routing, and at-least-once delivery.

**Trade-off:** Highest reliability, highest complexity. Events flow through the
`eventfabric.outbox` table, are claimed by a worker, and acknowledged after
successful processing. Failed messages are retried with exponential backoff and
eventually moved to `eventfabric.outbox_dead_letters`.

**Example:** Sending an email notification for every `AccountDeposited` event.

**Why it exists:** External side effects must not live inside the write
transaction (they cannot be rolled back), but must still happen at least once.
The transactional outbox pattern solves this.

### Choosing a tier

| Question                                        | Answer          | Tier      |
| ----------------------------------------------- | --------------- | --------- |
| Must the read model update in the same response? | Yes             | Inline    |
| Does the handler call an external service?       | No              | Catch-up  |
| Does the handler call an external service?       | Yes             | Async     |
| Can you tolerate a few hundred ms of delay?      | Yes             | Catch-up  |
| Do you need per-message retry and DLQ?           | Yes             | Async     |

## The transactional outbox pattern

> [Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html)
> -- reliably publish events by writing them to an outbox table inside the same
> transaction that stores the business data.

When `PgEventStore.append()` is called with `enqueueOutbox: true`, it writes a
row to `eventfabric.outbox` inside the same transaction that inserts the event.
This guarantees that either both the event and the outbox entry are committed, or
neither is.

The `AsyncProjectionRunner` then polls the outbox, claims messages, loads the
corresponding event from `eventfabric.events`, and dispatches to projections.
After successful processing the outbox row is deleted (`ack`). On failure the
row is released with an error message and its `attempts` counter is incremented.
After exceeding `maxAttempts` the row is moved to
`eventfabric.outbox_dead_letters`.

```
┌───────────────────────┐       ┌────────────────────┐
│  Write Transaction    │       │  Async Worker      │
│                       │       │                    │
│  1. append(events)    │       │  1. claimBatch()   │
│  2. INSERT outbox row │       │  2. loadEvent()    │
│  3. COMMIT            │──────>│  3. handle()       │
│                       │       │  4. ack() / retry  │
└───────────────────────┘       └────────────────────┘
```

The `Session.saveChangesAsync()` method automatically enqueues outbox rows for
every appended event, so you generally do not interact with the outbox directly.

## Eventual consistency

When you use catch-up or async projections, read models are **eventually
consistent** with the event log. This means:

- A command that deposits money will succeed and return immediately.
- A query that reads the balance from a projection might briefly show the old
  value.
- The projection will catch up within milliseconds to seconds.

This is a fundamental trade-off of CQRS. The alternatives are:

1. Use an inline projection for reads that must reflect the latest write
   (strongest consistency, highest write-path cost).
2. Read directly from the aggregate (`loadAggregateAsync`) for single-entity
   queries (consistent, but replays the full stream on every read).

## Comparison with Marten DB (.NET)

If you are coming from the .NET ecosystem, EventFabric's session API is inspired
by [Marten DB](https://martendb.io/). The following table maps Marten concepts
to their EventFabric equivalents.

| Marten DB (.NET)                              | EventFabric (TypeScript)                                    |
| --------------------------------------------- | ----------------------------------------------------------- |
| `IDocumentSession`                            | `Session<E>`                                                |
| `IDocumentStore`                              | `SessionFactory<E>`                                         |
| `session.Events.StartStream(id, events...)`   | `session.startStream(id, ...events)`                        |
| `session.Events.Append(id, events...)`        | `session.append(id, expectedVersion, ...events)`            |
| `session.LoadAsync<T>(id)`                    | `session.loadAggregateAsync<T>(id)`                         |
| `session.SaveChangesAsync()`                  | `session.saveChangesAsync()`                                |
| `StoreOptions.Projections.Inline<T>()`        | `factory.registerInlineProjector(projector)`                |
| `StoreOptions.Projections.Async<T>()`         | `createAsyncProjectionRunner(pool, store, projections, opts)` |
| Snapshot versioning + `ISnapshotProjection`   | `PgSnapshotStore<S>` + `SnapshotUpcasters<S>`              |
| `AggregateProjection<T>`                      | `AggregateRoot<S, E>` with `HandlerMap`                     |

Key differences:

- EventFabric uses **explicit concurrency** (`expectedAggregateVersion`) rather
  than Marten's implicit optimistic concurrency.
- Event types are plain discriminated unions, not classes decorated with
  attributes.
- The aggregate name is a `static readonly` property on the class, not an
  attribute or convention.

## Further reading

- [Getting Started](./getting-started.md) -- Installation, database setup,
  first aggregate
- [Aggregates](./aggregates.md) -- `AggregateRoot` deep dive
- [Events](./events.md) -- Event types, envelopes, versioning
- [Event Store](./event-store.md) -- `PgEventStore`, concurrency, upcasting
- [Sessions](./sessions.md) -- Unit of work, identity map, batching
- [Snapshots](./snapshots.md) -- When and how to snapshot
- [Schema Reference](./schema-reference.md) -- Database tables and migrations
