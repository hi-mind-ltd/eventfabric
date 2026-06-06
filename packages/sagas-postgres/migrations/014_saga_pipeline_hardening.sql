-- Pipeline hardening: causation tracking, retry backoff, and migration
-- source attribution.
--
-- This migration adds three forward-compatible columns:
--   1. saga_pending_commands.causation_event_id — recorded at enqueue so
--      the dispatcher can stamp the command's metadata.causationId with
--      the event that triggered the saga reaction. Without this, event
--      tracing breaks at the saga boundary.
--   2. saga_pending_commands.next_attempt_at — set by releaseWithError
--      when an exponential backoff is configured. The dispatcher's claim
--      query excludes rows whose next_attempt_at is in the future, so a
--      flapping downstream doesn't burn all retries in milliseconds.
--   3. schema_migrations.source — package label for each applied
--      migration row. Prevents silent collisions when two packages ship
--      a same-numbered migration. NULL for migrations applied before
--      this change.

ALTER TABLE eventfabric.saga_pending_commands
  ADD COLUMN IF NOT EXISTS causation_event_id TEXT;

ALTER TABLE eventfabric.saga_pending_commands
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

-- Tighten the claim hot path: skip rows held back by backoff.
DROP INDEX IF EXISTS eventfabric.saga_pending_commands_pending_idx;
CREATE INDEX IF NOT EXISTS saga_pending_commands_pending_idx
  ON eventfabric.saga_pending_commands (next_attempt_at NULLS FIRST, id)
  WHERE status = 'pending';

ALTER TABLE eventfabric.schema_migrations
  ADD COLUMN IF NOT EXISTS source TEXT;

-- Saga timer table gains a 'failed' status for orphan handling.
-- When SagaTimerScheduler claims a timer for a saga name with no
-- registered handler (typically a refactor that renamed a saga), the
-- previous default was to silently markFired. The safer default flips
-- the row to 'failed' so ops can see + decide. The CHECK constraint
-- needs to widen to allow this.
ALTER TABLE eventfabric.saga_scheduled_messages
  DROP CONSTRAINT IF EXISTS saga_scheduled_messages_status_check;

ALTER TABLE eventfabric.saga_scheduled_messages
  ADD CONSTRAINT saga_scheduled_messages_status_check
  CHECK (status IN ('pending','claimed','fired','cancelled','failed'));

ALTER TABLE eventfabric.saga_scheduled_messages
  ADD COLUMN IF NOT EXISTS last_error TEXT;
