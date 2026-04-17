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
pnpm add @eventfabric/core @eventfabric/postgres pg
```

## Quick Start

### 1. Define Events

```ts
// user.events.ts
export type UserRegisteredV1 = {
  type: "UserRegistered";
  version: 1;
  userId: string;
  email: string;
  displayName: string;
};

export type UserEmailChangedV1 = {
  type: "UserEmailChanged";
  version: 1;
  userId: string;
  email: string;
};

export type UserEvent = UserRegisteredV1 | UserEmailChangedV1;

// Factory functions — type and version baked in
export const UserRegistered = (data: Omit<UserRegisteredV1, "type" | "version">): UserRegisteredV1 =>
  ({ type: "UserRegistered", version: 1, ...data });

export const UserEmailChanged = (data: Omit<UserEmailChangedV1, "type" | "version">): UserEmailChangedV1 =>
  ({ type: "UserEmailChanged", version: 1, ...data });
```

### 2. Define an Aggregate

```ts
// user.aggregate.ts
import { AggregateRoot, type HandlerMap } from "@eventfabric/core";
import type { UserEvent } from "./user.events";

export type UserState = { email?: string; displayName?: string };

export class UserAggregate extends AggregateRoot<UserState, UserEvent> {
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

### 3. Wire Up the Store and Session

```ts
// app.ts
import { Pool } from "pg";
import {
  PgEventStore,
  PgSnapshotStore,
  SessionFactory,
  migrate,
  createAsyncProjectionRunner
} from "@eventfabric/postgres";
import type { AsyncProjection } from "@eventfabric/core";
import type { PgTx } from "@eventfabric/postgres";
import { UserAggregate } from "./user.aggregate";
import { UserRegistered } from "./user.events";
import type { UserEvent } from "./user.events";

// 1. Create pool and run migrations
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool);

// 2. Create store (defaults to eventfabric.* tables — no table names needed)
const store = new PgEventStore<UserEvent>();

// 3. Create factory and register aggregates
const factory = new SessionFactory(pool, store);
factory.registerAggregate(UserAggregate, [
  "UserRegistered", "UserEmailChanged"
], "user", {
  snapshotStore: new PgSnapshotStore()
});

// 4. Use in request handlers
app.post("/users/:id/register", async (req, res) => {
  const session = factory.createSession();
  const { id } = req.params;
  session.startStream(id, UserRegistered({ userId: id, email: req.body.email, displayName: req.body.name }));
  await session.saveChangesAsync();
  res.json({ ok: true });
});

app.post("/users/:id/change-email", async (req, res) => {
  const session = factory.createSession();
  const user = await session.loadAggregateAsync<UserAggregate>(req.params.id);
  user.changeEmail(req.body.email);
  await session.saveChangesAsync();
  res.json({ ok: true });
});
```

### 4. Add an Async Projection

```ts
// Send a welcome email when a user registers
const welcomeEmailProjection: AsyncProjection<UserEvent, PgTx> = {
  name: "welcome-email",
  topicFilter: { mode: "include", topics: ["user"] },
  async handle(_tx, env) {
    if (env.payload.type === "UserRegistered") {
      await sendEmail(env.payload.email, "Welcome!", `Hello ${env.payload.displayName}!`);
    }
  }
};

const runner = createAsyncProjectionRunner(pool, store, [welcomeEmailProjection], {
  workerId: "email-worker-1",
  batchSize: 10,
  maxAttempts: 5
});

runner.start(new AbortController().signal);
```

### 5. Multi-Tenancy

```ts
import { ConjoinedTenantResolver, PerDatabaseTenantResolver } from "@eventfabric/postgres";

// Option A: Conjoined — all tenants share one database, isolated by tenant_id column
const resolver = new ConjoinedTenantResolver(pool);
await resolver.migrate();

const factory = new SessionFactory(resolver, store);
const session = factory.createSession("tenant-acme");  // scoped to tenant

// Option B: Per-database — each tenant gets their own database
const resolver = new PerDatabaseTenantResolver({
  acme:    new Pool({ connectionString: "postgres://localhost/acme_db" }),
  contoso: new Pool({ connectionString: "postgres://localhost/contoso_db" }),
});
await resolver.migrate();  // runs on all tenant databases

const factory = new SessionFactory(resolver, store);
const session = factory.createSession("acme");  // uses acme's pool
```

See [multi-tenancy docs](https://github.com/hi-mind-ltd/eventfabric/blob/main/packages/postgres/docs/multi-tenancy.md) for full details.

## Further Reading

- [`@eventfabric/postgres` README](https://github.com/hi-mind-ltd/eventfabric/blob/main/packages/postgres/README.md) — sessions, snapshots, inline projections, outbox, DLQ
- [`@eventfabric/opentelemetry` README](https://github.com/hi-mind-ltd/eventfabric/blob/main/packages/opentelemetry/README.md) — tracing and metrics for projection runners
