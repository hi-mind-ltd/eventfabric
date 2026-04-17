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

## Async Projections with Tenancy

### Conjoined

Outbox rows carry `tenant_id`. The async projection runner processes all tenants from the same outbox table — the `tenant_id` filter is applied automatically during `claimBatch`.

### Per-Database

Each tenant's database has its own outbox. You need one runner per tenant:

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
