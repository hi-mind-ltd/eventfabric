# EventFabric

Type-safe, small-footprint event sourcing for TypeScript + PostgreSQL.

EventFabric provides the building blocks for event-sourced applications: aggregates, an event store with optimistic concurrency, three tiers of projections (inline, catch-up, async/outbox), snapshot support, a type-safe query builder, schema evolution via event upcasters, and vendor-neutral observability hooks.

## Packages

| Package | Description |
|---|---|
| [`@eventfabric/core`](packages/core/) | Framework-agnostic interfaces, types, and orchestration logic. Zero runtime dependencies. |
| [`@eventfabric/postgres`](packages/postgres/) | PostgreSQL adapter — event store, session, snapshots, outbox, query builder. |
| [`@eventfabric/opentelemetry`](packages/opentelemetry/) | OpenTelemetry adapter — spans, metrics, and context propagation for projection runners. |

## Quick Start

```bash
pnpm add @eventfabric/core @eventfabric/postgres pg
```

```typescript
import { AggregateRoot } from "@eventfabric/core";
import { PgEventStore, SessionFactory } from "@eventfabric/postgres";
import { Pool } from "pg";

// 1. Define events
type AccountEvent =
  | { type: "Opened"; version: 1; owner: string }
  | { type: "Deposited"; version: 1; amount: number };

// 2. Define aggregate
class Account extends AggregateRoot<{ balance: number }, AccountEvent> {
  static readonly aggregateName = "Account";
  protected handlers = {
    Opened: (s) => { s.balance = 0; },
    Deposited: (s, e) => { s.balance += e.amount; },
  };
  constructor(id: string) { super(id, { balance: 0 }); }
  open(owner: string) { this.raise({ type: "Opened", version: 1, owner }); }
  deposit(amount: number) { this.raise({ type: "Deposited", version: 1, amount }); }
}

// 3. Use it
import { migrate } from "@eventfabric/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool); // creates all tables on first run, no-op after

const store = new PgEventStore<AccountEvent>();
const factory = new SessionFactory(pool, store);
factory.registerAggregate(Account, ["Opened", "Deposited"]);

const session = factory.createSession();
const account = await session.loadAggregateAsync<Account>("acc-1");
account.deposit(100);
await session.saveChangesAsync();
```

## Documentation

### Design

- [High-Level Design (HLD)](docs/high-level-design.md) — system overview, data flow diagrams, architecture decisions
- [Low-Level Design (LLD)](docs/low-level-design.md) — class internals, algorithms, sequence diagrams, SQL generation

### Guides

- [Getting Started](docs/getting-started.md) — installation, database setup, first aggregate
- [Core Concepts](docs/core-concepts.md) — event sourcing fundamentals, CQRS, how EventFabric maps to them

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

- [`examples/banking-api`](examples/banking-api/) — Full banking application with accounts, transactions, transfers, inline + catch-up + async projections, event upcasters, query builder, observability
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
