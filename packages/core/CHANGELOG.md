# @eventfabric/core

## 0.4.1

### Patch Changes

- 9ce0828: Harden tamper-evidence against a stripped chain and a bad secret.

  - **Strict verification:** `verifyStream` / `verifyAggregate` now fail a stream that has events without an `event_hash`. Before, a stream whose hashes (and `head_hash`) had all been set to NULL verified as ok with `eventsChecked: 0`, and its next append started a fresh chain. The result reports `unprotectedEvents`. For streams that predate tamper-evidence, pass `allowUnprotectedPrefix: true`. A stream whose events were all removed while `stream_versions` still records a version also fails.
  - **No dismissals in chained streams:** `PgEventStore.dismiss()` throws for an event in a hash-chained stream, and `verifyStream` fails a chained event marked dismissed. The `dismissed_*` columns are outside the hash and a dismissed event is hidden from replay, so a database writer could hide any event undetected.
  - **Hash format v2 covers `occurred_at`:** `computeEventHash` includes the timestamp when `ChainableEvent.occurredAt` is set. `PgEventStore` writes new chained events in v2, taking `occurred_at` from the application clock (millisecond precision). Events in v1 keep verifying and are counted in `legacyFormatEvents`. Upgrade verifying processes before or together with appending ones: an older release reports v2 events as a mismatch.
  - **Secret validation:** `toSecret` (used by `PgEventStore` and `PgChainAnchorSealer`) throws on a missing or empty secret. Before, `hashChain: { secret: undefined, enabledAggregates }` silently disabled chaining and an empty string was accepted.

- 6d1ca13: Fix data-loss and false-alarm bugs found in review.

  - **Outbox:** `ack`, `release`, `releaseWithError` and `deadLetter` take an optional `workerId` and only act while that worker still holds the lease. The async runner passes it, so a handler that outlived `leaseMs` can no longer commit twice (a late ack throws `LeaseLostError` and rolls back) or free another worker's lock. In batch mode a failure is charged only to the row that failed, so one poison row no longer sends its whole batch to the dead-letter queue.
  - **Saga timers:** new optional `SagaTimerStore.lockClaimed`. The scheduler re-checks each claimed timer at delivery and skips one that was cancelled or re-scheduled after the claim (round result `skipped`, observer hook `onTimerSkipped`, and `result="skipped"` on `eventfabric.saga.timer_fire_total`). `PgSagaTimerStore.markFired` only changes a claimed row, so a timer that re-schedules its own id keeps running.
  - **Session:** a snapshot written by `saveChangesAsync` now holds the state at the saved version. Before, a direct `append` snapshotted only the events of that save.
  - **Hash chain:** a process that has not registered a tamper-evident aggregate now extends its chained streams instead of breaking them (or refuses, without `hashChain.secret`). Payloads containing a `Date` no longer fail verification.
  - **Idempotency:** reusing an idempotency key for a different command type, or for the same type with a different payload, throws `IdempotencyKeyConflictError` instead of returning the other command's result. `@eventfabric/mediator-postgres` adds migration `018_command_request_hash` (a `request_hash` column), applied by `migrate(pool, { extensions: [commandsMigrations] })`.

- 9ce0828: Fix lower-priority bugs found in review.

  - **Snapshots (core, postgres):** a save that writes several events and jumps past a multiple of `everyNEvents` now snapshots (it used to snapshot only when the new version was an exact multiple). New `shouldSnapshot(policy, fromVersion, toVersion)` helper.
  - **Dead-letter reason (postgres):** the reason passed to `deadLetter()` is now stored (migration `019_outbox_dead_letter_reason` adds `outbox_dead_letters.reason`) and returned as `DlqItem.reason`. Run `migrate()` when upgrading.
  - **Partitioning (postgres):** `enablePartitioning()` places the first boundary above both `MAX(global_position)` and the sequence's current value, so appends don't fail with "no partition" when the sequence is ahead (rolled-back appends, deleted events).
  - **`loadByGlobalPositions` (postgres):** positions are sent as one array parameter, so very large batches don't exceed Postgres's 65,535-parameter limit.
  - **Anchor sealer (postgres):** members are inserted with array parameters, so a seal covering more than ~10,900 advanced streams no longer fails every time.
  - **In-memory idempotency store (mediator):** slots claimed or completed in a transaction that rolls back (including a failed commit) are removed, so a retry runs the handler instead of returning an uncommitted result. New optional `IdempotencyStore.afterCommit` / `afterRollback`, called by the bus.

