import { fileURLToPath } from "url";
import { join, dirname } from "path";
import type { MigrationSet } from "@eventfabric/postgres";

export { PgIdempotencyStore } from "./pg-idempotency-store";
export type { PgIdempotencyStoreOptions } from "./pg-idempotency-store";

/**
 * Migration set for the command pipeline tables. Pass to
 * `migrate(pool, { extensions: [commandsMigrations] })` from
 * `@eventfabric/postgres`.
 *
 * Path resolution: `dist/index.js` → `../migrations` lands on this
 * package's top-level `migrations/` directory (shipped via the `files`
 * field).
 */
export const commandsMigrations: MigrationSet = {
  source: "@eventfabric/mediator-postgres",
  dir: join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"),
  migrations: ["010_command_idempotency"],
};
