import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import type { Pool } from "pg";
import { PgPartitionManager } from "./partitioning/pg-partition-manager";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations"
);

const CORE_MIGRATIONS = [
  "001_init",
  "002_projection_checkpoints",
  "003_outbox_and_dlq",
  "004_snapshots",
  "005_stream_versions",
  "006_performance",
];

const PARTITIONING_MIGRATION = "007_partitioning";

export type MigrateObserver = {
  onMigrationStarted?: (info: { name: string }) => void;
  onMigrationApplied?: (info: { name: string; durationMs: number }) => void;
  onMigrationSkipped?: (info: { name: string }) => void;
  onMigrationFailed?: (info: { name: string; error: Error }) => void;
  onPartitioningEnabled?: (info: { partitionSize: bigint; durationMs: number }) => void;
};

export type MigrateOptions = {
  partitioning?: {
    enabled: true;
    partitionSize?: bigint;
  };
  observer?: MigrateObserver;
};

export type MigrateResult = {
  applied: string[];
  partitioned: boolean;
};

/**
 * Applies all EventFabric database migrations. Safe to call on every app startup —
 * already-applied migrations are skipped.
 *
 * With `partitioning.enabled`, also applies migration 007 (drops UNIQUE
 * constraints) and converts the events table to range-partitioned by
 * global_position. This is a one-way operation — partitioning cannot be
 * disabled once enabled.
 */
export async function migrate(pool: Pool, opts?: MigrateOptions): Promise<MigrateResult> {
  const observer = opts?.observer;

  await pool.query(`CREATE SCHEMA IF NOT EXISTS eventfabric`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eventfabric.schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query(`SELECT name FROM eventfabric.schema_migrations`);
  const applied = new Set(rows.map((r: any) => r.name as string));

  const result: MigrateResult = { applied: [], partitioned: false };

  for (const name of CORE_MIGRATIONS) {
    if (applied.has(name)) {
      observer?.onMigrationSkipped?.({ name });
      continue;
    }
    await applyMigration(pool, name, result, observer);
  }

  if (opts?.partitioning?.enabled) {
    if (!applied.has(PARTITIONING_MIGRATION)) {
      await applyMigration(pool, PARTITIONING_MIGRATION, result, observer);
    } else {
      observer?.onMigrationSkipped?.({ name: PARTITIONING_MIGRATION });
    }

    const manager = new PgPartitionManager();
    const partitionSize = opts.partitioning.partitionSize ?? 1_000_000n;
    const start = Date.now();
    await manager.enablePartitioning(pool, { partitionSize });
    observer?.onPartitioningEnabled?.({ partitionSize, durationMs: Date.now() - start });
  }

  const manager = new PgPartitionManager();
  result.partitioned = await manager.isPartitioned(pool);

  return result;
}

async function applyMigration(
  pool: Pool,
  name: string,
  result: MigrateResult,
  observer?: MigrateObserver
): Promise<void> {
  observer?.onMigrationStarted?.({ name });
  const start = Date.now();
  try {
    const sql = readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf-8");
    await pool.query(sql);
    await pool.query(
      `INSERT INTO eventfabric.schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`,
      [name]
    );
    const durationMs = Date.now() - start;
    result.applied.push(name);
    observer?.onMigrationApplied?.({ name, durationMs });
  } catch (err) {
    observer?.onMigrationFailed?.({ name, error: err instanceof Error ? err : new Error(String(err)) });
    throw err;
  }
}
