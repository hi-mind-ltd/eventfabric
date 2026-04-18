# @eventfabric/postgres

## 0.1.6

### Patch Changes

- 38db6da: **Fix (contains narrow breaking changes):** Catch-up and async projections are now properly tenant-aware under conjoined multi-tenancy. Before this change, projections silently read and wrote data in the wrong tenant when events were raised under a non-default tenant — a data-loss bug under any real multi-tenant load.

  Released as a patch because `createCatchUpProjector(pool, store)` / `createAsyncProjectionRunner(pool, store, projections, opts)` — the factories used by almost all consumers — have unchanged signatures and require no code updates. The breaking changes affect only users who implement `ProjectionCheckpointStore` / `EventStore` themselves, or who bypass the factories and call the `CatchUpProjector` / `AsyncProjectionRunner` constructors directly.

  ### What changed

  - `ProjectionCheckpointStore.get` / `set` now take a `tenantId` argument. Checkpoints are keyed by `(projection_name, tenant_id)`.
  - `EventStore.loadGlobal` takes an optional `tenantId` filter; a new `EventStore.discoverActiveTenants` method returns the tenants with pending work past a given global position.
  - `CatchUpProjector` now takes a `TenantScopedUnitOfWorkFactory` (instead of `UnitOfWork`). Each round it discovers active tenants, opens one transaction per tenant, and advances a per-tenant checkpoint. Tenants are round-robined for fairness; a handler failure for tenant A isolates to A only. Use `createCatchUpProjector(pool, store)` as before — the pg layer handles the factory wiring.
  - `AsyncProjectionRunner` likewise takes the factory. Outbox claim/ack/dead-letter still run cross-tenant; handler invocations narrow the transaction to the event's tenant.
  - `PgUnitOfWork` implements `TenantScopedUnitOfWorkFactory` with `forTenant(id)` and `narrow(tx, id)`.

  ### Migration

  **Database:** Migration `009_per_tenant_projection_checkpoints` drops the old `projection_checkpoints` PK on `projection_name` and replaces it with composite `(projection_name, tenant_id)`. Run `migrate(pool)` at startup as usual — the new migration is applied automatically.

  **Existing deployments:** Checkpoints written under the old scheme are preserved and associated with `tenant_id = 'default'`. If your deployment had non-default tenants processing events under the old scheme, those tenants will re-process their events from `global_position = 0` after upgrade (handlers must be idempotent — they were supposed to be anyway). Single-tenant deployments see no behavioural change.

  **Projection authors:** `loadStream` / `append` inside a projection handler now filter by the correct tenant automatically — delete any manual `{ client: tx.client, tenantId: env.tenantId }` workarounds.

  **If you implement `ProjectionCheckpointStore` yourself:** update signatures to include `tenantId`. If you implement `EventStore`, add `discoverActiveTenants` and accept `tenantId?` on `loadGlobal`.

- Updated dependencies [38db6da]
  - @eventfabric/core@0.1.6

## 0.1.5

### Patch Changes

- 44f3472: Add conjoined multi-tenancy support with `TenantResolver`. All tables now include a `tenant_id` column (DEFAULT 'default' for backwards compatibility). `SessionFactory` accepts a `Pool` (single-tenant) or a `TenantResolver` (multi-tenant). `PgEventStore` and `PgSnapshotStore` constructors refactored to options bag.

  ### Migration guide

  **PgEventStore** — positional args replaced with options bag:

  ```typescript
  // Before
  new PgEventStore("eventfabric.events", "eventfabric.outbox", myUpcaster);
  // After
  new PgEventStore({ upcaster: myUpcaster });
  // Or with defaults (most common)
  new PgEventStore();
  ```

  **PgSnapshotStore** — positional args replaced with options bag:

  ```typescript
  // Before
  new PgSnapshotStore("eventfabric.snapshots", 2, upcasters);
  // After
  new PgSnapshotStore({ currentSchemaVersion: 2, upcasters });
  // Or with defaults (most common)
  new PgSnapshotStore();
  ```

  **Multi-tenancy** — opt-in, no changes needed for single-tenant:

  ```typescript
  // Single-tenant (unchanged)
  const factory = new SessionFactory(pool, store);
  const session = factory.createSession();

  // Multi-tenant (conjoined)
  const resolver = new ConjoinedTenantResolver(pool);
  const factory = new SessionFactory(resolver, store);
  const session = factory.createSession("tenant-acme");
  ```

- Updated dependencies [44f3472]
  - @eventfabric/core@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [3ba92d4]
  - @eventfabric/core@0.1.4

## 0.1.3

### Patch Changes

- 3b5ec98: Refactor `registerAggregate` from positional args to options bag and add required `outboxTopic` parameter. Session now sets per-aggregate outbox topics on every event, fixing silent routing failures where topic-filtered async projections would never match events saved through Session.

  ### Breaking change

  `registerAggregate` signature changed from positional snapshot args to `(AggregateClass, eventTypes, outboxTopic, opts?)`.

  ### Migration guide

  **Before:**

  ```typescript
  factory.registerAggregate(
    AccountAggregate,
    ["AccountOpened", "AccountDeposited"],
    snapshotStore
  );

  factory.registerAggregate(
    AccountAggregate,
    ["AccountOpened", "AccountDeposited"],
    snapshotStore,
    { everyNEvents: 50 },
    1
  );
  ```

  **After:**

  ```typescript
  factory.registerAggregate(
    AccountAggregate,
    ["AccountOpened", "AccountDeposited"],
    "account",
    { snapshotStore }
  );

  factory.registerAggregate(
    AccountAggregate,
    ["AccountOpened", "AccountDeposited"],
    "account",
    {
      snapshotStore,
      snapshotPolicy: { everyNEvents: 50 },
      snapshotSchemaVersion: 1,
    }
  );
  ```

  The `outboxTopic` string (3rd argument) is required. It sets the topic on every outbox row so that async projections with `topicFilter: { mode: "include", topics: ["account"] }` correctly match events from this aggregate.

## 0.1.2

### Patch Changes

- f54bce9: Add partitioning, migrator, and performance optimizations
- Updated dependencies [f54bce9]
  - @eventfabric/core@0.1.2

## 0.1.1

### Patch Changes

- 4438c66: Initial release setup with npm Trusted Publishing
- Updated dependencies [4438c66]
  - @eventfabric/core@0.1.1
