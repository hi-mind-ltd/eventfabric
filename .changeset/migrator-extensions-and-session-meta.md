---
"@eventfabric/core": minor
---

API changes in support of the new `@eventfabric/mediator` + `@eventfabric/sagas` family. (Linked group — same bump applies to `@eventfabric/postgres` and `@eventfabric/opentelemetry`.)

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
