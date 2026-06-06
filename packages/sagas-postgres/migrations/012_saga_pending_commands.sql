-- Saga pending commands.
--
-- An outbox for commands emitted by sagas. The saga runner inserts rows
-- in the same transaction that advances saga state — atomic by
-- construction. The SagaCommandDispatcher worker drains pending rows in
-- batches via FOR UPDATE SKIP LOCKED, dispatches each one through the
-- CommandBus, and DELETEs the row on success. Failed rows after retry
-- exhaustion are flipped to status='failed' for ops triage.
--
-- See proposal 0002 (docs/proposals/0002-saga-and-process-manager.md).

CREATE TABLE IF NOT EXISTS eventfabric.saga_pending_commands (
  id              BIGSERIAL   PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  saga_name       TEXT        NOT NULL,
  instance_id     TEXT        NOT NULL,
  command         JSONB       NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','claimed','failed')),
  attempts        INTEGER     NOT NULL DEFAULT 0,
  last_error      TEXT,
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at      TIMESTAMPTZ
);

-- Hot path: the dispatcher's claim query. Partial index keeps it tight.
CREATE INDEX IF NOT EXISTS saga_pending_commands_pending_idx
  ON eventfabric.saga_pending_commands (id)
  WHERE status = 'pending';

-- Watchdog query: surface stuck-claimed rows (claimer crashed mid-dispatch).
CREATE INDEX IF NOT EXISTS saga_pending_commands_claimed_idx
  ON eventfabric.saga_pending_commands (claimed_at)
  WHERE status = 'claimed';
