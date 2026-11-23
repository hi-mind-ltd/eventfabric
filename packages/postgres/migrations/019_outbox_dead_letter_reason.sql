-- Why a message was dead-lettered (e.g. "max attempts exceeded",
-- "Event not found for globalPosition=..."). last_error keeps the last
-- handler error; reason is what the runner passed to deadLetter().
ALTER TABLE eventfabric.outbox_dead_letters ADD COLUMN IF NOT EXISTS reason TEXT NULL;
