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
  "008_tenant_id",
  "009_per_tenant_projection_checkpoints",
  // 010-014 are owned by extension packages (@eventfabric/mediator-postgres,
  // @eventfabric/sagas-postgres); the next free core name is 015.
  "015_event_hash_chain",
];

const PARTITIONING_MIGRATION = "007_partitioning";

/**
 * A bundle of migrations contributed by an external package
 * (e.g. `@eventfabric/mediator-postgres`, `@eventfabric/sagas-postgres`).
 *
 * - `source` is a label written into observer events for diagnostics. It
 *   does not affect ordering or the `schema_migrations` row contents.
 * - `dir` is the absolute filesystem path containing the `.sql` files.
 *   Each entry in `migrations` resolves to `${dir}/${name}.sql`.
 * - Migration names are recorded in the shared `eventfabric.schema_migrations`
 *   table, so re-applying is a no-op. Extension packages MUST namespace
 *   their migration names (e.g. `010_command_idempotency`) to avoid
 *   collisions with core or with other extensions.
 */
export type MigrationSet = {
  readonly source: string;
  readonly dir: string;
  readonly migrations: readonly string[];
};

export type MigrateObserver = {
  onMigrationStarted?: (info: { name: string; source: string }) => void;
  onMigrationApplied?: (info: { name: string; source: string; durationMs: number }) => void;
  onMigrationSkipped?: (info: { name: string; source: string }) => void;
  onMigrationFailed?: (info: { name: string; source: string; error: Error }) => void;
  onPartitioningEnabled?: (info: { partitionSize: bigint; durationMs: number }) => void;
};

export type MigrateOptions = {
  partitioning?: {
    enabled: true;
    partitionSize?: bigint;
  };
  /**
   * Extension migrations contributed by other packages. Applied after
   * core migrations, in the order given, before partitioning. Each set
   * is independent — names recorded in `schema_migrations` so re-runs
   * are no-ops.
   */
  extensions?: readonly MigrationSet[];
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

  const coreSource = "@eventfabric/postgres";
  for (const name of CORE_MIGRATIONS) {
    if (applied.has(name)) {
      observer?.onMigrationSkipped?.({ name, source: coreSource });
      continue;
    }
    await applyMigration(pool, name, MIGRATIONS_DIR, coreSource, result, observer);
  }

  for (const ext of opts?.extensions ?? []) {
    for (const name of ext.migrations) {
      if (applied.has(name)) {
        observer?.onMigrationSkipped?.({ name, source: ext.source });
        continue;
      }
      await applyMigration(pool, name, ext.dir, ext.source, result, observer);
    }
  }

  if (opts?.partitioning?.enabled) {
    if (!applied.has(PARTITIONING_MIGRATION)) {
      await applyMigration(pool, PARTITIONING_MIGRATION, MIGRATIONS_DIR, coreSource, result, observer);
    } else {
      observer?.onMigrationSkipped?.({ name: PARTITIONING_MIGRATION, source: coreSource });
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
  dir: string,
  source: string,
  result: MigrateResult,
  observer?: MigrateObserver
): Promise<void> {
  observer?.onMigrationStarted?.({ name, source });
  const start = Date.now();
  try {
    const sql = readFileSync(join(dir, `${name}.sql`), "utf-8");
    await pool.query(sql);
    // schema_migrations.source is added by migration 014; older deployments
    // won't have the column yet. INSERT with source first; on undefined-
    // column error retry with the legacy shape.
    try {
      await pool.query(
        `INSERT INTO eventfabric.schema_migrations (name, source) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [name, source]
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "42703") {
        await pool.query(
          `INSERT INTO eventfabric.schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`,
          [name]
        );
      } else {
        throw err;
      }
    }
    const durationMs = Date.now() - start;
    result.applied.push(name);
    observer?.onMigrationApplied?.({ name, source, durationMs });
  } catch (err) {
    observer?.onMigrationFailed?.({
      name,
      source,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    throw err;
  }
}
