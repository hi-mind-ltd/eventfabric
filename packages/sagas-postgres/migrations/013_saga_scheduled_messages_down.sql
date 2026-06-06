-- Down migration for 013_saga_scheduled_messages.sql.
--
-- Destructive: drops the saga timer queue. Pending timers (including
-- scheduled timeouts that haven't fired yet) are lost — sagas waiting
-- on those timers will sit forever in their pre-timeout state, since
-- the timeout reaction never fires.
--
-- For a graceful rollback: pause sagas, fire/cancel due timers via
-- SagaTimerScheduler.runOnce() until pending count is zero, then run
-- this script. Otherwise expect orphaned in-flight saga instances.
--
-- The migrator does not auto-apply down migrations — invoke manually.

DROP INDEX IF EXISTS eventfabric.saga_scheduled_due_idx;
DROP INDEX IF EXISTS eventfabric.saga_scheduled_claimed_idx;
DROP TABLE IF EXISTS eventfabric.saga_scheduled_messages;

DELETE FROM eventfabric.schema_migrations WHERE name = '013_saga_scheduled_messages';
