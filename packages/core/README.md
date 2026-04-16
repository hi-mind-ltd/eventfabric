# @eventfabric/core

Framework-agnostic, **type-safe event sourcing core** for Node.js/TypeScript.

Provides the building blocks that persistence adapters (like `@eventfabric/postgres`) implement:

- `AggregateRoot` — implement event handlers + domain methods that `raise()` events.
- `InlineProjector` — transactional projections that run inside the same adapter transaction.
- `AsyncProjectionRunner` — outbox-based at-least-once delivery with topic filtering, retry, and DLQ.
- `CatchUpProjector` — checkpoint-based projections for internal state transitions.
- `forEventType` — helper to build single-event-type projections with full type narrowing.
- `withConcurrencyRetry` — retry helper for optimistic concurrency conflicts.
- Observer interfaces (`AsyncRunnerObserver`, `CatchUpProjectorObserver`) — vendor-neutral hooks for tracing and metrics (see `@eventfabric/opentelemetry`).

## Install

```bash
pnpm add @eventfabric/core
```

You'll typically use this alongside a persistence adapter:

```bash
pnpm add @eventfabric/postgres
```

## Usage

The recommended API is the Session pattern provided by `@eventfabric/postgres`:

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

## Defining an Aggregate

```ts
import { AggregateRoot, type HandlerMap } from "@eventfabric/core";

type UserState = { email?: string; displayName?: string };
type UserEvent = UserRegisteredV2 | UserEmailChangedV1;

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

See `@eventfabric/postgres` README for full examples including sessions, snapshots, projections, and outbox configuration.
