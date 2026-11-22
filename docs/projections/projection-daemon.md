# Projection Daemon

The `ProjectionDaemon` runs projections continuously in the background, reading straight from the event log. It is the recommended way to run asynchronous projections: read models, audit logs, process managers, and notifications that can tolerate a short delay. It works like [Marten's async daemon](https://martendb.io/events/projections/async-daemon.html).

What it gives you:

- **A checkpoint per projection and tenant.** Add a projection later and it back-fills from the start of the log. `rebuild` replays one from scratch.
- **No skipped events.** Reads stop at the [high water mark](#late-commits-and-the-high-water-mark), so an event whose transaction commits late is never skipped.
- **Safe to scale out.** Run the daemon on as many processes or nodes as you like. Each event is handled by one instance only.
- **Failure handling.** A failing event is retried with backoff. Events that keep failing go to a dead-letter table, and the projection moves on.

For an overview of all projection tiers, see [Projections Overview](./overview.md).

## Quick start

```typescript
import { createProjectionDaemon, PgEventStore } from "@eventfabric/postgres";
import type { CatchUpProjection } from "@eventfabric/core";
import type { PgTx } from "@eventfabric/postgres";

const accountSummary: CatchUpProjection<BankingEvent, PgTx> = {
  name: "account-summary",
  async handle(tx, env) {
    if (env.payload.type !== "AccountDeposited") return;
    await tx.client.query(
      `INSERT INTO account_summary (tenant_id, account_id, balance) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, account_id) DO UPDATE SET balance = EXCLUDED.balance`,
      [tx.tenantId, env.payload.accountId, env.payload.balance]
    );
  },
  // Optional: lets rebuild() clear this tenant's rows before replaying.
  async reset(tx) {
    await tx.client.query(`DELETE FROM account_summary WHERE tenant_id = $1`, [tx.tenantId]);
  }
};

const daemon = createProjectionDaemon(pool, new PgEventStore<BankingEvent>(), [accountSummary]);

const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());
await daemon.start(ac.signal); // resolves after abort, once the current batch finishes
```

Projections are plain `CatchUpProjection`s (`name`, `handle`, optional `reset`). [`forEventType`](./single-event-projections.md) works too.

## How it works

Each round, the daemon:

1. Reads the **high water mark**: the highest position below which every event is final.
2. Finds tenants with new events up to the mark. The first round scans the whole log; later rounds only look at new positions.
3. For each (projection, tenant) pair with work, runs batches until that pair is caught up, round-robin across pairs so one busy tenant cannot starve the others.

Each batch is one transaction scoped to the tenant:

```
BEGIN
  claim checkpoint (projection, tenant)       -- SELECT ... FOR UPDATE SKIP LOCKED
  load events (checkpoint, high water mark]   -- up to batchSize
  handle each event                           -- your handler's writes join this tx
  set checkpoint = last event in the batch
COMMIT
```

Your handler's database writes commit together with the checkpoint. If the batch fails, both roll back.

## Options

```typescript
createProjectionDaemon(pool, eventStore, projections, {
  batchSize: 500,          // events per (projection, tenant) transaction
  idleSleepMs: 500,        // sleep between rounds when there was nothing to do
  includeDismissed: false, // dismissed events are skipped (the checkpoint still moves past them)
  maxAttempts: 10,         // handler attempts per event before it is dead-lettered
  backoff: { minMs: 250, maxMs: 30000, factor: 2, jitter: 0.2 }, // retry delay for a failing event
  observer,                // CatchUpProjectorObserver hooks, plus onEventDeadLettered
  highWaterMark: { skipLiveTransactionsAfterMs: undefined } // see below
});
```

## Late commits and the high water mark

`global_position` is allocated when an event is **inserted**, not when its transaction **commits**. So position 102 can become visible while 101 is still in flight. A reader that takes "everything after my checkpoint" would move its checkpoint to 102 and never see 101.

The daemon reads only up to the **high water mark**: the highest position at or below which every event is final, either committed or rolled back for good. `PgHighWaterMark` works it out from PostgreSQL transaction snapshots. It samples the highest visible position, then waits until every transaction that was in flight at that moment has finished. Gaps left by rolled-back transactions need no special handling. Requires PostgreSQL 13+.

**Long-running write transactions hold the mark back.** Any open transaction that has written something could, in principle, still append events, so the mark waits for it, even if it is unrelated to events (a long data migration, say). Projections pause until it finishes. This is the safe default, and it matches Marten's. If you must, set `highWaterMark.skipLiveTransactionsAfterMs` to let the mark move past a transaction that has been open that long. Any event that transaction later commits at or below the mark is then **not** projected.

## Running several instances

Start the daemon on every node. Each batch claims its (projection, tenant) checkpoint with `SELECT … FOR UPDATE SKIP LOCKED`:

- Two instances never process the same batch: a busy pair is skipped and tried again next round.
- The lock lasts only as long as the batch transaction. There is no leader election, no lock monitoring, and it works through PgBouncer in transaction mode.
- Instances running **different** projections each see every event: each projection has its own checkpoint.

## Failures and dead letters

When a handler throws:

1. The batch rolls back. The events **before** the failing one are re-run and committed straight away, so one bad event only holds back the events after it.
2. The failing event is retried after a backoff (`backoff`), on this or another instance.
3. After `maxAttempts` failures, the event is recorded in `eventfabric.projection_dead_letters` and the checkpoint moves past it. `observer.onEventDeadLettered` fires.

Failures are isolated per (projection, tenant): one tenant's poison event does not block other tenants or other projections.

Infrastructure errors, such as the database being unavailable, are reported through `observer.onProjectorError`, and the daemon backs off.

```typescript
const dead = await daemon.listDeadLetters({ projectionName: "account-summary" });
// [{ id, projectionName, tenantId, globalPosition, eventId, eventType, attempts, lastError, deadLetteredAt }]

// After fixing the cause:
await daemon.replayDeadLetter(dead[0].id); // runs the handler again, then deletes the dead letter
```

`replayDeadLetter` runs the event **out of order**: the projection has already moved past it. If the handler throws again, the dead letter is kept and the error is rethrown.

## Rebuilding a projection

```typescript
await daemon.rebuild("account-summary");
```

For every tenant, in one transaction per tenant, holding the checkpoint claim:

1. calls `projection.reset(tx)` if defined (clear the read model; `tx.tenantId` is the tenant),
2. resets the checkpoint to 0,
3. deletes the projection's dead letters (the replay retries those events).

It then replays up to the current high water mark. Other instances running the same projection keep working and pick up the reset checkpoint on their next batch. Without `reset`, the replay runs on top of the existing read model, so handlers must be idempotent.

## Delivery guarantees

- **At least once.** If a batch's transaction fails to commit after a handler ran (connection lost at commit, for instance), the batch runs again. Handlers that call external services (email, HTTP) can see an event more than once and should de-duplicate, for example by `env.eventId`.
- **In order** per (projection, tenant), by `global_position`. Dead-letter replays are the exception.
- **Exactly once for database writes made through `tx`.** They commit atomically with the checkpoint.

## Daemon vs outbox runner

| | Projection daemon | Outbox `AsyncProjectionRunner` |
|---|---|---|
| Reads from | Event log | Outbox rows written with the event |
| Progress | Checkpoint per projection and tenant | Outbox row deleted when delivered |
| Add a projection later | Back-fills from the start | Sees only new events |
| Rebuild | `rebuild(name)` | Not possible |
| Several instances, different projections | Each sees every event | Each row goes to one runner: split with `claimTopic` |
| Topic routing | Filter on `env.payload.type` | `topicFilter` / `claimTopic` |

Use the daemon for projections. Use the [outbox runner](./async-projections.md) when you specifically need per-message outbox delivery with topic routing.

## Related docs

- [Catch-Up Projections](./catch-up-projections.md): the one-shot `CatchUpProjector` the daemon builds on
- [Async Projections](./async-projections.md): the outbox runner
- [Observability](../observability.md): observer hooks
- [Schema Reference](../schema-reference.md): `projection_checkpoints`, `projection_dead_letters`