- 9ce0828: Fix robustness bugs found in review.

  - **Query builder (postgres):** the fluent builder no longer puts column names, operators, sort direction, JSONB keys, `limit` or `offset` into the SQL text unchecked. JSONB keys, `limit` and `offset` are parameters; column names must be plain identifiers; operators and sort direction must come from a fixed set. Invalid input throws.
  - **Migrations (postgres):** concurrent `migrate()` calls (several app instances starting at once) are serialized with an advisory lock, and `enablePartitioning()` re-checks under the table lock, so a second caller backs off instead of breaking the new partitioned table. New `PgPartitionManager.enablePartitioningOn(client)`.
  - **Saga loops (sagas):** the timer scheduler and command dispatcher keep running after a round throws (e.g. the database is down). They report via the new `onLoopError` observer hook, back off (`errorBackoff` option), and `stop()` interrupts the sleep. `sagas-opentelemetry` counts `eventfabric.saga.loop_error_total`.
  - **Failed saves (core, postgres):** `Repository.save()` and `saveChangesAsync()` change the in-memory aggregate only after the commit. A failed save keeps the pending events and old version, so a retry writes them instead of silently returning `null`. New `AggregateRoot.peekPendingEvents()` and `markCommitted()`.
  - **Backoff (core):** the first retry waits `minMs`, not `minMs * factor`.
  - **OpenTelemetry:** per-event, per-command and per-instance ids (`global_position`, positions, `command_id`, `idempotency_key`, `principal_id`, `correlation_id`, `saga_instance`, `timer_id`) are no longer metric attributes; they stay on spans. Dashboards that grouped metrics by these labels need updating.

- 9ce0828: `AggregateRoot.raise()` applies the event after a JSON round trip, the shape it is stored and replayed in. Live state now matches the state after a reload (a `Date` in an event becomes its ISO string; `undefined` fields are dropped), and a `bigint` in an event throws at `raise()` with a clear message. Handlers that relied on receiving a `Date` object from a live event must read an ISO string instead (they already had to on reload).
- 9ce0828: Tighten tenant and caller checks.

  - **Command bus (mediator):** a command whose `metadata.tenantId` would switch the transaction to another tenant is rejected with `UnvalidatedTenantError` unless the bus has a `tenantValidator` or the new `trustTenantMetadata: true`. The bus used to follow the metadata unchecked. Single-tenant setups are not affected. A multi-tenant bus that a saga dispatcher sends to needs one of the two.
  - **Idempotency (mediator, mediator-postgres):** the principal that first used a key is stored (migration `020_command_principal` adds `command_idempotency.principal_id`). The same key from a different principal throws `IdempotencyKeyConflictError` with `reason: "principal"` instead of returning the first caller's result. Run `migrate()` before the new version handles commands.
  - **`loadGlobal` (core, postgres):** without `tenantId` it returns the transaction's tenant only. Cross-tenant reads need `allTenants: true`.

## 0.4.0

### Minor Changes

- 015b888: fix(async-runner): stop skipping outbox rows that sit at or below a projection checkpoint

  The async runner used to skip any event at or below the projection's checkpoint and then ack (delete) its outbox row. Global positions are allocated when an event is inserted, not when its transaction commits, so the skip silently dropped:

  - events whose transaction committed after a higher position was processed,
  - rows requeued from the DLQ, and
  - rows handled out of order by concurrent runner replicas.

  The outbox row is now the only record of delivery, and it is deleted in the same transaction as the handlers that processed it. The runner no longer reads or writes `projection_checkpoints`. The `checkpoints` constructor argument of `AsyncProjectionRunner` is deprecated and ignored, and `createAsyncProjectionRunner` no longer passes one. Handlers must be idempotent: delivery is at least once.

