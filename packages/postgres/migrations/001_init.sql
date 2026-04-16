CREATE SCHEMA IF NOT EXISTS eventfabric;

CREATE TABLE IF NOT EXISTS eventfabric.events (
  global_position BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  aggregate_name TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INT NOT NULL,
  type TEXT NOT NULL,
  version INT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_at TIMESTAMPTZ NULL,
  dismissed_reason TEXT NULL,
  dismissed_by TEXT NULL,
  correlation_id TEXT NULL,
  causation_id TEXT NULL,
  UNIQUE (aggregate_name, aggregate_id, aggregate_version)
);

CREATE INDEX IF NOT EXISTS events_stream_idx
  ON eventfabric.events (aggregate_name, aggregate_id, aggregate_version);

CREATE INDEX IF NOT EXISTS events_global_idx
  ON eventfabric.events (global_position);
