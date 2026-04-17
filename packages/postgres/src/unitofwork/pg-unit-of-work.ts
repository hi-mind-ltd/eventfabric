import type { Pool } from "pg";
import type { TenantScopedUnitOfWorkFactory } from "@eventfabric/core";
import type { PgTx } from "./pg-transaction";

/**
 * Postgres implementation of the UnitOfWork abstraction.
 *
 * Each instance is scoped to a specific tenant — its `withTransaction` hands
 * back a `PgTx` whose `tenantId` is the one configured here. To switch
 * tenant (as the catch-up projector does per round), call `forTenant(id)`
 * which returns a new UoW sharing the same pool.
 *
 * Keeping the tenantId on the UoW (not on the individual call) lets the
 * core orchestrators stay backend-neutral: they ask the factory for a
 * tenant's UoW and then use the generic `withTransaction(fn)` shape.
 */
export class PgUnitOfWork implements TenantScopedUnitOfWorkFactory<PgTx> {
  constructor(
    private readonly pool: Pool,
    readonly tenantId: string = "default"
  ) {}

  async withTransaction<T>(fn: (tx: PgTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await fn({ client, tenantId: this.tenantId });
      await client.query("COMMIT");
      return res;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Return a UoW scoped to the given tenant id, sharing this instance's
   * connection pool. Used by the catch-up projector to open one tx per
   * tenant per round.
   */
  forTenant(tenantId: string): PgUnitOfWork {
    if (tenantId === this.tenantId) return this;
    return new PgUnitOfWork(this.pool, tenantId);
  }

  /**
   * Return a tenant-scoped view of an already-open transaction. Used by the
   * async outbox runner: one claimed batch can span multiple tenants, and
   * each handler must see a tx whose `tenantId` matches the event's. Both
   * views share the same pg client (and therefore the same transaction), so
   * writes still commit atomically with the outer batch.
   */
  narrow(tx: PgTx, tenantId: string): PgTx {
    if (tx.tenantId === tenantId) return tx;
    return { client: tx.client, tenantId };
  }
}