- 015b888: feat(catch-up): safe to run the same projection on several instances at once

  `ProjectionCheckpointStore` has a new optional method, `claim(tx, projection, tenant)`. It locks the checkpoint for the rest of the transaction and returns `null` without waiting when another transaction holds it. The catch-up projector claims the checkpoint before reading each batch. Any number of instances (processes, nodes) can now run the same projection: each batch is processed by exactly one of them, and a busy (projection, tenant) pair is skipped until the next round. `PgProjectionCheckpointStore` implements it with `SELECT … FOR UPDATE SKIP LOCKED`. Custom checkpoint stores without `claim` keep the previous behaviour, where concurrent instances may process the same events twice.

- 015b888: fix(catch-up): never skip events that commit after a higher position (high water mark)

  Global positions are allocated at INSERT, not at COMMIT. The catch-up projector read `global_position > checkpoint` with no upper bound, so an event still in flight below a committed higher position was skipped for good once the checkpoint moved past it.

  Reads are now bounded by a **high water mark**: the highest position at or below which every event is final.

  - `@eventfabric/core`: new `HighWaterMark` interface. `CatchUpProjector` takes an optional fourth constructor argument. When it is set, tenant discovery and every batch read stop at the mark. New `CatchUpOptions.highWaterMarkWaitMs` (default 2000) is how long a call waits for in-flight transactions to settle. `EventStore.loadGlobal` and `discoverActiveTenants` accept an optional `toGlobalPositionInclusive`. Custom event stores must honour it to get the guarantee.
  - `@eventfabric/postgres`: new `PgHighWaterMark`, based on transaction snapshots (`pg_current_snapshot`, so PostgreSQL 13+). A sampled position becomes safe once every transaction that was in flight at the time of the sample has finished. Gaps from rolled-back transactions are passed over naturally. `createCatchUpProjector` always wires one in. It accepts `{ highWaterMark: { skipLiveTransactionsAfterMs } }` as an escape hatch for long-running write transactions, which otherwise hold the mark back, the same as Marten's default. The deprecated `PgCatchUpProjector` takes an optional `pool` argument to enable it.

- 015b888: fix(outbox): stop claimed outbox rows from staying locked forever

  - `AsyncRunnerOptions.leaseMs` (default 5 minutes): a claimed row whose lock is older than the lease is treated as abandoned and can be claimed again, so rows held by a worker that crashed after claiming are recovered.
  - `perRow` mode releases the claimed rows it never reached, whether the loop ended because of a handler failure or because the runner was stopped. These rows do not count towards `maxAttempts`.
  - `batch` mode dead-letters rows whose event cannot be loaded, as `perRow` mode already did, instead of leaving them locked.

  **Breaking for custom `OutboxStore` implementations:** the interface has a new required method, `release(tx, ids)`, which unlocks rows and undoes the `attempts` increment from the claim. `claimBatch` also accepts an optional `leaseMs`. `PgOutboxStore` implements both.

- 015b888: feat: ProjectionDaemon, a Marten-style async daemon for projections

  `ProjectionDaemon` (core) and `createProjectionDaemon(pool, eventStore, projections, opts)` (postgres) run projections continuously against the event log:

  - **Checkpoints per (projection, tenant).** A projection added later back-fills from the start of the log, and `rebuild(name)` replays one from scratch. It calls the new optional `CatchUpProjection.reset(tx)` per tenant to clear the read model, resets the checkpoint (new optional `ProjectionCheckpointStore.reset`) and drops that projection's dead letters.
  - **High water mark.** Reads never pass an event whose transaction is still in flight, so late commits are not skipped.
  - **Several instances.** Each batch claims its checkpoint, so any number of instances can run the same projections and each event is handled once. Instances running different projections each see every event.
  - **Failures.** A failing event is retried with backoff. Events before it in the batch are committed first, so one bad event only holds back what comes after it. After `maxAttempts` (default 10) the event goes to the new `eventfabric.projection_dead_letters` table (migration `016_projection_dead_letters`) and the checkpoint moves past it. `replayDeadLetter(id)` and `listDeadLetters()` manage dead letters. The observer gains `onEventDeadLettered`.

  New exports: `ProjectionDaemon`, `ProjectionDaemonOptions`, `ProjectionDeadLetterStore`, `ProjectionDeadLetter` (core); `createProjectionDaemon`, `PgProjectionDeadLetterStore` (postgres).

  Use the daemon for projections. Keep the outbox `AsyncProjectionRunner` for external delivery: each outbox row goes to whichever runner claims it, so runners with different handlers must split the outbox with `claimTopic`.

