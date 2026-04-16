-- Stream version tracking table. This is the concurrency gatekeeper:
-- every append does an atomic UPDATE ... WHERE current_version = expected
-- on this table, replacing the previous SELECT MAX + UNIQUE constraint approach.
--
-- This table is intentionally unpartitioned and tiny (one row per aggregate
-- stream). The events table can now be freely partitioned by global_position
-- without constraint limitations.
--
-- Pattern used by: Marten DB (mt_streams), SQLStreamStore (Streams),
-- EventStoreDB (internal stream metadata).

CREATE SCHEMA IF NOT EXISTS eventfabric;

CREATE TABLE IF NOT EXISTS eventfabric.stream_versions (
  aggregate_name TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  current_version INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (aggregate_name, aggregate_id)
);

-- Backfill from existing events (safe to run on an existing database).
INSERT INTO eventfabric.stream_versions (aggregate_name, aggregate_id, current_version, created_at, updated_at)
SELECT aggregate_name, aggregate_id, MAX(aggregate_version), MIN(occurred_at), MAX(occurred_at)
FROM eventfabric.events
GROUP BY aggregate_name, aggregate_id
ON CONFLICT (aggregate_name, aggregate_id) DO NOTHING;

-- The UNIQUE constraint on (aggregate_name, aggregate_id, aggregate_version) in
-- eventfabric.events is no longer the primary concurrency mechanism — stream_versions
-- handles that. However, we keep it as defense-in-depth for now.
--
-- When you enable partitioning on eventfabric.events, drop it:
--   ALTER TABLE eventfabric.events
--     DROP CONSTRAINT events_aggregate_name_aggregate_id_aggregate_version_key;
