# Sessions

The `SessionFactory` and `Session` classes from `@eventfabric/postgres` provide
a Marten-style unit-of-work API for event sourcing. You configure the factory
once at startup and create a lightweight session for each request or use case.

## SessionFactory&lt;E&gt;

```typescript
import { Pool } from "pg";
import { PgEventStore, SessionFactory } from "@eventfabric/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PgEventStore<BankingEvent>();

const factory = new SessionFactory<BankingEvent>(pool, store);
```

### Constructor

```typescript
new SessionFactory<E>(pool: Pool, store: PgEventStore<E>)
```

| Parameter | Type              | Description                                  |
| --------- | ----------------- | -------------------------------------------- |
| `pool`    | `pg.Pool`         | PostgreSQL connection pool.                  |
| `store`   | `PgEventStore<E>` | The event store instance (with optional upcaster). |

The factory holds shared configuration: aggregate registrations, snapshot store
bindings, and inline projectors. Each session created from it shares this
configuration but has its own isolated state.

### registerAggregate()

```typescript
factory.registerAggregate<EAgg, TTypes>(
  AggregateClass,
  eventTypes,
  snapshotStore?,
  snapshotPolicy?,
  snapshotSchemaVersion?
);
```

Registers an aggregate class and maps its event types so the session can
resolve aggregates at load time and infer aggregate classes from events.

| Parameter                | Type                                                        | Required | Description                                               |
| ------------------------ | ----------------------------------------------------------- | -------- | --------------------------------------------------------- |
| `AggregateClass`         | Class with static `aggregateName` + extends `AggregateRoot` | yes      | The aggregate class to register.                          |
| `eventTypes`             | `readonly string[]`                                         | yes      | Every event `type` string that belongs to this aggregate. |
| `snapshotStore`          | `PgSnapshotStore<S>`                                        | no       | Snapshot store for this aggregate.                        |
| `snapshotPolicy`         | `{ everyNEvents: number }`                                  | no       | When to take snapshots automatically.                     |
| `snapshotSchemaVersion`  | `number`                                                    | no       | Schema version stored in the snapshot row (default `1`).  |

#### ExhaustiveEventTypes compile-time check

The `eventTypes` parameter uses a conditional type to enforce exhaustiveness at
compile time:

```typescript
type ExhaustiveEventTypes<EAgg extends AnyEvent, T extends readonly EAgg["type"][]> =
  [Exclude<EAgg["type"], T[number]>] extends [never]
    ? T
    : T & { readonly __missingEventTypes: Exclude<EAgg["type"], T[number]> };
```

If you forget an event type, TypeScript reports an error:

```typescript
// AccountEvent has: "AccountOpened" | "AccountDeposited" | "AccountWithdrawn" | ...

factory.registerAggregate(AccountAggregate, [
  "AccountOpened",
  "AccountDeposited",
  // Missing: "AccountWithdrawn", "AccountClosed", etc.
]);
// Error: Property '__missingEventTypes' is missing in type ...
//        ... "AccountWithdrawn" | "AccountClosed" | ...
```

This catches registration mistakes at build time rather than at runtime.

#### Full registration example

```typescript
import { PgSnapshotStore } from "@eventfabric/postgres";
import { AccountAggregate, type AccountState } from "./domain/account.aggregate";
import { TransactionAggregate, type TransactionState } from "./domain/transaction.aggregate";
import { CustomerAggregate, type CustomerState } from "./domain/customer.aggregate";

const accountSnapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
const transactionSnapshotStore = new PgSnapshotStore<TransactionState>("eventfabric.snapshots", 1);
const customerSnapshotStore = new PgSnapshotStore<CustomerState>("eventfabric.snapshots", 1);

factory.registerAggregate(AccountAggregate, [
  "AccountOpened",
  "AccountDeposited",
  "AccountWithdrawn",
  "WithdrawalCompleted",
  "DepositCompleted",
  "AccountTransferredOut",
  "AccountTransferredIn",
  "AccountClosed",
], accountSnapshotStore);

factory.registerAggregate(TransactionAggregate, [
  "TransactionInitiated",
  "TransactionStarted",
  "TransactionCompleted",
  "TransactionFailed",
], transactionSnapshotStore);

factory.registerAggregate(CustomerAggregate, [
  "CustomerRegistered",
  "CustomerEmailUpdated",
  "CustomerPhoneUpdated",
], customerSnapshotStore);
```

