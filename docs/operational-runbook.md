# Operational Runbook

## What to monitor
- Outbox backlog (`totalPending`, `oldestAgeSeconds`)
- Projection checkpoint lag (tip - checkpoint)
- DLQ size and top errors
- Command idempotency: count of `in_flight` rows older than 5 min (should be 0)
- Saga pending commands: count of `claimed` rows older than 5 min (should be 0); count of `failed` rows (triage signal)
- Saga timers: count of `claimed` rows older than 5 min (should be 0); count of `pending` rows with `fire_at < NOW() - INTERVAL '1 minute'` (overdue alert)

## DLQ actions
- Inspect dead letters
- Requeue by DLQ id or global position
- Purge if the event is permanently bad and your business can tolerate skipping

## Command pipeline & saga workers

The command bus, saga command dispatcher, and saga timer scheduler are plain
classes. They do not start themselves — host them in your process manager
(systemd, k8s Deployment, supervisor) and call `start()` / `stop()`.

### Hosting

- `SagaCommandDispatcher` and `SagaTimerScheduler` are safe to run with
  multiple replicas. Both use `FOR UPDATE SKIP LOCKED` so claimed rows are
  partitioned across workers. Run 2-3 replicas for HA; scale wider only if
  you measure backlog growth.
- Wire `stop()` to SIGTERM. The current round finishes before the loop
  exits; in-flight handlers are not interrupted.
- `CommandBus` is in-process and runs wherever you accept commands (HTTP
  handler, RPC server). Each `bus.send` is a single transaction; throughput
  scales with your DB connection pool.

### Periodic maintenance jobs

These are not built into the framework — schedule them yourself (pg_cron,
k8s CronJob, or a small node script invoked by cron). Each is a single
short transaction.

| Job | Frequency | Purpose |
|---|---|---|
| `PgIdempotencyStore.cleanup({ olderThan })` | hourly | Prune completed/failed idempotency rows past your retention window (default 24h). |
| `PgIdempotencyStore.resetStaleInFlight({ olderThan })` | every 1-5 min | Recover slots from worker crashes. Pick `olderThan` larger than your slowest legitimate handler runtime; 5 min is the documented default. |
| `PgSagaCommandQueue.resetStaleClaimed({ olderThan })` | every 1-5 min | Return rows leaked by a crashed dispatcher to `pending`. Attempts is preserved, so the dispatcher's max-attempts policy still applies. |
| `PgSagaTimerStore.resetStaleClaimed({ olderThan })` | every 1-5 min | Return timers leaked by a crashed scheduler to `pending`. `fire_at` is unchanged — they fire as soon as a worker picks them up. |

All four take a tenant-scoped or all-tenants form (omit `tenantId` to sweep
globally). Run them under any tenant — internally they query by
`created_at` / `claimed_at`, not the tx tenant.

### Retention

`cleanup*` methods on the PG stores keep the saga tables bounded;
schedule them from the same cron as the watchdogs. (Idempotency
retention is already covered by `PgIdempotencyStore.cleanup` in the
maintenance-jobs table above.)

| Job | Frequency | Purpose |
|---|---|---|
| `PgSagaStateStore.cleanupTerminal({ olderThan, statuses? })` | daily | Delete saga instances with `status IN ('completed','failed')` past the cutoff. `statuses` defaults to both — pass `["completed"]` to keep `failed` rows around longer for triage. |
| `PgSagaCommandQueue.cleanupFailed({ olderThan })` | daily | Delete `status='failed'` rows past the cutoff. Successful dispatches are already ack-deleted. |
| `PgSagaTimerStore.cleanupTerminal({ olderThan, statuses? })` | daily | Delete timers with `status IN ('fired','cancelled')` past the cutoff. `statuses` defaults to both — pass `["fired"]` to keep cancelled timers for "why didn't this fire?" triage. |

A 30-day retention window is the typical default. Pick longer if your
audit / compliance posture demands it; pick shorter to keep tables
hot. The framework deliberately does not start its own retention
daemon — cadence and window are ops choices.

### Watchdog reset → claim recovery

When `resetStaleInFlight` flips an idempotency row to `failed`, the next
`PgIdempotencyStore.claim` for the same key recovers it atomically: the
INSERT ... ON CONFLICT DO UPDATE WHERE status='failed' branch reclaims
the slot in one statement. Clients see a normal retry — the watchdog is
invisible to them.

### Triage: persistent `failed` rows

- **`command_idempotency.status = 'failed'`** — set by the watchdog. If
  the same key never retries, the row is harmless and pruned by
  `cleanup`. Persistent failures across keys point to a downstream
  outage; check application logs around the timestamps.
- **`saga_pending_commands.status = 'failed'`** — set by the dispatcher
  after `maxAttempts` (default 5). The command will not be retried
  automatically. Investigate `last_error`; once the underlying issue is
  fixed, requeue by `UPDATE ... SET status = 'pending', attempts = 0`.
- **`saga_instances.status = 'failed'`** — saga itself has dead-lettered.
  Manual recovery: edit `state`, then flip `status = 'active'`. Silent
  auto-recovery is intentionally not provided — sagas hold business
  state and require human judgement.
