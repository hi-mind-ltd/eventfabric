import { Pool } from "pg";
import { buildInsuranceApp, runMigrations } from "./build-app";

/**
 * Entry point. Reads config from the environment, runs migrations, starts
 * the Fastify server, and launches background projection workers.
 *
 * Required env:
 *   DATABASE_URL  – Postgres connection string
 * Optional env:
 *   PORT                 – default 3002
 *   ALLOWED_TENANTS      – comma-separated list (e.g. "acme,contoso"). Omit to accept any tenant.
 */
async function start() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  await runMigrations(pool);

  const allowedTenants = process.env.ALLOWED_TENANTS
    ? new Set(process.env.ALLOWED_TENANTS.split(",").map((s) => s.trim()).filter(Boolean))
    : undefined;

  const { app, startWorkers } = buildInsuranceApp({
    pool,
    allowedTenants,
    logger: true
  });

  const workers = startWorkers();

  const port = Number(process.env.PORT ?? 3002);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Insurance API listening on :${port}`);

  const shutdown = async () => {
    console.log("\nShutting down…");
    workers.controller.abort();
    await app.close();
    await workers.done.catch(() => undefined);
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  console.error("Failed to start insurance-api:", err);
  process.exit(1);
});
