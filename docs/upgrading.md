# Upgrading

## From 0.4.0 to the next release

This release fixes bugs found in a review of every package. Most fixes need
nothing from you. This page lists what does, then what's new, then the rest.

### 1. Run the migrations

Two new migrations. `migrate()` applies both:

| Migration | Package | What it does | Needed for |
|---|---|---|---|
| `018_command_request_hash` | `@eventfabric/mediator-postgres` | Adds `request_hash` to `eventfabric.command_idempotency` | Detecting an idempotency key reused with a different payload |
| `019_outbox_dead_letter_reason` | `@eventfabric/postgres` | Adds `reason` to `eventfabric.outbox_dead_letters` | Dead-lettering (`PgOutboxStore.deadLetter` writes the column) |

```ts
await migrate(pool, { extensions: [commandsMigrations, sagasMigrations] });
```

**Run `migrate()` before the new version processes the outbox.** Without 019,
dead-lettering a message fails.

`migrate()` is now safe to call from every instance at startup at the same
time: a Postgres advisory lock makes them take turns. It holds one pool
connection while it runs.

Rows written before 018 have no `request_hash`, so their keys skip the payload
check. Rows written before 019 have `reason = NULL`.

### 2. Changes that may affect your code

| Change | Who is affected | What to do |
|---|---|---|
| **Reusing an idempotency key for a different command** now throws `IdempotencyKeyConflictError` (`reason: "command-type"` or `"payload"`). It used to return the first command's result and drop the new command. | Clients that reuse keys across different commands or payloads | Use a new key per distinct command. A retry must send the same type and payload. Key order in the payload doesn't matter. |
| **The query builder rejects input it can't use safely.** Column names must be plain identifiers (`^[A-Za-z_][A-Za-z0-9_]*$`), operators and sort direction must come from the documented set, and `limit` / `offset` must be non-negative integers. Anything else throws. | Code that passes request input (`?sort=`, filters) to `.where()` / `.orderBy()` | Validate or map user input before passing it. JSONB keys are parameters and accept any string. See [Query Builder](./query-builder.md#sql-injection-protection). |
| **`raise()` applies the event as it will be stored (JSON).** A `Date` in an event becomes its ISO string, `undefined` fields are dropped, and a `bigint` throws at `raise()`. | Aggregate handlers that read a `Date` object from a live event | Read the ISO string (handlers already got a string on reload). Store `bigint` values as strings. See [Aggregates](./aggregates.md#raise). |
| **A failed save leaves the aggregate unchanged.** `Repository.save()` and `saveChangesAsync()` update the aggregate only after the commit. Before, a failed `Repository.save()` emptied the pending events, and a retry returned `null` without writing. | Code that retries `save()` on the same aggregate, or reads `agg.version` after a failed save | Nothing, unless you relied on the old behaviour. A retry now writes the events. |
| **OpenTelemetry metrics drop per-item ids.** `global_position`, `from_position`, `to_position`, `command_id`, `idempotency_key`, `principal_id`, `correlation_id`, `saga_instance` and `timer_id` are no longer metric attributes. They are still on spans. | Dashboards or alerts that group metrics by these labels | Use traces for per-item lookups. See [Observability](./observability.md). |
| **The first backoff retry waits `minMs`.** It used to wait `minMs × factor`. | Anyone who tuned `minMs` around the old timing | Nothing, or raise `minMs`. |
| **The async runner only acks rows it still holds.** If a handler runs longer than `leaseMs` and another worker claimed the row, the late `ack` / `deadLetter` throws `LeaseLostError` and the transaction rolls back. | Handlers slower than `leaseMs` (default 5 minutes) | Raise `leaseMs` above your slowest handler. Effects outside the database can still repeat; keep handlers idempotent. See [Outbox and DLQ](./outbox-and-dlq.md#lease-fencing). |
| **In batch mode, a failure is charged only to the row that failed.** The other rows are released without using an attempt. | Anyone who counted on whole-batch attempts | Nothing. |
| **`verifyStream` / `verifyAggregate` fail a stream that has events without a hash.** They used to pass it (a stream with no hashes verified with `eventsChecked: 0`), so a chain stripped of its hashes looked intact. The result has a new `unprotectedEvents` count. | Streams that existed before tamper-evidence was enabled; code that verifies aggregates that aren't chained | Pass `allowUnprotectedPrefix: true` for those streams. See [Tamper Evidence](./tamper-evidence.md#verifying-a-stream). |
| **A missing or empty `hashChain.secret` throws** when `PgEventStore` or `PgChainAnchorSealer` is constructed. Before, an unset variable with `enabledAggregates` turned chaining off silently, and `""` was accepted. | Deployments where the secret's environment variable is unset or empty | Set the secret (32 random bytes or more). |
| **`dismiss()` throws for an event in a tamper-evident stream**, and `verifyStream` fails a chained event that is marked dismissed. Dismissal hides an event from replay and isn't covered by the hash, so it couldn't be told apart from tampering. | Code that dismisses events of a tamper-evident aggregate; chained streams that already hold dismissed events | Append a correcting event instead. For events already dismissed, clear `dismissed_at`, `dismissed_reason` and `dismissed_by` (and correct with a new event), or those streams fail verification. |
| **New hash format (v2) covers `occurred_at`.** New chained events are hashed with their timestamp, which the store now takes from the application clock (not the database's `now()`). Existing events stay in v1 and keep verifying; `legacyFormatEvents` counts them. | Everyone using tamper-evidence; custom verifiers built on `computeEventHash` | Upgrade every process that verifies before, or together with, those that append: an older release reports v2 events as a mismatch. Keep application clocks in sync (NTP). Custom verifiers: pass `occurredAt`, falling back to v1. |
| **Snapshots are taken when a save passes a multiple of `everyNEvents`**, not only when it lands on one. | Nothing to change | You may see slightly more snapshots. |

### 3. Custom implementations

If you implement these interfaces yourself, here is what's new. Everything is
optional unless marked.

| Interface | New | Effect if you don't implement it |
|---|---|---|
| `OutboxStore` | Optional `workerId` parameter on `ack`, `release`, `releaseWithError`, `deadLetter` | No lease fencing: a slow handler can commit twice |
| `SagaTimerStore` | `lockClaimed(tx, params)` | Every claimed timer is delivered, even one cancelled after the claim |
| `IdempotencyStore` | `afterCommit(tx)`, `afterRollback(tx)`. `ClaimResult` "completed" may carry `commandType` and `requestHash`; `claim` receives `requestHash` | A store that keeps slots outside the database can be answered from a result that was rolled back. Without `commandType` / `requestHash`, key reuse isn't detected |
| `DlqService` | `DlqItem.reason` | Field is undefined |

A custom repository should use `peekPendingEvents()` and `markCommitted()`
instead of `pullPendingEvents()`, so a failed save can be retried.

### 4. New options and APIs

- **Sagas:** `errorBackoff` option and `onLoopError` observer hook on
  `SagaTimerScheduler` and `SagaCommandDispatcher` (see
  [Sagas](./sagas.md#when-a-round-fails)). `onTimerSkipped` hook. Round results
  have a `skipped` count.
- **Saga cleanup:** `PgSagaStateStore.cleanupTerminal({ mode: "tombstone" })`
  keeps a stateless row so replaying a starting event (a projection reset or
  rebuild) can't restart a finished saga. Default is still `"delete"`.
- **OpenTelemetry metrics:** `eventfabric.saga.loop_error_total{component}`, and
  `result="skipped"` on `eventfabric.saga.timer_fire_total`.
- **Core:** `shouldSnapshot(policy, fromVersion, toVersion)`,
  `AggregateRoot.peekPendingEvents()` / `markCommitted()`, `LeaseLostError`.
- **Postgres:** `PgPartitionManager.enablePartitioningOn(client)`.

### 5. Fixed, no action needed

- **Saga loops:** the timer scheduler and command dispatcher kept running only
  until the first failed round (e.g. a database blip), then stopped for good.
  They now back off and retry, and `stop()` cuts a sleep short.
- **Saga timers:** a timer cancelled or re-scheduled between its claim and its
  delivery is skipped. A timer that re-schedules its own id keeps running.
- **Session snapshots** hold the full state at the saved version, including
  events appended directly with `append` / `startStream`.
- **Hash chain:** a process that hasn't registered a tamper-evident aggregate
  extends its chained streams instead of breaking them. Payloads with a `Date`
  verify correctly.
- **Partitioning:** concurrent `enablePartitioning()` calls no longer break the
  new table. The first boundary accounts for the sequence being ahead of
  `MAX(global_position)`.
- **Large batches:** `loadByGlobalPositions` and the anchor sealer no longer hit
  Postgres's 65,535-parameter limit.
- **Dead-letter reason** is stored and returned as `DlqItem.reason`.
- **In-memory idempotency store** removes slots from a rolled-back transaction.

### Worth knowing

- `purge({ topic: null })` deletes the tenant's **whole** DLQ: as in `list()`,
  `null` means all topics. Check for null if the topic comes from a variable.