- 015b888: feat(sagas): run sagas on the projection daemon; dead-letter replays are no longer skipped

  - New `sagaAsProjection(saga, stores)` wraps a saga for the `ProjectionDaemon`. Events reach each saga in `global_position` order, never past the high water mark, so the `lastEventPos` duplicate check is correct. Several daemon instances can run side by side. A concurrent state advance throws `ConcurrencyError` and is retried. Events that keep failing are dead-lettered. This is the equivalent of feeding a Wolverine saga from a Marten event subscription.
  - `CatchUpProjection.handle` receives an optional third argument, `ProjectionHandleContext` (`{ replay: boolean }`). `ProjectionDaemon.replayDeadLetter` passes `replay: true`.
  - `applySagaTransition` accepts `{ replay: true }` to bypass the `globalPosition <= lastEventPos` check. Without it, replaying a dead-lettered saga event was a silent no-op. `lastEventPos` never moves backwards now.
  - `sagaAsAsyncProjection` (outbox runner) is documented as unsafe for sagas whose events can be produced concurrently. The outbox does not deliver in position order, so an event that commits after a later one for the same instance is skipped as "already applied".

### Patch Changes

- 015b888: fix(catch-up): do not stall on a batch made entirely of dismissed events

  The projector asked the store to drop dismissed events. `PgEventStore.loadGlobal` does that after applying `LIMIT`, so a batch of `batchSize` consecutive dismissed events came back empty. The projector treated that as "caught up" and never moved past them. It now always loads dismissed events and skips them itself, so the checkpoint advances past them.

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

## 0.2.0

### Minor Changes

- b8b08cc: API changes in support of the new `@eventfabric/mediator` + `@eventfabric/sagas` family. (Linked group — same bump applies to `@eventfabric/postgres` and `@eventfabric/opentelemetry`.)

  **`@eventfabric/postgres`:**

  - `migrate()` gains an `extensions` option accepting third-party `MigrationSet[]`. The `MigrationSet` type (`{ source, dir, migrations[] }`) is now exported. Extension migrations apply after core migrations and before partitioning.
  - `Session.saveChangesAsync({ meta })` now accepts optional `{ correlationId?, causationId? }` event metadata, threaded into `store.append`. Typical author: a command handler calling `commandContextToEventMeta(ctx)`.
  - `PgUnitOfWork` is now publicly exported (was previously internal). Required by external consumers like `CommandBus` and `SagaCommandDispatcher`.
  - `MigrateObserver` hook event fields gained `source` so observers can attribute migrations to core vs. extension packages.

  **`@eventfabric/core`:**

  - Removed the `commands/` and `sagas/` modules from the public surface — these have moved to `@eventfabric/mediator` and `@eventfabric/sagas` respectively. **Breaking** if you imported `Command`, `CommandBus`, `Saga`, `IdempotencyStore`, etc. from `@eventfabric/core`; update the import to the new package.
  - Added `TenantAwareUnitOfWork<TTx>` type — the formal contract for a `UnitOfWork` that also exposes `forTenant(tenantId)`. Used by the mediator and saga packages for per-command tenant narrowing without runtime ducktyping.

  **`@eventfabric/opentelemetry`:**

  - Removed `createSagaObserver` and `createSagaQueueGauges` — these have moved to `@eventfabric/sagas-opentelemetry`. **Breaking** for the same reason as above.

## 0.2.0-beta.0

