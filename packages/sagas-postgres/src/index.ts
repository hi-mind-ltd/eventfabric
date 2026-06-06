import { fileURLToPath } from "url";
import { join, dirname } from "path";
import type { MigrationSet } from "@eventfabric/postgres";

export { PgSagaStateStore } from "./pg-saga-state-store";
export type { PgSagaStateStoreOptions } from "./pg-saga-state-store";
export { PgSagaCommandQueue } from "./pg-saga-command-queue";
export type { PgSagaCommandQueueOptions } from "./pg-saga-command-queue";
export { PgSagaTimerStore } from "./pg-saga-timer-store";
export type { PgSagaTimerStoreOptions } from "./pg-saga-timer-store";

/**
 * Migration set for the saga persistence tables. Pass to
 * `migrate(pool, { extensions: [sagasMigrations] })` from
 * `@eventfabric/postgres`.
 *
 * Path resolution: `dist/index.js` → `../migrations` lands on this
 * package's top-level `migrations/` directory (shipped via the `files`
 * field).
 */
export const sagasMigrations: MigrationSet = {
  source: "@eventfabric/sagas-postgres",
  dir: join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"),
  migrations: [
    "011_saga_instances",
    "012_saga_pending_commands",
    "013_saga_scheduled_messages",
    "014_saga_pipeline_hardening",
  ],
};
