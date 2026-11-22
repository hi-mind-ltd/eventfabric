-- Payload fingerprint for command idempotency slots.
--
-- The bus stores a SHA-256 of the command's payload with its idempotency key.
-- A later command with the same key but a different payload is rejected with
-- IdempotencyKeyConflictError instead of being answered with the first
-- command's stored result. Rows written before this migration have NULL and
-- skip the check.

ALTER TABLE eventfabric.command_idempotency
  ADD COLUMN IF NOT EXISTS request_hash TEXT NULL;
