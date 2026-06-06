-- Down migration for 011_saga_instances.sql.
--
-- Destructive: drops all persisted saga instance state. Active sagas
-- will be unable to advance after this runs — the runner's
-- stateStore.load returns null, the saga is treated as "no-instance"
-- and the inbound event is skipped.
--
-- The events the sagas emitted remain in eventfabric.events, so
-- downstream projections and audit trails are preserved.
--
-- Apply only when rolling back to a deployment that does not use
-- @eventfabric/sagas + @eventfabric/sagas-postgres. The migrator does
-- not auto-apply down migrations — invoke this file manually.

DROP INDEX IF EXISTS eventfabric.saga_instances_active_idx;
DROP TABLE IF EXISTS eventfabric.saga_instances;

DELETE FROM eventfabric.schema_migrations WHERE name = '011_saga_instances';
