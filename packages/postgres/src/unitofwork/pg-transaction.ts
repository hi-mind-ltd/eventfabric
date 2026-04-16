import type { PoolClient } from "pg";

export type PgTx = {
  client: PoolClient;
};
