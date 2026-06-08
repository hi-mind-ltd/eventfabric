-- Tamper-evident event chaining (opt-in per aggregate type).
--
-- Per-stream HMAC chain:
--   events.event_hash = HMAC(secret, prevHash || canonical(event))
-- where prevHash is the previous event's event_hash in the same stream
-- (tenant_id, aggregate_name, aggregate_id), or a per-stream genesis for the
-- first event. stream_versions.head_hash caches the stream's current chain head
-- so the write path never has to read the (large, partitioned) events table to
-- find the previous hash -- it reads the same stream_versions row it already
-- locks for the concurrency gate.
--
-- Per-tenant anchor (stream-head snapshot):
--   A periodic sealer reads a consistent MVCC snapshot of this tenant's chained
--   stream heads from stream_versions and chains them:
--     anchor_k = HMAC(secret, anchor_{k-1} || canonical(changed stream heads))
--   Each anchor stores only the delta (streams whose head advanced since the
--   last anchor) in event_chain_anchor_members. This gives cross-stream and
--   whole-stream-deletion / rollback coverage off the write path, with no
--   global_position / gap reasoning (the snapshot is a consistent cut).
--
-- All hash columns are NULL-able: events from aggregates that do NOT have
-- tamper-evidence enabled carry NULL event_hash and are untouched by the
-- chaining write path (zero overhead for opted-out streams).

CREATE SCHEMA IF NOT EXISTS eventfabric;

ALTER TABLE eventfabric.events
  ADD COLUMN IF NOT EXISTS event_hash BYTEA NULL;

ALTER TABLE eventfabric.stream_versions
  ADD COLUMN IF NOT EXISTS head_hash BYTEA NULL;

CREATE TABLE IF NOT EXISTS eventfabric.event_chain_anchors (
  tenant_id        TEXT        NOT NULL,
  anchor_seq       BIGINT      NOT NULL,
  prev_anchor_hash BYTEA       NOT NULL,
  anchor_hash      BYTEA       NOT NULL,
  member_count     INT         NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- PK leads with tenant_id, so "latest anchor for tenant"
  -- (WHERE tenant_id = $1 ORDER BY anchor_seq DESC LIMIT 1) is a cheap
  -- backward index scan.
  PRIMARY KEY (tenant_id, anchor_seq)
);

-- One row per stream sealed by an anchor (the anchor's delta). The latest row
-- per (tenant, name, id) is that stream's last sealed (version, head). Storing
-- deltas bounds growth to stream-head churn, not stream count x anchor count.
CREATE TABLE IF NOT EXISTS eventfabric.event_chain_anchor_members (
  tenant_id        TEXT   NOT NULL,
  anchor_seq       BIGINT NOT NULL,
  aggregate_name   TEXT   NOT NULL,
  aggregate_id     TEXT   NOT NULL,
  sealed_version   INT    NOT NULL,
  sealed_head_hash BYTEA  NOT NULL,
  PRIMARY KEY (tenant_id, anchor_seq, aggregate_name, aggregate_id)
);

-- "latest sealed state for a stream": WHERE tenant_id, name, id ORDER BY anchor_seq DESC.
CREATE INDEX IF NOT EXISTS event_chain_anchor_members_stream_idx
  ON eventfabric.event_chain_anchor_members (tenant_id, aggregate_name, aggregate_id, anchor_seq DESC);