### registerInlineProjector()

```typescript
import { InlineProjector } from "@eventfabric/postgres";

const inlineProjector = new InlineProjector<BankingEvent, PgTx>([
  accountReadProjection,
  customerReadProjection,
]);

factory.registerInlineProjector(inlineProjector);
```

The inline projector runs inside the same transaction as `saveChangesAsync()`.
See [Core Concepts -- Inline projections](./core-concepts.md) for when to use
this tier.

### createSession()

```typescript
const session = factory.createSession();
```

Returns a new `Session<E>` with isolated state (its own identity map and pending
operations list) but shared configuration from the factory.

## Session&lt;E&gt;

A session is the unit of work for event sourcing. It tracks loaded aggregates,
queues write operations, and commits everything in a single PostgreSQL
transaction when `saveChangesAsync()` is called.

Sessions should be created from `SessionFactory`, not instantiated directly.

### loadAggregateAsync&lt;T&gt;(id)

```typescript
const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
```

Loads an aggregate by replaying its event stream. The aggregate class is
resolved from the factory's registration by querying the `aggregate_name` stored
in the events table.

#### Identity map

The session maintains an identity map. If you call `loadAggregateAsync` twice
with the same `id`, the second call returns the same in-memory instance:

```typescript
const a1 = await session.loadAggregateAsync<AccountAggregate>("acc-1");
const a2 = await session.loadAggregateAsync<AccountAggregate>("acc-1");
a1 === a2  // true -- same reference
```

This prevents a common bug where a second load creates a fresh instance, the
first instance's pending events become unreachable, and `saveChangesAsync`
silently drops them.

#### Snapshot integration

If a snapshot store was registered for the aggregate via `registerAggregate()`,
the session uses it automatically. On load it checks for a snapshot, then
replays only the events since that snapshot's version.

#### Automatic tracking

Loaded aggregates are tracked by the session. When `saveChangesAsync()` is
called, the session calls `pullPendingEvents()` on every tracked aggregate and
includes those events in the batch.

```typescript
const session = factory.createSession();

// Load and mutate
const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
account.deposit(100);

// No need to explicitly "save the aggregate" -- the session tracks it
await session.saveChangesAsync();
```

### startStream()

Queues a new stream creation with initial events. The aggregate class is
inferred from the first event's `type` using the factory's registration.

```typescript
session.startStream("acc-1",
  { type: "AccountOpened", version: 2, accountId: "acc-1", customerId: "cust-1", initialBalance: 500, currency: "USD", region: "UK" },
  { type: "AccountDeposited", version: 1, accountId: "acc-1", amount: 500, balance: 500 }
);
await session.saveChangesAsync();
```

All events must belong to the same aggregate (the session validates this). The
operation is queued -- no database call happens until `saveChangesAsync()`.

If the stream already exists, `saveChangesAsync()` throws a `ConcurrencyError`.

### append()

Queues an event append with explicit concurrency control.

```typescript
session.append("acc-1", 3,
  { type: "AccountDeposited", version: 1, accountId: "acc-1", amount: 100, balance: 600 }
);
await session.saveChangesAsync();
```

| Parameter         | Type     | Description                                 |
| ----------------- | -------- | ------------------------------------------- |
| `aggregateId`     | `string` | The aggregate instance identity.            |
| `expectedVersion` | `number` | The version you expect the stream to be at. |
| `...events`       | `E[]`    | One or more events to append.               |

### appendUnsafe()

Queues an event append **without** providing an expected version. The session
resolves the current version at commit time by reading `MAX(aggregate_version)`.

```typescript
session.appendUnsafe("acc-1",
  { type: "AccountDeposited", version: 1, accountId: "acc-1", amount: 50, balance: 650 }
);
await session.saveChangesAsync();
```

