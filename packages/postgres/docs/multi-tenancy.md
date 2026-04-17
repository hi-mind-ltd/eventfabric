# Multi-Tenancy

EventFabric supports two multi-tenancy strategies out of the box. Both use the same `SessionFactory` API — the only difference is which `TenantResolver` you pass.

## Strategy 1: Conjoined (shared database)

All tenants share a single database. Isolation is enforced by a `tenant_id` column on every table. Every query automatically filters by tenant.

```typescript
import { SessionFactory, PgEventStore, ConjoinedTenantResolver } from "@eventfabric/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const resolver = new ConjoinedTenantResolver(pool);

// Run migrations once (shared tables)
await resolver.migrate();

const store = new PgEventStore<AppEvent>();
const factory = new SessionFactory(resolver, store);
factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited"], "account");

// Per request — tenant from auth context
app.post("/accounts/:id/deposit", async (req, res) => {
  const tenantId = req.headers["x-tenant-id"] as string;
  const session = factory.createSession(tenantId);

  const account = await session.loadAggregateAsync<AccountAggregate>(req.params.id);
  account.deposit(req.body.amount);
  await session.saveChangesAsync();

  res.json({ ok: true });
});
```

**How it works:**
- Migration `008_tenant_id` adds `tenant_id TEXT NOT NULL DEFAULT 'default'` to all tables
- Every store query includes `WHERE tenant_id = $1` automatically
- Indexes have `tenant_id` as the leading column for efficient filtering
- Existing single-tenant data uses `tenant_id = 'default'` — no migration needed

**When to use:** Many tenants, shared infrastructure, simpler ops. Good for SaaS with hundreds or thousands of small customers.

## Strategy 2: Per-Database (separate databases)

Each tenant gets their own PostgreSQL database. Full isolation — queries cannot leak across tenants by design.

```typescript
import { SessionFactory, PgEventStore, PerDatabaseTenantResolver } from "@eventfabric/postgres";

const resolver = new PerDatabaseTenantResolver({
  acme:    new Pool({ connectionString: "postgres://localhost/acme_db" }),
  contoso: new Pool({ connectionString: "postgres://localhost/contoso_db" }),
});

// Run migrations on all tenant databases
await resolver.migrate();

// Or migrate a single tenant (e.g. during onboarding)
await resolver.migrateTenant("acme");

const store = new PgEventStore<AppEvent>();
const factory = new SessionFactory(resolver, store);
factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited"], "account");

// Per request — resolver picks the right database pool
app.post("/accounts/:id/deposit", async (req, res) => {
  const tenantId = req.headers["x-tenant-id"] as string;
  const session = factory.createSession(tenantId);  // uses tenant's own pool

  const account = await session.loadAggregateAsync<AccountAggregate>(req.params.id);
  account.deposit(req.body.amount);
  await session.saveChangesAsync();

  res.json({ ok: true });
});
```

**How it works:**
- Each tenant database has identical schemas (same migrations)
- `createSession(tenantId)` resolves the pool via the resolver
- All rows use `tenant_id = 'default'` (the column exists but is redundant — isolation is at the database level)
- New tenants are onboarded by creating a database, adding a pool, and running migrations

**Adding tenants at runtime:**

```typescript
const newPool = new Pool({ connectionString: "postgres://localhost/newclient_db" });
resolver.addTenant("newclient", newPool);
await resolver.migrateTenant("newclient");
```

**When to use:** Fewer tenants with strict isolation requirements. Regulated industries, enterprise customers, or when tenants need independent backup/restore.

## Single-Tenant (default)

If you don't pass a tenant ID, everything works as single-tenant with `tenant_id = 'default'`. You can also pass a raw `Pool` to `SessionFactory` — it's automatically wrapped in a `ConjoinedTenantResolver`:

```typescript
// These are equivalent:
const factory = new SessionFactory(pool, store);
const factory = new SessionFactory(new ConjoinedTenantResolver(pool), store);

// Both create sessions with tenant = "default"
const session = factory.createSession();
```

## Comparison

| | Conjoined | Per-Database |
|---|---|---|
| Database count | 1 | N (one per tenant) |
| Isolation | Query-level (`tenant_id` column) | Database-level (separate databases) |
| Migrations | Run once | Run per tenant |
| Cross-tenant queries | Possible (remove WHERE) | Not possible |
| Ops complexity | Low | Higher (N databases) |
| Onboard tenant | Just use a new tenant ID | Create database + pool + migrate |
| Remove tenant | `DELETE WHERE tenant_id = $1` | `DROP DATABASE` |
| Connection overhead | One pool | One pool per tenant |

## Projections with Tenancy

### Catch-up projections (per-tenant fan-out)

For conjoined tenancy, the catch-up projector fans each projection out per tenant:

- **Per-tenant checkpoints.** `projection_checkpoints` is keyed by `(projection_name, tenant_id)`. Each tenant tracks its own progress, so a stuck handler in tenant A holds back only A, not B.
- **Tenant discovery every round.** The projector asks the event store which tenants have events past the lowest checkpoint (`SELECT DISTINCT tenant_id FROM events WHERE global_position > …`) at the start of every round. Tenants onboarded at runtime are picked up automatically — no extra configuration.
- **Round-robin fairness.** Each round gives every tenant a batch before moving on. A tenant generating 10k events in an hour cannot starve tenants with a handful of events.
- **Per-tenant fault isolation.** If a handler throws, only that tenant's transaction rolls back. Its checkpoint stays put; other tenants continue processing. The error is reported via the observer's `onProjectorError` hook.
- **Tenant-scoped tx inside handlers.** `tx.tenantId` matches the envelope's tenant, so `loadStream` / `append` inside the handler filter the correct tenant's data with no manual narrowing in user code.

**Ordering contract.** Within a tenant, events are delivered in `global_position` order. Across tenants there is no cross-tenant ordering guarantee — rounds are fanned out independently, by design, so that ordering cannot become a coupling point.

### Async (outbox) projections

Outbox claim, ack, and dead-letter are cross-tenant queue operations (the outbox is a single shared queue keyed by `global_position`). The runner runs them on a default-scoped transaction. For each claimed event:

- The runner **narrows the transaction** to that event's tenant id before invoking the handler, so loads and appends inside the handler see the correct tenant's data.
- **Checkpoints are per-tenant** (same as catch-up): a retry storm on tenant A cannot advance past unprocessed events in tenant B.

### Per-Database

Each tenant's database has its own outbox and its own set of tenants (always `"default"`). You typically run one runner per tenant:

```typescript
for (const [tenantId, pool] of resolver.pools) {
  const runner = createAsyncProjectionRunner(pool, store, [emailProjection], {
    workerId: `worker-${tenantId}`,
    batchSize: 10,
    maxAttempts: 5
  });
  runner.start(abortController.signal);
}
```
