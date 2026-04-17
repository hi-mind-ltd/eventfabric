# EventFabric

Type-safe event sourcing framework for TypeScript.

EventFabric provides a database-agnostic core with aggregates, projections (inline, catch-up, async/outbox), snapshots, schema evolution via event upcasters, multi-tenancy, and vendor-neutral observability hooks. The `@eventfabric/postgres` package ships a production-ready PostgreSQL adapter out of the box.

## Packages

| Package | Description |
|---|---|
| [`@eventfabric/core`](packages/core/) | Framework-agnostic interfaces, types, and orchestration logic. Zero runtime dependencies. |
| [`@eventfabric/postgres`](packages/postgres/) | PostgreSQL adapter — event store, session, snapshots, outbox, query builder, multi-tenancy. |
| [`@eventfabric/opentelemetry`](packages/opentelemetry/) | OpenTelemetry adapter — spans, metrics, and context propagation for projection runners. |

## Quick Start

```bash
pnpm add @eventfabric/core @eventfabric/postgres pg
```

### 1. Define Events

```typescript
type UserEvent =
  | { type: "UserRegistered"; version: 1; userId: string; email: string; displayName: string }
  | { type: "UserEmailChanged"; version: 1; userId: string; email: string };

// Factory functions — type and version baked in, never written manually
const UserRegistered = (data: Omit<UserEvent & { type: "UserRegistered" }, "type" | "version">) =>
  ({ type: "UserRegistered" as const, version: 1 as const, ...data });
```

### 2. Define an Aggregate

```typescript
import { AggregateRoot, type HandlerMap } from "@eventfabric/core";

type UserState = { email?: string; displayName?: string };

class UserAggregate extends AggregateRoot<UserState, UserEvent> {
  static readonly aggregateName = "User" as const;

  protected handlers = {
    UserRegistered: (s, e) => { s.email = e.email; s.displayName = e.displayName; },
    UserEmailChanged: (s, e) => { s.email = e.email; }
  } satisfies HandlerMap<UserEvent, UserState>;

  constructor(id: string, snapshot?: UserState) {
    super(id, snapshot ?? {});
  }

  changeEmail(email: string) {
    this.raise({ type: "UserEmailChanged", version: 1, userId: this.id, email });
  }
}
```

### 3. Wire Up the Store

```typescript
import { Pool } from "pg";
import { PgEventStore, PgSnapshotStore, SessionFactory, migrate } from "@eventfabric/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool); // creates all tables on first run, no-op after

const store = new PgEventStore<UserEvent>();
const factory = new SessionFactory(pool, store);

factory.registerAggregate(UserAggregate, [
  "UserRegistered", "UserEmailChanged"
], "user", {
  snapshotStore: new PgSnapshotStore()
});
```

### 4. Use in Request Handlers

```typescript
// Create a new user
app.post("/users/:id/register", async (req, res) => {
  const session = factory.createSession();
  session.startStream(req.params.id, UserRegistered({
    userId: req.params.id,
    email: req.body.email,
    displayName: req.body.name
  }));
  await session.saveChangesAsync();
  res.json({ ok: true });
});

// Update an existing user
app.post("/users/:id/change-email", async (req, res) => {
  const session = factory.createSession();
  const user = await session.loadAggregateAsync<UserAggregate>(req.params.id);
  user.changeEmail(req.body.email);
  await session.saveChangesAsync();
  res.json({ ok: true });
});
```

### 5. Add an Async Projection

```typescript
import { createAsyncProjectionRunner } from "@eventfabric/postgres";

// Send a welcome email when a user registers
const runner = createAsyncProjectionRunner(pool, store, [{
  name: "welcome-email",
  topicFilter: { mode: "include", topics: ["user"] },
  async handle(_tx, env) {
    if (env.payload.type === "UserRegistered") {
      await sendEmail(env.payload.email, "Welcome!", `Hello ${env.payload.displayName}!`);
    }
  }
}], {
  workerId: "email-worker-1",
  batchSize: 10,
  maxAttempts: 5
});

runner.start(new AbortController().signal);
```

### 6. Multi-Tenancy

