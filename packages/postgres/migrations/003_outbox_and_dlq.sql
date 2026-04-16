CREATE TABLE IF NOT EXISTS eventfabric.outbox (
  id BIGSERIAL PRIMARY KEY,
  global_position BIGINT NOT NULL UNIQUE,
  topic TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ NULL,
  locked_by TEXT NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  dead_lettered_at TIMESTAMPTZ NULL,
  dead_letter_reason TEXT NULL
);

CREATE INDEX IF NOT EXISTS outbox_ready_idx
  ON eventfabric.outbox (dead_lettered_at, locked_at, id);

CREATE INDEX IF NOT EXISTS outbox_topic_idx
  ON eventfabric.outbox (topic);

CREATE INDEX IF NOT EXISTS outbox_global_idx
  ON eventfabric.outbox (global_position);

CREATE TABLE IF NOT EXISTS eventfabric.outbox_dead_letters (
  id BIGSERIAL PRIMARY KEY,
  outbox_id BIGINT NOT NULL,
  global_position BIGINT NOT NULL,
  topic TEXT NULL,
  attempts INT NOT NULL,
  last_error TEXT NULL,
  dead_lettered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbox_dlq_global_idx
  ON eventfabric.outbox_dead_letters (global_position);
