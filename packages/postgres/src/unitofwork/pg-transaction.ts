import type { PoolClient } from "pg";

export type PgTx = {
  client: PoolClient;
  /** Tenant ID for conjoined multi-tenancy. Defaults to "default" for single-tenant. */
  tenantId: string;
};
