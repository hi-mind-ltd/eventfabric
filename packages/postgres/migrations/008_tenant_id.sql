-- Add tenant_id to all tables for conjoined multi-tenancy.
-- Default 'default' preserves single-tenant backwards compatibility.

-- events: add column, rebuild unique constraint and covering index
ALTER TABLE eventfabric.events ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

DROP INDEX IF EXISTS eventfabric.events_stream_covering_idx;
CREATE INDEX events_stream_covering_idx
  ON eventfabric.events (tenant_id, aggregate_name, aggregate_id, aggregate_version)
  INCLUDE (event_id, type, version, payload, occurred_at, dismissed_at, dismissed_reason, dismissed_by, correlation_id, causation_id);

-- Drop the old unique constraint and recreate with tenant_id
ALTER TABLE eventfabric.events DROP CONSTRAINT IF EXISTS events_aggregate_name_aggregate_id_aggregate_version_key;
ALTER TABLE eventfabric.events ADD CONSTRAINT events_tenant_aggregate_version_key
  UNIQUE (tenant_id, aggregate_name, aggregate_id, aggregate_version);

-- stream_versions: add column, rebuild PK
ALTER TABLE eventfabric.stream_versions ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE eventfabric.stream_versions DROP CONSTRAINT IF EXISTS stream_versions_pkey;
ALTER TABLE eventfabric.stream_versions ADD PRIMARY KEY (tenant_id, aggregate_name, aggregate_id);

-- outbox: add column, rebuild claimable index
ALTER TABLE eventfabric.outbox ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
DROP INDEX IF EXISTS eventfabric.outbox_claimable_idx;
CREATE INDEX outbox_claimable_idx
  ON eventfabric.outbox (tenant_id, id ASC)
  WHERE dead_lettered_at IS NULL AND locked_at IS NULL;

-- outbox_dead_letters: add column
ALTER TABLE eventfabric.outbox_dead_letters ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
DROP INDEX IF EXISTS eventfabric.outbox_dlq_global_idx;
CREATE INDEX outbox_dlq_global_idx
  ON eventfabric.outbox_dead_letters (tenant_id, global_position);

-- snapshots: add column, rebuild PK
ALTER TABLE eventfabric.snapshots ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE eventfabric.snapshots DROP CONSTRAINT IF EXISTS snapshots_pkey;
ALTER TABLE eventfabric.snapshots ADD PRIMARY KEY (tenant_id, aggregate_name, aggregate_id);

-- projection_checkpoints: add column, rebuild PK
ALTER TABLE eventfabric.projection_checkpoints ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE eventfabric.projection_checkpoints DROP CONSTRAINT IF EXISTS projection_checkpoints_pkey;
ALTER TABLE eventfabric.projection_checkpoints ADD PRIMARY KEY (tenant_id, projection_name);
