---
"@eventfabric/core": patch
"@eventfabric/postgres": patch
"@eventfabric/opentelemetry": patch
---

**Fix (contains narrow breaking changes):** Catch-up and async projections are now properly tenant-aware under conjoined multi-tenancy. Before this change, projections silently read and wrote data in the wrong tenant when events were raised under a non-default tenant — a data-loss bug under any real multi-tenant load.

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
