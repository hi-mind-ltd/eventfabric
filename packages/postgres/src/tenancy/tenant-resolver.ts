import type { Pool } from "pg";
import { migrate, type MigrateOptions, type MigrateResult } from "../pg-migrator";

/**
 * Resolves the database pool for a given tenant ID.
 *
 * Two built-in strategies:
 *
 * - **Conjoined**: all tenants share one database. Isolation is via a `tenant_id`
 *   column on every table. One pool, one migration run, many tenants.
 *
 * - **Per-database**: each tenant gets its own PostgreSQL database (and pool).
 *   Full isolation — queries cannot leak across tenants by design.
 *
 * The resolver is passed to `SessionFactory`. When `createSession(tenantId)` is
 * called, the factory asks the resolver for the correct pool.
 */
export interface TenantResolver {
  /** Returns the pool for the given tenant. */
  getPool(tenantId: string): Pool;

  /** Runs database migrations. For conjoined: once. For per-database: per tenant. */
  migrate(opts?: MigrateOptions): Promise<Map<string, MigrateResult>>;
}

/**
 * Conjoined tenancy: all tenants share a single database.
 * Tenant isolation is enforced by the `tenant_id` column in every table.
 *
 * @example
 * const resolver = new ConjoinedTenantResolver(pool);
 * await resolver.migrate();
 *
 * const factory = new SessionFactory(resolver, store);
 * const session = factory.createSession("tenant-acme");
 */
export class ConjoinedTenantResolver implements TenantResolver {
  constructor(private readonly pool: Pool) {}

  getPool(): Pool {
    return this.pool;
  }

  async migrate(opts?: MigrateOptions): Promise<Map<string, MigrateResult>> {
    const result = await migrate(this.pool, opts);
    return new Map([["*", result]]);
  }
}

/**
 * Per-database tenancy: each tenant has its own PostgreSQL database and pool.
 * Full isolation — no `tenant_id` filtering needed (all rows use `'default'`).
 *
 * @example
 * const resolver = new PerDatabaseTenantResolver({
 *   "acme":    new Pool({ connectionString: "postgres://localhost/acme_db" }),
 *   "contoso": new Pool({ connectionString: "postgres://localhost/contoso_db" }),
 * });
 * await resolver.migrate();
 *
 * const factory = new SessionFactory(resolver, store);
 * const session = factory.createSession("acme");
 */
export class PerDatabaseTenantResolver implements TenantResolver {
  private readonly pools: Map<string, Pool>;

  constructor(pools: Record<string, Pool> | Map<string, Pool>) {
    this.pools = pools instanceof Map ? pools : new Map(Object.entries(pools));
  }

  getPool(tenantId: string): Pool {
    const pool = this.pools.get(tenantId);
    if (!pool) {
      throw new Error(
        `No pool configured for tenant "${tenantId}". ` +
        `Available tenants: ${[...this.pools.keys()].join(", ")}`
      );
    }
    return pool;
  }

  /** Runs migrations on all tenant databases in parallel. */
  async migrate(opts?: MigrateOptions): Promise<Map<string, MigrateResult>> {
    const results = new Map<string, MigrateResult>();
    await Promise.all(
      [...this.pools.entries()].map(async ([tenantId, pool]) => {
        results.set(tenantId, await migrate(pool, opts));
      })
    );
    return results;
  }

  /** Runs migrations for a single tenant. */
  async migrateTenant(tenantId: string, opts?: MigrateOptions): Promise<MigrateResult> {
    return migrate(this.getPool(tenantId), opts);
  }

  /** Add a new tenant database at runtime. */
  addTenant(tenantId: string, pool: Pool): void {
    if (this.pools.has(tenantId)) {
      throw new Error(`Tenant "${tenantId}" already registered`);
    }
    this.pools.set(tenantId, pool);
  }
}
