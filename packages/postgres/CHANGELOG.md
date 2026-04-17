# @eventfabric/postgres

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
