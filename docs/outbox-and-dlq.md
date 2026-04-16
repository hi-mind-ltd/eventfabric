# Outbox Pattern and Dead-Letter Queue

The [transactional outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html) guarantees that events are delivered to external systems at least once, without relying on distributed transactions. EventFabric implements this pattern with `PgOutboxStore` for claim/ack/release lifecycle, `PgDlqService` for dead-letter management, and `PgOutboxStatsService` for operational monitoring.

## When to use the outbox

Use the outbox for **external side effects** -- operations that leave the database boundary:

- Sending emails (SendGrid, SES, SMTP)
- Calling webhooks or third-party APIs
- Publishing messages to external brokers (Kafka, RabbitMQ, SQS)
- Updating external search indexes (Elasticsearch, Algolia)

The outbox guarantees that if the event is committed to the event log, it will eventually be delivered to the external system -- even if the application crashes between the write and the delivery.

## When NOT to use the outbox

Do **not** use the outbox for **internal projections** that only do database work:

- Updating read model tables within the same database
- Process managers that react to events and emit more events
- Audit logging to a table in the same database

For these cases, use [Catch-Up Projections](./projections/catch-up-projections.md) instead. Catch-up projections read directly from the event log via checkpoints -- no outbox row per event, no topic routing, simpler failure model.

| Criterion | Use outbox | Use catch-up |
|-----------|-----------|-------------|
| Calls external service | Yes | No |
| Needs per-message retry + DLQ | Yes | No |
| Needs topic-based routing | Yes | No |
| Pure database work | No (wasteful) | Yes |
| Process manager (event chains) | Possible but heavier | Preferred |

## How the outbox works

### 1. Atomic enqueue

When events are appended via `PgEventStore.append()` with `enqueueOutbox: true`, the outbox row is inserted in the **same transaction** as the event:

```sql
INSERT INTO eventfabric.outbox (global_position, topic)
VALUES ($1, $2)
ON CONFLICT (global_position) DO NOTHING
```

If the transaction commits, both the event and the outbox row are durable. If it rolls back, neither exists.

### 2. Claim

A background runner (the `AsyncProjectionRunner`) polls the outbox and claims a batch of rows using `FOR UPDATE SKIP LOCKED`:

```sql
WITH cte AS (
  SELECT id
  FROM eventfabric.outbox
  WHERE dead_lettered_at IS NULL
    AND locked_at IS NULL
    AND ($3::text IS NULL OR topic = $3)
  ORDER BY id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE eventfabric.outbox o
SET locked_at = now(),
    locked_by = $2,
    attempts = attempts + 1
FROM cte
WHERE o.id = cte.id
RETURNING o.id, o.global_position, o.topic, o.attempts
```

Key properties of this query:

- **`FOR UPDATE SKIP LOCKED`**: Non-blocking concurrent access. If another worker already locked a row, this worker skips it instead of waiting. Multiple workers can poll simultaneously without deadlocks.
- **Atomic lock + increment**: The `UPDATE` sets `locked_at`, `locked_by`, and increments `attempts` in one statement.
- **Topic filter**: The optional `$3` parameter filters by topic, allowing workers to specialize.
- **Ordered**: Rows are claimed in insertion order (`ORDER BY id ASC`).

### 3. Process + Ack/Release

After claiming, the runner loads the corresponding event from the event store, dispatches it to matching projections, and then:

- **On success**: Acknowledges the message by deleting the outbox row.
- **On failure**: Releases the message by clearing the lock, allowing it to be reclaimed on the next poll.

### 4. Dead-letter

When a message exceeds `maxAttempts`, the runner dead-letters it: copies the row to `eventfabric.outbox_dead_letters` and deletes it from the active outbox.

## PgOutboxStore

```typescript
// @eventfabric/postgres

export class PgOutboxStore implements OutboxStore<PgTx> {
  constructor(
    outboxTable?: string,   // Default: "eventfabric.outbox"
    dlqTable?: string       // Default: "eventfabric.outbox_dead_letters"
  );

  claimBatch(tx: PgTx, opts: {
    batchSize: number;
    workerId: string;
    topic?: string | null;
  }): Promise<OutboxRow[]>;

  ack(tx: PgTx, id: OutboxRow["id"]): Promise<void>;

  releaseWithError(tx: PgTx, id: OutboxRow["id"], error: string): Promise<void>;

  deadLetter(tx: PgTx, row: OutboxRow, reason: string): Promise<void>;
}
```

