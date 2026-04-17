# @eventfabric/core

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

## 0.1.4

### Patch Changes

- 3ba92d4: Align package versions across all linked packages. Add OpenTelemetry README with usage details for async runner and catch-up observers. Update core README to show Session API instead of deprecated Repository pattern.

## 0.1.2

### Patch Changes

- f54bce9: Add partitioning, migrator, and performance optimizations

## 0.1.1

### Patch Changes

- 4438c66: Initial release setup with npm Trusted Publishing
