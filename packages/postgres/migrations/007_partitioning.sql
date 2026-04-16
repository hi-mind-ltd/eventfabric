-- Prepares the events table for range partitioning by global_position.
--
-- PostgreSQL requires that all UNIQUE/PK constraints on a partitioned table
-- include the partition key. The events PK is already global_position, but the
-- two secondary UNIQUE constraints block partitioning:
--
--   1. UNIQUE (aggregate_name, aggregate_id, aggregate_version)
--      → Replaced by stream_versions table (migration 005)
--
--   2. UNIQUE (event_id)
--      → UUIDs are globally unique; constraint is defense-in-depth only
--
-- This migration drops both, clearing the path for PgPartitionManager.
-- Run PgPartitionManager.enablePartitioning() after applying this migration.

ALTER TABLE eventfabric.events
  DROP CONSTRAINT IF EXISTS events_aggregate_name_aggregate_id_aggregate_version_key;

ALTER TABLE eventfabric.events
  DROP CONSTRAINT IF EXISTS events_event_id_key;