```typescript
import { ConjoinedTenantResolver, PerDatabaseTenantResolver } from "@eventfabric/postgres";

// Conjoined: all tenants share one database, isolated by tenant_id column
const resolver = new ConjoinedTenantResolver(pool);
const factory = new SessionFactory(resolver, store);
const session = factory.createSession("tenant-acme"); // scoped to tenant

// Per-database: each tenant gets their own database
const resolver = new PerDatabaseTenantResolver({
  acme:    new Pool({ connectionString: "postgres://localhost/acme_db" }),
  contoso: new Pool({ connectionString: "postgres://localhost/contoso_db" }),
});
const factory = new SessionFactory(resolver, store);
const session = factory.createSession("acme"); // uses acme's pool
```

See [multi-tenancy docs](packages/postgres/docs/multi-tenancy.md) for full details.

## Documentation

### Design

- [High-Level Design (HLD)](docs/high-level-design.md) — system overview, data flow diagrams, architecture decisions
- [Low-Level Design (LLD)](docs/low-level-design.md) — class internals, algorithms, sequence diagrams, SQL generation

### Guides

- [Getting Started](docs/getting-started.md) — installation, database setup, first aggregate
- [Core Concepts](docs/core-concepts.md) — event sourcing fundamentals, CQRS, how EventFabric maps to them
- [Multi-Tenancy](packages/postgres/docs/multi-tenancy.md) — conjoined (shared database) or per-database isolation

### Write Side

- [Aggregates](docs/aggregates.md) — `AggregateRoot`, state, handlers, commands
- [Events](docs/events.md) — event types, versioning, `EventEnvelope`
- [Event Store](docs/event-store.md) — `PgEventStore`, append, load, concurrency
- [Sessions](docs/sessions.md) — `SessionFactory`, `Session`, identity map, unit of work
- [Snapshots](docs/snapshots.md) — `PgSnapshotStore`, policies, snapshot upcasters
- [Schema Evolution](docs/schema-evolution.md) — event upcasters, migrating event versions
- [Concurrency](docs/concurrency.md) — optimistic concurrency, `ConcurrencyError`, retry helper

### Projections

- [Overview](docs/projections/overview.md) — the three tiers and when to use each
- [Inline Projections](docs/projections/inline-projections.md) — transactional read models
- [Catch-up Projections](docs/projections/catch-up-projections.md) — checkpoint-based background processing
- [Async Projections](docs/projections/async-projections.md) — outbox pattern, batch vs perRow, DLQ
- [Single-Event Projections](docs/projections/single-event-projections.md) — `forEventType` helper

### Read Side

- [Query Builder](docs/query-builder.md) — fluent builder + raw SQL, JSONB, SQL injection protection
- [Outbox and DLQ](docs/outbox-and-dlq.md) — dead-letter queue, requeue, monitoring

### Operations

- [Observability](docs/observability.md) — runner observers, OpenTelemetry adapter, custom hooks
- [Schema Reference](docs/schema-reference.md) — all `eventfabric.*` tables, columns, indexes
- [Partitioning](docs/partitioning.md) — range partitioning, `PgPartitionManager`, archival

### Architecture

- [Architecture](docs/architecture.md) — package graph, design principles, extensibility

## Database Schema

`migrate(pool)` creates all tables automatically. For manual setup, see [Getting Started](docs/getting-started.md).

| Table | Purpose |
|---|---|
| `eventfabric.events` | Append-only event log with global ordering |
| `eventfabric.stream_versions` | Concurrency gatekeeper (one row per stream) |
| `eventfabric.outbox` | Transactional outbox for at-least-once async delivery |
| `eventfabric.outbox_dead_letters` | Dead-letter queue for poison messages |
| `eventfabric.projection_checkpoints` | Per-projection progress tracking |
| `eventfabric.snapshots` | Latest-only aggregate state snapshots |

Migration files: [`packages/postgres/migrations/`](packages/postgres/migrations/)

## Examples

- [`examples/banking-api`](examples/banking-api/) — Full banking application with accounts, transactions, transfers, inline + catch-up + async projections, event upcasters, query builder, OpenTelemetry observability
- [`examples/express-api`](examples/express-api/) — Minimal Express example with user registration

## External References

- [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) — Martin Fowler
- [CQRS](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs) — Microsoft Architecture Center
- [Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html) — Microservices.io
- [Projections in Event Sourcing](https://www.eventstore.com/blog/projections-in-event-sourcing) — Event Store Blog
- [Aggregate Pattern (DDD)](https://martinfowler.com/bliki/DDD_Aggregate.html) — Martin Fowler
- [Marten DB](https://martendb.io/) — The C#/.NET library that inspired EventFabric's Session API

## License

MIT
