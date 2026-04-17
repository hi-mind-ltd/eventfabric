-- Per-tenant projection checkpoints.
--
-- Prior to this migration, `projection_checkpoints` had `projection_name` as
-- its PK and a `tenant_id` column that defaulted to 'default' but was never
-- part of the key. The catch-up projector stored a single global position per
-- projection regardless of which tenant's events had been processed — which
-- meant that a multi-tenant deployment could advance the checkpoint past
-- events for tenant A while still intending to process them in tenant B.
--
-- This migration is breaking for multi-tenant deployments. After upgrading:
--   * The projector uses `(projection_name, tenant_id)` as the checkpoint
--     key. Each tenant's progress is tracked independently.
--   * One tenant's stuck handler no longer blocks other tenants.
--
-- Migration note for existing deployments: any checkpoints written under the
-- old scheme are retained but will only apply to tenant_id = 'default'. If
-- your deployment had non-default tenants processing events under the old
-- scheme, those tenants will re-process their events from global_position 0
-- after upgrading (handlers must therefore be idempotent — they were
-- supposed to be anyway). Single-tenant deployments see no behavioural
-- change.

ALTER TABLE eventfabric.projection_checkpoints
  DROP CONSTRAINT IF EXISTS projection_checkpoints_pkey;

ALTER TABLE eventfabric.projection_checkpoints
  ADD CONSTRAINT projection_checkpoints_pkey
  PRIMARY KEY (projection_name, tenant_id);
