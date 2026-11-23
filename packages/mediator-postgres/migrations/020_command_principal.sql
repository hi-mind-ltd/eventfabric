-- Principal for command idempotency slots.
--
-- The bus stores the principal (metadata.principalId) that first used an
-- idempotency key. A later command with the same key from a different
-- principal is rejected with IdempotencyKeyConflictError instead of being
-- answered with the first caller's stored result. Rows written before this
-- migration, and commands sent without a principal, have NULL and skip the
-- check.

ALTER TABLE eventfabric.command_idempotency
  ADD COLUMN IF NOT EXISTS principal_id TEXT NULL;
