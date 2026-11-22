-- Dead letters for projections run by the ProjectionDaemon.
--
-- When a projection's handler fails on an event maxAttempts times, the daemon
-- records the event here and moves that projection's checkpoint past it, so a
-- single poison event does not block the projection for that tenant. The row
-- identifies the event by global_position; the event itself stays in
-- eventfabric.events. ProjectionDaemon.replayDeadLetter(id) runs it again.
--
-- One row per (projection, tenant, event): re-dead-lettering the same event
-- (e.g. after a rebuild) updates the existing row.

CREATE TABLE IF NOT EXISTS eventfabric.projection_dead_letters (
  id               BIGSERIAL   PRIMARY KEY,
  projection_name  TEXT        NOT NULL,
  tenant_id        TEXT        NOT NULL DEFAULT 'default',
  global_position  BIGINT      NOT NULL,
  event_id         UUID        NOT NULL,
  event_type       TEXT        NOT NULL,
  attempts         INT         NOT NULL,
  last_error       TEXT        NULL,
  dead_lettered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT projection_dead_letters_event_key UNIQUE (projection_name, tenant_id, global_position)
);

CREATE INDEX IF NOT EXISTS projection_dead_letters_age_idx
  ON eventfabric.projection_dead_letters (dead_lettered_at);
