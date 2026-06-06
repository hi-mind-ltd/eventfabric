-- Saga instances.
--
-- Each row is one saga instance — its state, optimistic-locking version,
-- lifecycle status, and the highest globalPosition the runner has applied
-- to it. The runner (which piggybacks on AsyncProjectionRunner) loads the
-- row, computes the saga's reaction, and writes the new state in the
-- same transaction as the event being processed. State updates use
-- compare-and-swap on `state_version` to serialize concurrent advances of
-- the same instance.
--
-- See proposal 0002 (docs/proposals/0002-saga-and-process-manager.md).

CREATE TABLE IF NOT EXISTS eventfabric.saga_instances (
  tenant_id        TEXT        NOT NULL DEFAULT 'default',
  saga_name        TEXT        NOT NULL,
  instance_id      TEXT        NOT NULL,
  state            JSONB       NOT NULL,
  state_version    INTEGER     NOT NULL,
  status           TEXT        NOT NULL CHECK (status IN ('active','completed','failed')),
  schema_version   INTEGER     NOT NULL DEFAULT 1,
  last_event_pos   BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, saga_name, instance_id)
);

-- Partial index used by ops queries — "show me all active instances of
-- this saga in this tenant." The WHERE clause keeps the index small.
CREATE INDEX IF NOT EXISTS saga_instances_active_idx
  ON eventfabric.saga_instances (saga_name, tenant_id)
  WHERE status = 'active';
