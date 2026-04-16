import type { Pool } from "pg";
import type { PgTx } from "./pg-transaction";

export class PgUnitOfWork {
  constructor(private readonly pool: Pool) {}

  async withTransaction<T>(fn: (tx: PgTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await fn({ client });
      await client.query("COMMIT");
      return res;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }
}
