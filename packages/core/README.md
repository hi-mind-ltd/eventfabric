# @eventfabric/core

Framework-agnostic, **type-safe event sourcing core** for Node.js/TypeScript.

Includes:
- `AggregateRoot` — users implement only event handlers + domain methods that `raise()` events.
- `Repository` — loads/saves a single aggregate type, optionally snapshots + inline projections.
- `InlineProjector` — transactional projections (runs inside the same adapter transaction).

Persistence adapters live in separate packages (e.g. `@eventfabric/postgres`).

## Install

```bash
pnpm add @eventfabric/core
```

## Usage (high level)

```ts
const userRepo = new Repository<UserAggregate, UserState, UserEvent, Tx>(
  "User",
  uow,
  eventStore,
  (id, snap) => new UserAggregate(id, snap),
  { 
    inlineProjector, 
    snapshotStore, 
    snapshotPolicy: { everyNEvents: 50 },
    asyncProcessor: { enabled: true, topic: "user" }
  }
);

const user = await userRepo.load("user-1");
user.changeEmail("new@mail.com");

await userRepo.save(user);
```

See `@eventfabric/postgres` README for a full Postgres example.
