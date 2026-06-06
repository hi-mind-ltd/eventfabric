-- Saga scheduled messages (timers).
--
-- A saga schedules a timer in `reactToEvent` / `reactToTimer`; the runner
-- inserts a row here in the same transaction. The SagaTimerScheduler
-- worker polls due rows (`fire_at <= NOW()`) via FOR UPDATE SKIP LOCKED,
-- claims them, delivers to the saga's `reactToTimer`, and marks them
-- fired. Cancelled rows are kept for ops visibility (you can prune them
-- with a periodic job).
--
-- See proposal 0002 (docs/proposals/0002-saga-and-process-manager.md).

CREATE TABLE IF NOT EXISTS eventfabric.saga_scheduled_messages (
  tenant_id    TEXT         NOT NULL DEFAULT 'default',
  saga_name    TEXT         NOT NULL,
  instance_id  TEXT         NOT NULL,
  id           TEXT         NOT NULL,
  fire_at      TIMESTAMPTZ  NOT NULL,
  message      JSONB        NOT NULL,
  status       TEXT         NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','claimed','fired','cancelled')),
  scheduled_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  claimed_at   TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, saga_name, instance_id, id)
);

-- Hot path: scheduler polls "due and pending" by fire_at. Partial index
-- keeps it small.
CREATE INDEX IF NOT EXISTS saga_scheduled_due_idx
  ON eventfabric.saga_scheduled_messages (fire_at)
  WHERE status = 'pending';

-- Watchdog query: surface stuck-claimed rows whose worker likely crashed.
CREATE INDEX IF NOT EXISTS saga_scheduled_claimed_idx
  ON eventfabric.saga_scheduled_messages (claimed_at)
  WHERE status = 'claimed';
