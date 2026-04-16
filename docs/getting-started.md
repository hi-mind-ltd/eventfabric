# Getting Started

This guide walks you through installing EventFabric, setting up PostgreSQL, and
building your first event-sourced aggregate from scratch.

## Prerequisites

| Dependency     | Minimum version | Notes                                          |
| -------------- | --------------- | ---------------------------------------------- |
| **Node.js**    | 20+             | ESM-only packages; `type: "module"` throughout |
| **PostgreSQL** | 14+             | `BIGSERIAL`, `JSONB`, `TIMESTAMPTZ` required   |
| **pnpm**       | 9+              | Workspace protocol used for internal packages  |

## Installation

EventFabric ships as two npm packages in this monorepo:

```bash
pnpm add @eventfabric/core @eventfabric/postgres
```

`@eventfabric/core` contains the framework abstractions (aggregates, events,
projections). `@eventfabric/postgres` provides the PostgreSQL storage
implementation and the `Session`/`SessionFactory` API.

If you are working inside the monorepo itself:

```bash
git clone <repo-url> eventfabric
cd eventfabric
pnpm install
pnpm build
```

## Database setup

### 1. Create the schema

EventFabric stores all data in a dedicated PostgreSQL schema called
`eventfabric`. Connect to your database and run:

```sql
CREATE SCHEMA IF NOT EXISTS eventfabric;
```

### 2. Run migrations

The migration files live in `packages/postgres/migrations/`. Apply them in
order:

```bash
psql "$DATABASE_URL" -f packages/postgres/migrations/001_init.sql
psql "$DATABASE_URL" -f packages/postgres/migrations/002_projection_checkpoints.sql
psql "$DATABASE_URL" -f packages/postgres/migrations/003_outbox_and_dlq.sql
psql "$DATABASE_URL" -f packages/postgres/migrations/004_snapshots.sql
```

After the migrations complete you will have five tables:

| Table                                | Purpose                        |
| ------------------------------------ | ------------------------------ |
| `eventfabric.events`                 | Append-only event log          |
| `eventfabric.projection_checkpoints` | Catch-up / async checkpoints   |
| `eventfabric.outbox`                 | Transactional outbox           |
| `eventfabric.outbox_dead_letters`    | Dead letter queue              |
| `eventfabric.snapshots`              | Aggregate snapshot cache       |

See [Schema Reference](./schema-reference.md) for the full column-level
documentation.

## Your first aggregate

This section creates a minimal `Counter` aggregate to demonstrate the core
workflow: define events, implement the aggregate, wire the store, and run a
command.

### Step 1 -- Define events

```typescript
// domain/counter.events.ts
export type CounterIncrementedV1 = {
  type: "CounterIncremented";
  version: 1;
  counterId: string;
  amount: number;
};

export type CounterDecrementedV1 = {
  type: "CounterDecremented";
  version: 1;
  counterId: string;
  amount: number;
};

export type CounterEvent = CounterIncrementedV1 | CounterDecrementedV1;
```

Every event type is a plain object with a `type` discriminator and a literal
`version` field. See [Events](./events.md) for the full naming and versioning
conventions.

### Step 2 -- Implement the aggregate

```typescript
// domain/counter.aggregate.ts
import { AggregateRoot, type HandlerMap } from "@eventfabric/core";
import type { CounterEvent } from "./counter.events";

export type CounterState = { value: number };

export class CounterAggregate extends AggregateRoot<CounterState, CounterEvent> {
  // Static name used by the event store to identify this stream type.
  static readonly aggregateName = "Counter" as const;

  protected handlers = {
    CounterIncremented: (s, e) => {
      s.value += e.amount;
    },
    CounterDecremented: (s, e) => {
      s.value -= e.amount;
    },
  } satisfies HandlerMap<CounterEvent, CounterState>;

  constructor(id: string, snapshot?: CounterState) {
    super(id, snapshot ?? { value: 0 });
  }

  increment(amount: number) {
    if (amount <= 0) throw new Error("Amount must be positive");
    this.raise({
      type: "CounterIncremented",
      version: 1,
      counterId: this.id,
      amount,
    });
  }

  decrement(amount: number) {
    if (amount <= 0) throw new Error("Amount must be positive");
    if (this.state.value < amount) throw new Error("Cannot go below zero");
    this.raise({
      type: "CounterDecremented",
      version: 1,
      counterId: this.id,
      amount,
    });
  }
}
```

See [Aggregates](./aggregates.md) for a deep dive on `AggregateRoot`, handler
maps, and testing patterns.

### Step 3 -- Wire the store and session

```typescript
// app.ts
import { Pool } from "pg";
import { PgEventStore, SessionFactory } from "@eventfabric/postgres";
import { CounterAggregate } from "./domain/counter.aggregate";
import type { CounterEvent } from "./domain/counter.events";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PgEventStore<CounterEvent>();

// Configure the factory once at startup.
const factory = new SessionFactory<CounterEvent>(pool, store);
factory.registerAggregate(CounterAggregate, [
  "CounterIncremented",
  "CounterDecremented",
]);

// Create a session per request / use case.
async function incrementCounter(id: string, amount: number) {
  const session = factory.createSession();
  const counter = await session.loadAggregateAsync<CounterAggregate>(id);
  counter.increment(amount);
  await session.saveChangesAsync();
  console.log(`Counter ${id} is now ${counter.state.value}`);
}
```

`saveChangesAsync()` commits every tracked aggregate's pending events inside a
single PostgreSQL transaction. See [Sessions](./sessions.md) for the full
unit-of-work lifecycle.

## Running the banking-api example

The `examples/banking-api` project is a fully wired Express app with accounts,
customers, transactions, inline projections, catch-up projections, and an
outbox-based email notification runner.

```bash
# Start PostgreSQL (Docker example)
docker run --name ef-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16

# Set the connection string
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# Run migrations
psql "$DATABASE_URL" -f packages/postgres/migrations/001_init.sql
psql "$DATABASE_URL" -f packages/postgres/migrations/002_projection_checkpoints.sql
psql "$DATABASE_URL" -f packages/postgres/migrations/003_outbox_and_dlq.sql
psql "$DATABASE_URL" -f packages/postgres/migrations/004_snapshots.sql

# Build and run
pnpm install
pnpm build
cd examples/banking-api
npx tsx src/app.ts
```

Try it with curl:

```bash
# Open an account
curl -X POST http://localhost:3001/accounts/acc-1/open \
  -H "Content-Type: application/json" \
  -d '{"customerId":"cust-1","initialBalance":500,"currency":"USD"}'

# Deposit funds
curl -X POST http://localhost:3001/accounts/acc-1/deposit \
  -H "Content-Type: application/json" \
  -d '{"amount":250}'

# Check balance
curl http://localhost:3001/accounts/acc-1
```

## Next steps

| Topic                                        | What you will learn                                                  |
| -------------------------------------------- | -------------------------------------------------------------------- |
| [Core Concepts](./core-concepts.md)          | Event sourcing theory, CQRS, projection tiers, eventual consistency  |
| [Aggregates](./aggregates.md)                | `AggregateRoot`, handlers, raise, testing                            |
| [Events](./events.md)                        | Type conventions, discriminated unions, `EventEnvelope`              |
| [Event Store](./event-store.md)              | `PgEventStore`, append, load, concurrency, upcasting                |
| [Sessions](./sessions.md)                    | `SessionFactory`, unit of work, identity map, batching               |
| [Snapshots](./snapshots.md)                  | `PgSnapshotStore`, policies, upcasting, when to snapshot             |
| [Schema Reference](./schema-reference.md)    | Every table, column, index, and migration explained                  |
