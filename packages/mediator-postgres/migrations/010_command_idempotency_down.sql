-- Down migration for 010_command_idempotency.sql.
--
-- Destructive: drops the table and all its dedup slots. If you have
-- in-flight commands when this runs, the next claim for any of those
-- keys will succeed as if no prior attempt existed (the bus has no
-- prior knowledge once the table is gone).
--
-- Apply only when rolling back to a deployment that does not use
-- @eventfabric/mediator + @eventfabric/mediator-postgres. The migrator
-- itself does not auto-apply down migrations — invoke this file
-- manually via psql.

DROP INDEX IF EXISTS eventfabric.command_idempotency_created_at_idx;
DROP TABLE IF EXISTS eventfabric.command_idempotency;

DELETE FROM eventfabric.schema_migrations WHERE name = '010_command_idempotency';