### Minor Changes

- API changes in support of the new `@eventfabric/mediator` + `@eventfabric/sagas` family. (Linked group — same bump applies to `@eventfabric/postgres` and `@eventfabric/opentelemetry`.)

  **`@eventfabric/postgres`:**

  - `migrate()` gains an `extensions` option accepting third-party `MigrationSet[]`. The `MigrationSet` type (`{ source, dir, migrations[] }`) is now exported. Extension migrations apply after core migrations and before partitioning.
  - `Session.saveChangesAsync({ meta })` now accepts optional `{ correlationId?, causationId? }` event metadata, threaded into `store.append`. Typical author: a command handler calling `commandContextToEventMeta(ctx)`.
  - `PgUnitOfWork` is now publicly exported (was previously internal). Required by external consumers like `CommandBus` and `SagaCommandDispatcher`.
  - `MigrateObserver` hook event fields gained `source` so observers can attribute migrations to core vs. extension packages.

  **`@eventfabric/core`:**

  - Removed the `commands/` and `sagas/` modules from the public surface — these have moved to `@eventfabric/mediator` and `@eventfabric/sagas` respectively. **Breaking** if you imported `Command`, `CommandBus`, `Saga`, `IdempotencyStore`, etc. from `@eventfabric/core`; update the import to the new package.

  **`@eventfabric/opentelemetry`:**

  - Removed `createSagaObserver` and `createSagaQueueGauges` — these have moved to `@eventfabric/sagas-opentelemetry`. **Breaking** for the same reason as above.

## 0.1.10

### Patch Changes

- e03f235: **Fix:** export `InlineProjection`, `Snapshot`, `SnapshotPolicy`, `SnapshotStore`, and `AsyncProcessorConfig` from `@eventfabric/core`.

  Previous patch attempted to re-export `InlineProjection` from the barrel, but the bundled `dist/index.d.ts` still omitted it. Root cause: with `treeshake: true` in tsup, `rollup-plugin-dts` inlines an interface as a private `declare` (and drops the public re-export) when its source file is reached via a value-style `import { Foo }` rather than `import type { Foo }`. Switched the offending imports in `inline-projector.ts`, `repository.ts`, and `snapshot-store.ts` to `import type`. Also added the snapshot module to the package barrel — `Snapshot`, `SnapshotPolicy`, and `SnapshotStore` were never re-exported, leaving consumers unable to type a custom `Repository` options object — and exposed `AsyncProcessorConfig` for the same reason.

## 0.1.9

### Patch Changes

- e03f235: **Fix:** export `InlineProjection` interface from `@eventfabric/core`.

  The interface was defined but never re-exported from the package barrel, so consumers couldn't import it to type their own inline projections. Also renamed the source file from `inline-protection.ts` to `inline-projection.ts` to fix the typo.

## 0.1.8

### Patch Changes

- 7627b12: **Fix:** switch each package's `build` from raw `tsc` to `tsup`, producing a single bundled `dist/index.js` plus a single `dist/index.d.ts`.

  The previous build emitted extensionless re-exports in the published `dist/` (e.g. `export * from './types'`), which are not resolvable by Node's strict ESM loader or by TypeScript consumers using `moduleResolution: "nodenext"`. Affected consumers saw errors like `Cannot find module '.../dist/types' imported from .../dist/index.js` at runtime and `has no exported member 'HandlerMap'` at compile time.

  Bundling with tsup eliminates the internal re-export chain entirely — each package ships one ESM module with one types file — so consumers load it cleanly regardless of their module resolution strategy, and the published artifact is a few KB smaller. Source is unchanged; `typecheck` still runs against `tsc` for full type coverage.

  No API changes.

## 0.1.7

### Patch Changes

- 8bb3c69: **Fix:** `loadAggregateAsync` now uses the registered snapshot store instead of always replaying the full event stream. When a snapshot store is registered for the aggregate type, the session loads the latest snapshot, hydrates the aggregate from it, and replays only events after the snapshot's version. Falls back to full replay when no snapshot store is registered or no snapshot has been written yet.

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
