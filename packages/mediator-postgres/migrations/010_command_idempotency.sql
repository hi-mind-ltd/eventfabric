-- Command idempotency table.
--
-- Each row is a deduplication slot for one command attempt. The CommandBus
-- INSERTs a row inside the same transaction as the handler's effects; if
-- the handler succeeds, the bus UPDATEs status to 'completed' and stores
-- the handler's return value. If the handler fails, the transaction rolls
-- back and the row vanishes — so the next retry of the same command can
-- claim again.
--
-- The slot is keyed by (tenant_id, idempotency_key), so the same key in
-- different tenants does not collide.

CREATE TABLE IF NOT EXISTS eventfabric.command_idempotency (
  tenant_id        TEXT        NOT NULL DEFAULT 'default',
  idempotency_key  TEXT        NOT NULL,
  command_type     TEXT        NOT NULL,
  command_id       TEXT        NOT NULL,
  status           TEXT        NOT NULL CHECK (status IN ('in_flight','completed','failed')),
  result           JSONB,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, idempotency_key)
);

-- Index for the cleanup job: prune rows older than the retention window.
CREATE INDEX IF NOT EXISTS command_idempotency_created_at_idx
  ON eventfabric.command_idempotency (created_at);
