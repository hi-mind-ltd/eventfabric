-- Down migration for 014_saga_pipeline_hardening.sql.
--
-- Destructive: drops causation_event_id (event tracing across saga
-- boundary is lost) and next_attempt_at (in-flight retry backoffs
-- become immediate-retry on next dispatcher round — usually fine).
-- The schema_migrations.source column is also dropped; older
-- migrations' source attribution is lost.
--
-- The migrator does not auto-apply down migrations — invoke manually.

DROP INDEX IF EXISTS eventfabric.saga_pending_commands_pending_idx;
CREATE INDEX IF NOT EXISTS saga_pending_commands_pending_idx
  ON eventfabric.saga_pending_commands (id)
  WHERE status = 'pending';

ALTER TABLE eventfabric.saga_pending_commands
  DROP COLUMN IF EXISTS next_attempt_at;

ALTER TABLE eventfabric.saga_pending_commands
  DROP COLUMN IF EXISTS causation_event_id;

ALTER TABLE eventfabric.schema_migrations
  DROP COLUMN IF EXISTS source;

-- Revert the timer table changes. Orphan-handler 'failed' rows would
-- become invalid under the narrower CHECK — surface that before
-- dropping the constraint by failing if any exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM eventfabric.saga_scheduled_messages WHERE status = 'failed') THEN
    RAISE EXCEPTION 'Cannot down-migrate: saga_scheduled_messages has rows with status=failed. Resolve or delete them first.';
  END IF;
END $$;

ALTER TABLE eventfabric.saga_scheduled_messages
  DROP CONSTRAINT IF EXISTS saga_scheduled_messages_status_check;

ALTER TABLE eventfabric.saga_scheduled_messages
  ADD CONSTRAINT saga_scheduled_messages_status_check
  CHECK (status IN ('pending','claimed','fired','cancelled'));

ALTER TABLE eventfabric.saga_scheduled_messages
  DROP COLUMN IF EXISTS last_error;

DELETE FROM eventfabric.schema_migrations WHERE name = '014_saga_pipeline_hardening';
