# @eventfabric/postgres

## 0.3.0

### Minor Changes

- 073ced2: Add opt-in, tamper-evident event chaining — primitives + contract in `@eventfabric/core`, Postgres implementation in `@eventfabric/postgres` (migration `015_event_hash_chain`).

  **`@eventfabric/core`**

  - Backend-agnostic hash-chain primitives: `canonicalJson`, `computeEventHash`, `streamGenesis` / `anchorGenesis`, `computeAnchorHash`, `hashesEqual`, `toSecret`, and the `ChainableEvent` / `AnchorMember` types. These define the canonical chain _format_ so it isn't reinvented per backend.
  - `TamperEvidentEventStore<E, TTx>` — an optional capability interface (separate from base `EventStore`) declaring `verifyStream` / `verifyAggregate`, plus the `ChainVerificationResult` type. Lets app code and future backends depend on the verification contract rather than a concrete adapter.
  - `AggregateRoot.tamperEvident` static (default `false`) — first-classes the per-aggregate toggle as an intrinsic property of the aggregate, read by the storage adapter at registration.

  **`@eventfabric/postgres`**

  - `PgEventStore implements TamperEvidentEventStore`. Turn chaining on per aggregate type via `static tamperEvident = true` on the aggregate class (or `registerAggregate(..., { tamperEvident: true })`), plus `new PgEventStore({ hashChain: { secret } })`. Each protected event stores `event_hash = HMAC(secret, prevHash ‖ canonical(event))`; `stream_versions.head_hash` caches the head so the write path reads no extra rows. Unprotected aggregates keep the original SQL path (NULL hashes) — stores that never opt in don't even need migration 015.
  - `verifyStream` / `verifyAggregate` detect payload/metadata mutation, event removal, and tail truncation; a soft `dismiss()` does not break the chain.
  - **Per-tenant anchor (`PgChainAnchorSealer`).** An async `seal(tx)` snapshots the tenant's chained stream heads from a consistent MVCC cut into an HMAC-chained anchor (tables `event_chain_anchors` + `event_chain_anchor_members`); `verifyAnchors(tx)` re-derives the chain and confirms every sealed head is still live — catching whole-stream deletion and clean stream rollbacks that per-stream verification alone cannot. `PgChainAnchorRunner` schedules sealing across all tenants on an interval (`start(signal)` idiom).
  - Integrity is HMAC-SHA256 keyed by an app-held secret, never stored in the database.

### Patch Changes

- Updated dependencies [073ced2]
  - @eventfabric/core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [b8b08cc]
  - @eventfabric/core@0.2.0

## 0.2.0-beta.0

### Patch Changes

- Updated dependencies
  - @eventfabric/core@0.2.0-beta.0

## 0.1.10

### Patch Changes

- e03f235: **Fix:** export `InlineProjection`, `Snapshot`, `SnapshotPolicy`, `SnapshotStore`, and `AsyncProcessorConfig` from `@eventfabric/core`.

  Previous patch attempted to re-export `InlineProjection` from the barrel, but the bundled `dist/index.d.ts` still omitted it. Root cause: with `treeshake: true` in tsup, `rollup-plugin-dts` inlines an interface as a private `declare` (and drops the public re-export) when its source file is reached via a value-style `import { Foo }` rather than `import type { Foo }`. Switched the offending imports in `inline-projector.ts`, `repository.ts`, and `snapshot-store.ts` to `import type`. Also added the snapshot module to the package barrel — `Snapshot`, `SnapshotPolicy`, and `SnapshotStore` were never re-exported, leaving consumers unable to type a custom `Repository` options object — and exposed `AsyncProcessorConfig` for the same reason.

- Updated dependencies [e03f235]
  - @eventfabric/core@0.1.10

## 0.1.9

### Patch Changes

- e03f235: **Fix:** export `InlineProjection` interface from `@eventfabric/core`.

  The interface was defined but never re-exported from the package barrel, so consumers couldn't import it to type their own inline projections. Also renamed the source file from `inline-protection.ts` to `inline-projection.ts` to fix the typo.

- Updated dependencies [e03f235]
  - @eventfabric/core@0.1.9

## 0.1.8

### Patch Changes

- 7627b12: **Fix:** switch each package's `build` from raw `tsc` to `tsup`, producing a single bundled `dist/index.js` plus a single `dist/index.d.ts`.

  The previous build emitted extensionless re-exports in the published `dist/` (e.g. `export * from './types'`), which are not resolvable by Node's strict ESM loader or by TypeScript consumers using `moduleResolution: "nodenext"`. Affected consumers saw errors like `Cannot find module '.../dist/types' imported from .../dist/index.js` at runtime and `has no exported member 'HandlerMap'` at compile time.

  Bundling with tsup eliminates the internal re-export chain entirely — each package ships one ESM module with one types file — so consumers load it cleanly regardless of their module resolution strategy, and the published artifact is a few KB smaller. Source is unchanged; `typecheck` still runs against `tsc` for full type coverage.

  No API changes.

- Updated dependencies [7627b12]
  - @eventfabric/core@0.1.8

## 0.1.7

### Patch Changes

- 8bb3c69: **Fix:** `loadAggregateAsync` now uses the registered snapshot store instead of always replaying the full event stream. When a snapshot store is registered for the aggregate type, the session loads the latest snapshot, hydrates the aggregate from it, and replays only events after the snapshot's version. Falls back to full replay when no snapshot store is registered or no snapshot has been written yet.
- Updated dependencies [8bb3c69]
  - @eventfabric/core@0.1.7

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
