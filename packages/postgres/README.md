# @eventfabric/postgres

Postgres adapter for `@eventfabric/core`.

Includes:
- Global ordered event log (`global_position`)
- Optimistic concurrency per aggregate stream
- Inline projections (transactional with append)
- Async projections via outbox + SKIP LOCKED
- DLQ after max attempts + requeue helpers
- Projection checkpoints
- Snapshots (latest-only) with schema versioning/upcasting

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

## Usage

The recommended way to use this library is through the **Session API** (see below). The Session API provides an interface that automatically manages transactions and tracks aggregates.

## Async projections (outbox)

```ts
import { PgAsyncProjectionRunner } from "@eventfabric/postgres";

const runner = new PgAsyncProjectionRunner<AppEvent>(pool, store, [projection], {
  workerId: `worker-${process.pid}`,
  transactionMode: "perRow",
  maxAttempts: 10
});

await runner.start(new AbortController().signal);
```

## Session API

The `SessionFactory` and `Session` classes provide a fluent API for event sourcing operations. The factory holds configuration (aggregate registrations, snapshot stores, inline projections), while each session instance tracks per-request state (loaded aggregates, pending operations).

**Important**: Sessions should NOT be singletons. Create a new session per request/unit of work.

### Basic Usage

```ts
import { SessionFactory, PgSnapshotStore, InlineProjector } from "@eventfabric/postgres";

// Create factory and configure once (at application startup)
const factory = new SessionFactory(pool, store);

// Register aggregates with their event types and optional snapshot stores (done once)
const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
factory.registerAggregate(AccountAggregate, [
  "AccountOpened",
  "AccountDeposited",
  "AccountWithdrawn"
], snapshotStore, { everyNEvents: 50 }, 1); // snapshotStore, policy, schemaVersion are optional

// In each request handler, create a new session:
app.post("/accounts/:id/deposit", async (req, res) => {
  const session = factory.createSession(); // New session per request
  
  // Pattern 1: Load aggregate, modify, and save
  const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
  account.deposit(100);
  await session.saveChangesAsync(); // Automatically saves pending events
  
  res.json({ ok: true });
});

// Pattern 2: Append events directly
const session = factory.createSession();
session.append("acc-1", 1, accountDeposited);
await session.saveChangesAsync();

// Pattern 3: Start new stream
const session = factory.createSession();
session.startStream("acc-2", accountOpened, accountDeposited);
await session.saveChangesAsync();
```

### Inline Projections

Inline projections run within the same transaction as event appends, ensuring strong consistency between events and read models.

```ts
import { InlineProjector } from "@eventfabric/postgres";

// Define inline projection for maintaining a search table
const inlineProjector = new InlineProjector<AccountEvent, PgTx>([
  {
    name: "account-search-projection",
    async handle(tx: PgTx, env: EventEnvelope<AccountEvent>) {
      if (env.payload.type === "AccountOpened") {
        await tx.client.query(
          `INSERT INTO account_search (account_id, customer_id, balance, currency, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (account_id) DO UPDATE SET
             customer_id = EXCLUDED.customer_id,
             balance = EXCLUDED.balance,
             currency = EXCLUDED.currency,
             updated_at = now()`,
          [env.aggregateId, env.payload.customerId, env.payload.initialBalance, env.payload.currency]
        );
      } else if (env.payload.type === "AccountDeposited" || env.payload.type === "AccountWithdrawn") {
        await tx.client.query(
          `UPDATE account_search SET balance = $1, updated_at = now() WHERE account_id = $2`,
          [env.payload.balance, env.aggregateId]
        );
      }
    }
  }
]);

// Register inline projector with factory
factory.registerInlineProjector(inlineProjector);

// Usage - inline projection runs automatically in saveChangesAsync()
const session = factory.createSession();
const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
account.deposit(100);
await session.saveChangesAsync(); // Inline projection runs here, updating account_search table
```

### Snapshots with Policies

Snapshots improve performance by avoiding replaying all events. Configure snapshot policies to automatically create snapshots at regular intervals.

```ts
// Register aggregate with snapshot store and policy
const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
factory.registerAggregate(
  AccountAggregate,
  ["AccountOpened", "AccountDeposited", "AccountWithdrawn"],
  snapshotStore,           // Snapshot store
  { everyNEvents: 50 },   // Create snapshot every 50 events
  1                        // Snapshot schema version
);

// When loading, snapshots are automatically used
const session = factory.createSession();
const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
// If snapshot exists at version 50, only events after version 50 are replayed
```

### Async Projections (Outbox Pattern)

Async projections process events asynchronously via the outbox table. Events are automatically enqueued when using `saveChangesAsync()`.

```ts
import { createAsyncProjectionRunner } from "@eventfabric/postgres";

// Define async projection for email notifications
const emailProjection: AsyncProjection<AccountEvent, PgTx> = {
  name: "email-notification",
  topicFilter: { mode: "include", topics: [null] }, // Process all events (null topic)
  async handle(tx: PgTx, env: EventEnvelope<AccountEvent>) {
    if (env.payload.type === "AccountOpened") {
      // Send welcome email
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

// Events are automatically enqueued when using Session API
const session = factory.createSession();
const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
account.deposit(100);
await session.saveChangesAsync(); // Event is automatically enqueued to outbox
```

### Complete Example: All Features Together

```ts
import { 
  SessionFactory, 
  PgSnapshotStore, 
  InlineProjector, 
  createAsyncProjectionRunner 
} from "@eventfabric/postgres";

// Setup
const factory = new SessionFactory(pool, store);

// 1. Register aggregates with snapshots and policies
const accountSnapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
factory.registerAggregate(
  AccountAggregate,
  ["AccountOpened", "AccountDeposited", "AccountWithdrawn"],
  accountSnapshotStore,
  { everyNEvents: 50 }, // Snapshot every 50 events
  1
);

// 2. Register inline projector for read model
const inlineProjector = new InlineProjector<AccountEvent, PgTx>([
  {
    name: "account-read-model",
    async handle(tx: PgTx, env: EventEnvelope<AccountEvent>) {
      // Update read model in same transaction
      await updateAccountReadModel(tx, env);
    }
  }
]);
factory.registerInlineProjector(inlineProjector);

// 3. Setup async projection for email notifications
const emailProjection: AsyncProjection<AccountEvent, PgTx> = {
  name: "email-notification",
  topicFilter: { mode: "include", topics: [null] },
  async handle(tx: PgTx, env: EventEnvelope<AccountEvent>) {
    if (env.payload.type === "AccountOpened") {
      await sendWelcomeEmail(env.payload.customerId);
    }
  }
};
const runner = createAsyncProjectionRunner(pool, store, [emailProjection], {
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
  // - Appends events
  // - Runs inline projections (updates read model)
  // - Enqueues to outbox (for async email projection)
  // - Creates snapshots if policy triggers
  // - All in one transaction!
  await session.saveChangesAsync();
  
  res.json({ ok: true });
});
```

The session automatically:
- Tracks loaded aggregates and saves them when `saveChangesAsync()` is called
- Infers the aggregate class from the event type
- Batches operations until `saveChangesAsync()` is called
- Commits all operations in a single transaction
- Validates that all events belong to the same aggregate
- **Runs inline projections** within the same transaction
- **Creates snapshots** based on configured policies
- **Enqueues all events to outbox** (with null topic - any projection can process them)
- Provides clear error messages for unregistered event types