| Method | Description |
|--------|-------------|
| `claimBatch` | Locks up to `batchSize` rows for this worker. Returns `OutboxRow[]` with `id`, `globalPosition`, `topic`, and `attempts`. |
| `ack` | Deletes the row from the outbox. Called after successful processing. |
| `releaseWithError` | Clears `locked_at` and `locked_by`, stores the error in `last_error`. The row becomes claimable again on the next poll. |
| `deadLetter` | Copies the row to the DLQ table, then deletes it from the active outbox. |

### OutboxRow

```typescript
export interface OutboxRow {
  id: string | number;
  globalPosition: bigint;
  topic: string | null;
  attempts: number;
}
```

## Claim mechanism: `FOR UPDATE SKIP LOCKED`

PostgreSQL's `FOR UPDATE SKIP LOCKED` is the heart of the outbox pattern. It provides:

1. **Mutual exclusion**: Each row is locked by at most one worker at a time.
2. **Non-blocking**: Workers never wait for each other. If a row is locked, it is skipped.
3. **Fairness**: Rows are processed in order. A locked row is just temporarily invisible, not permanently skipped.
4. **No coordination**: Workers don't need to know about each other. They all poll the same table.

This is why EventFabric doesn't need an external message broker for the outbox pattern -- PostgreSQL provides all the coordination primitives natively.

## PgDlqService

The dead-letter queue (DLQ) stores messages that have exhausted their retry attempts. `PgDlqService` provides operations for inspecting and managing the DLQ.

```typescript
// @eventfabric/postgres

export class PgDlqService implements DlqService {
  constructor(
    pool: Pool,
    outboxTable?: string,   // Default: "eventfabric.outbox"
    dlqTable?: string       // Default: "eventfabric.outbox_dead_letters"
  );

  list(options?: ListDlqOptions): Promise<{ items: DlqItem[]; total: number }>;
  get(dlqId: DlqItem["id"]): Promise<DlqItem | null>;
  requeue(dlqId: DlqItem["id"]): Promise<{ requeued: boolean; reason?: string }>;
  requeueByGlobalPosition(globalPosition: bigint): Promise<{ requeued: boolean; reason?: string }>;
  requeueRange(from: bigint, to: bigint): Promise<{ requeued: number }>;
  purge(options?: { topic?: string | null; olderThan?: Date }): Promise<{ purged: number }>;
}
```

### DlqItem

```typescript
export type DlqItem = {
  id: string | number;
  outboxId: string | number;
  globalPosition: bigint;
  topic: string | null;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: string;
};
```

### ListDlqOptions

```typescript
export type ListDlqOptions = {
  limit?: number;    // Default: 100
  offset?: number;   // Default: 0
  topic?: string | null;  // Filter by topic
};
```

### DLQ operations

| Method | Description |
|--------|-------------|
| `list(options?)` | Returns paginated DLQ items with total count. Filterable by topic. |
| `get(dlqId)` | Returns a single DLQ item by ID, or null. |
| `requeue(dlqId)` | Moves a DLQ item back to the active outbox with `attempts = 0`. The runner will try again. |
| `requeueByGlobalPosition(pos)` | Same as `requeue`, but looks up the DLQ item by its event's global position. |
| `requeueRange(from, to)` | Requeues all DLQ items in the given global position range. |
| `purge(options?)` | Permanently deletes DLQ items. Filterable by topic and age (`olderThan`). |

## PgOutboxStatsService

Provides real-time statistics about the outbox backlog for monitoring dashboards and alerting.

```typescript
// @eventfabric/postgres

export class PgOutboxStatsService {
  constructor(pool: Pool, outboxTable?: string);

  getBacklogStats(): Promise<OutboxBacklogStats>;
}

export type OutboxBacklogStats = {
  totalPending: number;           // Total non-dead-lettered rows
  oldestPendingAt: string | null; // ISO timestamp of oldest pending row
  oldestAgeSeconds: number | null; // Age of oldest pending row in seconds
  perTopic: { topic: string | null; count: number }[];  // Backlog per topic
};
```

