-- Performance optimizations for production workloads.
-- Safe to run on existing databases — all statements are idempotent.

CREATE SCHEMA IF NOT EXISTS eventfabric;

-- 1. PARTIAL INDEX on outbox: only "claimable" rows.
--    claimBatch() filters WHERE dead_lettered_at IS NULL AND locked_at IS NULL.
--    This partial index contains ONLY those rows — typically a tiny fraction
--    of the table. Turns claimBatch from a full-index scan into a near-O(1)
--    lookup, even when the outbox has thousands of locked/dead-lettered rows.
DROP INDEX IF EXISTS outbox_ready_idx;
CREATE INDEX IF NOT EXISTS outbox_claimable_idx
  ON eventfabric.outbox (id ASC)
  WHERE dead_lettered_at IS NULL AND locked_at IS NULL;

-- 2. AGGRESSIVE AUTOVACUUM on outbox.
--    The outbox has heavy UPDATE (locked_at on claim) + DELETE (ack) churn,
--    generating dead tuples that bloat the table and slow FOR UPDATE SKIP LOCKED.
--    Default autovacuum triggers at 20% dead tuples — far too late for a
--    transient table that should stay small. These settings trigger vacuum
--    after just 1% dead tuples with no throttle.
ALTER TABLE eventfabric.outbox SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_vacuum_cost_delay = 0
);

-- 3. COVERING INDEX for loadStream.
--    loadStream queries (aggregate_name, aggregate_id) ordered by aggregate_version
--    and fetches all event columns. The default index requires a heap lookup per row.
--    This covering index INCLUDEs the columns loadStream needs, enabling an
--    index-only scan — no heap access for the most common read path.
DROP INDEX IF EXISTS events_stream_idx;
CREATE INDEX IF NOT EXISTS events_stream_covering_idx
  ON eventfabric.events (aggregate_name, aggregate_id, aggregate_version)
  INCLUDE (event_id, type, version, payload, occurred_at,
           dismissed_at, dismissed_reason, dismissed_by,
           correlation_id, causation_id);
