CREATE TABLE IF NOT EXISTS eventfabric.snapshots (
  aggregate_name TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_schema_version INT NOT NULL,
  state JSONB NOT NULL,
  PRIMARY KEY (aggregate_name, aggregate_id)
);

CREATE INDEX IF NOT EXISTS snapshots_version_idx
  ON eventfabric.snapshots (aggregate_name, aggregate_id, aggregate_version);