Use `getBacklogStats()` to detect:

- **Growing backlogs**: `totalPending` increasing over time means runners can't keep up.
- **Stuck messages**: `oldestAgeSeconds` growing means messages are not being processed.
- **Topic imbalances**: `perTopic` shows which topics have the most pending messages.

## DLQ workflow

A typical DLQ workflow in production:

### 1. Monitor

Expose the DLQ and outbox stats via ops endpoints:

```typescript
import { PgDlqService, PgOutboxStatsService } from "@eventfabric/postgres";

const dlq = new PgDlqService(pool);
const outboxStats = new PgOutboxStatsService(pool);

// List DLQ items
app.get("/ops/dlq", async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const offset = req.query.offset ? Number(req.query.offset) : undefined;
  const topic = (req.query.topic as string | undefined) ?? null;
  const result = await dlq.list({ limit, offset, topic });
  res.json({
    total: result.total,
    items: result.items.map(i => ({
      ...i,
      globalPosition: i.globalPosition.toString()
    }))
  });
});

// Outbox backlog stats
app.get("/ops/outbox", async (_req, res) => {
  res.json(await outboxStats.getBacklogStats());
});
```

### 2. Investigate

When a message lands in the DLQ, inspect its `lastError` to understand the failure:

```typescript
const item = await dlq.get(dlqId);
console.log(item?.lastError);
// "Error: SMTP connection refused at smtpClient.send ..."
```

Load the original event to understand what was being processed:

```typescript
const envs = await store.loadByGlobalPositions(tx, [item.globalPosition]);
console.log(envs[0]?.payload);
```

### 3. Fix and requeue

After fixing the root cause (e.g., restoring SMTP connectivity), requeue the failed message:

```typescript
// Requeue a single item
await dlq.requeue(dlqId);

// Or requeue by global position
await dlq.requeueByGlobalPosition(42n);

// Or requeue a range (e.g., all messages that failed during an outage)
await dlq.requeueRange(100n, 200n);
```

Requeuing inserts a fresh outbox row with `attempts = 0`, so the runner will process it again from scratch.

### 4. Purge

After confirming that requeued messages processed successfully, purge old DLQ entries:

```typescript
// Purge all DLQ items older than 30 days
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
await dlq.purge({ olderThan: thirtyDaysAgo });

// Purge all DLQ items for a specific topic
await dlq.purge({ topic: "email" });
```

## Monitoring stuck messages

Set up alerts based on `OutboxBacklogStats`:

```typescript
const stats = await outboxStats.getBacklogStats();

// Alert if backlog is growing
if (stats.totalPending > 1000) {
  alerting.warn(`Outbox backlog at ${stats.totalPending} messages`);
}

// Alert if oldest message is stuck
if (stats.oldestAgeSeconds && stats.oldestAgeSeconds > 300) {
  alerting.critical(
    `Oldest outbox message is ${stats.oldestAgeSeconds}s old. ` +
    `Runners may be down or stuck.`
  );
}

// Alert on per-topic imbalances
for (const t of stats.perTopic) {
  if (t.count > 500) {
    alerting.warn(`Topic "${t.topic}" has ${t.count} pending messages`);
  }
}
```

## Database schema

The outbox tables are created as part of EventFabric's schema migration:

```sql
CREATE TABLE eventfabric.outbox (
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

CREATE TABLE eventfabric.outbox_dead_letters (
  id BIGSERIAL PRIMARY KEY,
  outbox_id BIGINT,
  global_position BIGINT NOT NULL,
  topic TEXT NULL,
  attempts INT NOT NULL,
  last_error TEXT NULL,
  dead_lettered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Related docs

- [Async Projections](./projections/async-projections.md) -- the `AsyncProjectionRunner` that consumes the outbox
- [Catch-Up Projections](./projections/catch-up-projections.md) -- when to use catch-up instead of outbox
- [Projections Overview](./projections/overview.md) -- the three projection tiers and decision matrix
- [Observability](./observability.md) -- monitoring runner and DLQ activity with OpenTelemetry
- [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html) -- the original pattern description
