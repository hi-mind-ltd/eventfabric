import type { Pool } from "pg";

/**
 * End a pg Pool and wait until every connection has actually closed.
 *
 * `pool.end()` resolves as soon as the pool has *started* closing its
 * clients (pg-pool drops each client from its list before `client.end()`
 * completes). Stopping the Postgres container right after it races those
 * closes: the server terminates the still-open connections with 57P01
 * ("terminating connection due to administrator command"), the pool
 * re-emits that as an 'error' with no listener, and Vitest reports it as an
 * unhandled error, failing the run even though every test passed.
 */
export async function endPool(pool: Pool): Promise<void> {
  // Errors from connections being torn down are expected here.
  pool.on("error", () => {});
  const open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) return resolve();
    let removed = 0;
    pool.on("remove", () => {
      if (++removed >= open) resolve();
    });
  });
  await pool.end();
  await closed;
}
