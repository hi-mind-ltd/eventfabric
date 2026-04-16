# @eventfabric/core

Framework-agnostic, **type-safe event sourcing core** for Node.js/TypeScript.

Includes:
- `AggregateRoot` — implement event handlers + domain methods that `raise()` events.
- `SessionFactory` / `Session` — load/save aggregates with identity map, atomic multi-aggregate saves, snapshots, and outbox routing (via `@eventfabric/postgres`).
- `InlineProjector` — transactional projections (runs inside the same adapter transaction).
- `CatchUpProjector` — checkpoint-based projections for internal state transitions.
- `AsyncProjectionRunner` — outbox-based at-least-once delivery with topic filtering, retry, and DLQ.
- Event factory functions — define `type` and `version` once, never repeat them.

Persistence adapters live in separate packages (e.g. `@eventfabric/postgres`).

## Install

```bash
pnpm add @eventfabric/core
```

## Usage

```ts
import { SessionFactory, PgEventStore, PgSnapshotStore } from "@eventfabric/postgres";

const factory = new SessionFactory(pool, store);

factory.registerAggregate(UserAggregate, [
  "UserRegistered", "UserEmailChanged"
], "user", { snapshotStore });

// Per request:
const session = factory.createSession();
const user = await session.loadAggregateAsync<UserAggregate>("user-1");
user.changeEmail("new@mail.com");
await session.saveChangesAsync();
```

See `@eventfabric/postgres` README for a full Postgres example.
