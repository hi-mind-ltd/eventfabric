CREATE TABLE IF NOT EXISTS eventfabric.projection_checkpoints (
  projection_name TEXT PRIMARY KEY,
  last_global_position BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
