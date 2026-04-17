# @eventfabric/postgres

Postgres adapter for `@eventfabric/core`.

Includes:
- Global ordered event log (`global_position`)
- Optimistic concurrency per aggregate stream
- Inline projections (transactional with append)
- Async projections via outbox + SKIP LOCKED with per-aggregate topic routing
- DLQ after max attempts + requeue helpers
- Projection checkpoints
- Snapshots (latest-only) with schema versioning/upcasting
- Automatic database migrations
- [Multi-tenancy](docs/multi-tenancy.md) — conjoined (shared database) or per-database isolation

## Install

```bash
pnpm add @eventfabric/postgres pg
pnpm add @eventfabric/core
```

## Database Setup

Call `migrate()` on app startup — it applies all migrations automatically:

```typescript
import { migrate } from "@eventfabric/postgres";
await migrate(pool);
```

Tables created in the `eventfabric` schema:
- `eventfabric.events`
- `eventfabric.stream_versions`
- `eventfabric.projection_checkpoints`
- `eventfabric.outbox`
- `eventfabric.outbox_dead_letters`
- `eventfabric.snapshots`

## Session API

The `SessionFactory` and `Session` classes provide a fluent API for event sourcing operations. The factory holds configuration (aggregate registrations, snapshot stores, outbox topics, inline projections), while each session instance tracks per-request state (loaded aggregates, pending operations).

**Important**: Sessions should NOT be singletons. Create a new session per request/unit of work.

### Basic Usage

```ts
import { SessionFactory, PgSnapshotStore } from "@eventfabric/postgres";

// Create factory and configure once (at application startup)
const factory = new SessionFactory(pool, store);

// Register aggregates with event types, outbox topic, and optional snapshot config
const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
factory.registerAggregate(AccountAggregate, [
  "AccountOpened",
  "AccountDeposited",
  "AccountWithdrawn"
], "account", {
  snapshotStore,
  snapshotPolicy: { everyNEvents: 50 },
  snapshotSchemaVersion: 1
});

// In each request handler, create a new session:
app.post("/accounts/:id/deposit", async (req, res) => {
  const session = factory.createSession(); // New session per request

  // Pattern 1: Load aggregate, modify, and save
  const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
  account.deposit(100);
  await session.saveChangesAsync(); // Automatically saves pending events

  res.json({ ok: true });
});

// Pattern 2: Start new stream (for creating new aggregates)
const session = factory.createSession();
session.startStream("acc-2", AccountOpened({ accountId: "acc-2", customerId: "cust-1", initialBalance: 0 }));
await session.saveChangesAsync();
```

### Inline Projections

Inline projections run within the same transaction as event appends, ensuring strong consistency between events and read models.

```ts
import { InlineProjector } from "@eventfabric/postgres";

const inlineProjector = new InlineProjector<AccountEvent, PgTx>([
  {
    name: "account-search-projection",
    async handle(tx: PgTx, env: EventEnvelope<AccountEvent>) {
      if (env.payload.type === "AccountOpened") {
        await tx.client.query(
          `INSERT INTO account_search (account_id, customer_id, balance)
           VALUES ($1, $2, $3)
           ON CONFLICT (account_id) DO UPDATE SET balance = EXCLUDED.balance`,
          [env.aggregateId, env.payload.customerId, env.payload.initialBalance]
        );
      }
    }
  }
]);

factory.registerInlineProjector(inlineProjector);
```

### Snapshots

Snapshots improve performance by avoiding replaying all events. Configure snapshot policies to automatically create snapshots at regular intervals.

```ts
const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
factory.registerAggregate(
  AccountAggregate,
  ["AccountOpened", "AccountDeposited", "AccountWithdrawn"],
  "account",
  {
    snapshotStore,
    snapshotPolicy: { everyNEvents: 50 },
    snapshotSchemaVersion: 1
  }
);

// When loading, snapshots are automatically used
const session = factory.createSession();
const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
// If snapshot exists at version 50, only events after version 50 are replayed
```

### Async Projections (Outbox Pattern)

Async projections process events asynchronously via the outbox table. Events are automatically enqueued with the aggregate's registered topic when using `saveChangesAsync()`.

```ts
import { createAsyncProjectionRunner } from "@eventfabric/postgres";

// Define async projection with topic filter
const emailProjection: AsyncProjection<AccountEvent, PgTx> = {
  name: "email-notification",
  topicFilter: { mode: "include", topics: ["account"] },
  async handle(tx: PgTx, env: EventEnvelope<AccountEvent>) {
    if (env.payload.type === "AccountOpened") {
      await sendEmail(env.payload.customerId, "Welcome! Your account is open.");
    }
  }
};

// Create and start async projection runner
const runner = createAsyncProjectionRunner(pool, store, [emailProjection], {
  workerId: `worker-${process.pid}`,
  batchSize: 100,
  transactionMode: "perRow",
  maxAttempts: 10
});

await runner.start(new AbortController().signal);
```

The outbox topic is set per aggregate at registration time:

```ts
factory.registerAggregate(AccountAggregate, [...], "account");    // topic: "account"
factory.registerAggregate(TransactionAggregate, [...], "transaction"); // topic: "transaction"
```

Projections use `topicFilter` to receive only events they care about:

```ts
{ mode: "include", topics: ["account"] }          // only account events
{ mode: "include", topics: ["account", "transaction"] } // account + transaction
{ mode: "exclude", topics: ["audit"] }             // everything except audit
{ mode: "all" }                                    // all events
```

### Complete Example

```ts
import {
  SessionFactory,
  PgSnapshotStore,
  InlineProjector,
  createAsyncProjectionRunner
} from "@eventfabric/postgres";

// Setup
const factory = new SessionFactory(pool, store);

// 1. Register aggregates with outbox topics and optional snapshots
factory.registerAggregate(AccountAggregate, [
  "AccountOpened", "AccountDeposited", "AccountWithdrawn"
], "account", {
  snapshotStore: new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1),
  snapshotPolicy: { everyNEvents: 50 }
});

// 2. Register inline projector for read model
factory.registerInlineProjector(new InlineProjector<AccountEvent, PgTx>([
  {
    name: "account-read-model",
    async handle(tx, env) { await updateAccountReadModel(tx, env); }
  }
]));

// 3. Setup async projection for email notifications
const runner = createAsyncProjectionRunner(pool, store, [{
  name: "email-notification",
  topicFilter: { mode: "include", topics: ["account"] },
  async handle(tx, env) {
    if (env.payload.type === "AccountOpened") {
      await sendWelcomeEmail(env.payload.customerId);
    }
  }
}], {
  workerId: `worker-${process.pid}`,
  batchSize: 100,
  transactionMode: "perRow",
  maxAttempts: 10
});
await runner.start(new AbortController().signal);

// 4. Use in request handlers
app.post("/accounts/:id/deposit", async (req, res) => {
  const session = factory.createSession();

  const account = await session.loadAggregateAsync<AccountAggregate>(req.params.id);
  account.deposit(req.body.amount);

  // This single call:
  // - Appends events to the event store
  // - Runs inline projections (updates read model)
  // - Enqueues to outbox with topic "account" (for async email projection)
  // - Creates snapshots if policy triggers
  // - All in one transaction!
  await session.saveChangesAsync();

  res.json({ ok: true });
});
```
