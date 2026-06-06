-- Down migration for 012_saga_pending_commands.sql.
--
-- Destructive: drops the saga command outbox. Pending and claimed rows
-- are lost — any commands the saga emitted but the dispatcher hadn't
-- yet dispatched will silently fail to fire.
--
-- For a graceful rollback: pause sagas, drain the queue via
-- SagaCommandDispatcher.runOnce() until pending count is zero, then
-- run this script. Otherwise expect missed downstream effects on
-- in-flight saga instances.
--
-- The migrator does not auto-apply down migrations — invoke manually.

DROP INDEX IF EXISTS eventfabric.saga_pending_commands_pending_idx;
DROP INDEX IF EXISTS eventfabric.saga_pending_commands_claimed_idx;
DROP TABLE IF EXISTS eventfabric.saga_pending_commands;

DELETE FROM eventfabric.schema_migrations WHERE name = '012_saga_pending_commands';