**Warning:** This is race-prone if multiple writers target the same stream
concurrently. Use it only when you control concurrency externally or when
conflicts are acceptable.

### saveChangesAsync()

Commits all pending operations and tracked aggregate changes in a single
PostgreSQL transaction.

```typescript
await session.saveChangesAsync();
```

#### What happens during save

1. **Collect tracked events:** For every aggregate loaded via
   `loadAggregateAsync`, call `pullPendingEvents()`. If the aggregate has
   pending events, queue an append operation.

2. **Open a transaction:** Acquire a connection from the pool, `BEGIN`.

3. **Execute operations in order:**
   - `startStream` operations check for stream existence and delegate to
     `store.append()` with `expectedAggregateVersion: 0`.
   - `append` operations delegate to `store.append()` with the recorded
     expected version. For `appendUnsafe`, the current version is read first.

4. **Enqueue outbox:** All appended events are automatically enqueued to the
   outbox (`enqueueOutbox: true`).

5. **Run inline projections:** If an inline projector is registered, it runs
   over all appended envelopes inside the same transaction.

6. **Take snapshots:** For each aggregate that was modified, check the
   registered snapshot policy. If `newVersion % everyNEvents === 0`, save a
   snapshot.

7. **COMMIT.**

8. **Clear state:** Pending operations are cleared. Loaded aggregates' versions
   are updated to reflect the committed state.

If any step fails, the transaction is rolled back and the error propagates. The
session state is left in an indeterminate condition -- create a new session for
the next attempt.

#### Batching across aggregates

Multiple aggregates can be modified and saved atomically:

```typescript
const session = factory.createSession();

const fromAccount = await session.loadAggregateAsync<AccountAggregate>("acc-1");
const toAccount = await session.loadAggregateAsync<AccountAggregate>("acc-2");
const transaction = await session.loadAggregateAsync<TransactionAggregate>("tx-1");

fromAccount.transferOut("acc-2", 100, "tx-1");
toAccount.transferIn("acc-1", 100, "tx-1");
transaction.complete();

// All three aggregates' events are committed in ONE transaction
await session.saveChangesAsync();
```

This is how EventFabric handles cross-aggregate operations that must be
atomic. Within the banking-api example, the `/transfers` endpoint uses exactly
this pattern.

## Express endpoint example

A complete Express endpoint showing the session lifecycle:

```typescript
import express from "express";
import { Pool } from "pg";
import { PgEventStore, SessionFactory } from "@eventfabric/postgres";
import { AccountAggregate, type AccountState } from "./domain/account.aggregate";
import type { BankingEvent } from "./domain/events";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PgEventStore<BankingEvent>();
const factory = new SessionFactory<BankingEvent>(pool, store);

factory.registerAggregate(AccountAggregate, [
  "AccountOpened",
  "AccountDeposited",
  "AccountWithdrawn",
  "WithdrawalCompleted",
  "DepositCompleted",
  "AccountTransferredOut",
  "AccountTransferredIn",
  "AccountClosed",
]);

const app = express();
app.use(express.json());

app.post("/accounts/:id/deposit", async (req, res) => {
  const session = factory.createSession();
  try {
    const account = await session.loadAggregateAsync<AccountAggregate>(req.params.id);
    account.deposit(req.body.amount);
    await session.saveChangesAsync();
    res.json({ ok: true, balance: account.balance });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(3000);
```

Key points:
- One `SessionFactory` per application (shared, stateless configuration).
- One `Session` per request (isolated state, short-lived).
- `loadAggregateAsync` + domain method + `saveChangesAsync` is the standard
  three-step pattern.
- Error handling is straightforward -- any exception (including
  `ConcurrencyError`) rolls back the transaction automatically.

## Related documentation

- [Aggregates](./aggregates.md) -- `AggregateRoot` base class
- [Events](./events.md) -- Event types and `EventEnvelope`
- [Event Store](./event-store.md) -- Lower-level `PgEventStore` API
- [Snapshots](./snapshots.md) -- How snapshots integrate with sessions
- [Core Concepts](./core-concepts.md) -- CQRS, projection tiers, eventual consistency
