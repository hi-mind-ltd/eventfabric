# Event Store

`PgEventStore<E>` from `@eventfabric/postgres` is the PostgreSQL implementation
of the event store. It reads and writes events in `eventfabric.events` and
optionally enqueues outbox rows in `eventfabric.outbox`.

## Constructor

```typescript
import { PgEventStore } from "@eventfabric/postgres";

const store = new PgEventStore<BankingEvent>(
  eventsTable?,   // default: "eventfabric.events"
  outboxTable?,   // default: "eventfabric.outbox"
  upcaster?       // optional EventUpcaster<E>
);
```

| Parameter     | Type                    | Default                | Description                                    |
| ------------- | ----------------------- | ---------------------- | ---------------------------------------------- |
| `eventsTable` | `string`                | `"eventfabric.events"` | Schema-qualified table name for events.        |
| `outboxTable` | `string`                | `"eventfabric.outbox"` | Schema-qualified table name for the outbox.    |
| `upcaster`    | `EventUpcaster<E>`      | `undefined`            | Transform applied to every loaded event payload after shape validation. |

### tableName getter

```typescript
store.tableName  // "eventfabric.events"
```

Returns the schema-qualified events table name. Used internally by `Session` to
query aggregate names and externally for custom queries.

## append()

Appends one or more events to an aggregate stream inside an existing
transaction.

```typescript
const result = await store.append(tx, {
  aggregateName: "Account",
  aggregateId: "acc-1",
  expectedAggregateVersion: 3,
  events: [
    {
      type: "AccountDeposited",
      version: 1,
      accountId: "acc-1",
      amount: 250,
      balance: 750,
    },
  ],
  meta: { correlationId: "req-abc", causationId: "cmd-xyz" },
  enqueueOutbox: true,
  outboxTopic: null,
});

// result.appended       -- EventEnvelope<E>[] with globalPosition, eventId, etc.
// result.nextAggregateVersion -- 4
```

### Parameters

| Field                        | Type        | Required | Description                                              |
| ---------------------------- | ----------- | -------- | -------------------------------------------------------- |
| `aggregateName`              | `string`    | yes      | The aggregate's static name (e.g. `"Account"`).          |
| `aggregateId`                | `string`    | yes      | The aggregate instance identity.                         |
| `expectedAggregateVersion`   | `number`    | yes      | The version the caller believes the stream is at.        |
| `events`                     | `E[]`       | yes      | One or more domain events to append.                     |
| `meta.correlationId`         | `string?`   | no       | Stored in the `correlation_id` column.                   |
| `meta.causationId`           | `string?`   | no       | Stored in the `causation_id` column.                     |
| `enqueueOutbox`              | `boolean?`  | no       | If `true`, inserts a row per event into `eventfabric.outbox`. |
| `outboxTopic`                | `string?`   | no       | Topic string stored on the outbox row (for filtering).   |

### Return value

```typescript
{
  appended: EventEnvelope<E>[];      // The newly inserted events with all envelope fields
  nextAggregateVersion: number;       // expectedAggregateVersion + events.length
}
```

If `events` is empty, the method returns immediately without touching the
database.

### Concurrency check

`append()` enforces optimistic concurrency in two layers:

**Read-time check:** Before inserting, the method queries
`MAX(aggregate_version)` for the stream. If the current version does not match
`expectedAggregateVersion`, a `ConcurrencyError` is thrown immediately.

```sql
SELECT COALESCE(MAX(aggregate_version), 0) AS v
FROM eventfabric.events
WHERE aggregate_name = $1 AND aggregate_id = $2
```

**Insert-time check:** Even if the read-time check passes, a concurrent
transaction could have inserted between the SELECT and the INSERT. The
`UNIQUE(aggregate_name, aggregate_id, aggregate_version)` constraint on
`eventfabric.events` catches this. The resulting PostgreSQL error code `23505`
is translated to a `ConcurrencyError`.

Both paths throw the same `ConcurrencyError` class, so callers only need to
handle one error type.

### Outbox enqueue

When `enqueueOutbox` is `true`, the method inserts one row per event into
`eventfabric.outbox` inside the same transaction:

```sql
INSERT INTO eventfabric.outbox (global_position, topic)
VALUES ($1, $2), ($3, $4), ...
ON CONFLICT (global_position) DO NOTHING
```

The `ON CONFLICT DO NOTHING` is safe because `global_position` is a foreign
reference to the events table and is unique.

## startStream()

Marten-style convenience method to start a new aggregate stream with initial
events.

```typescript
const result = await store.startStream(
  tx,
  "acc-1",
  AccountAggregate,
  { type: "AccountOpened", version: 2, accountId: "acc-1", customerId: "cust-1", initialBalance: 500, currency: "USD", region: "UK" },
  { type: "AccountDeposited", version: 1, accountId: "acc-1", amount: 500, balance: 500 }
);
```

### Signature

```typescript
async startStream(
  tx: PgTx,
  aggregateId: string,
  AggregateClass: { aggregateName: string } & (new (...args: any[]) => any),
  ...events: E[]
): Promise<{ appended: EventEnvelope<E>[]; nextAggregateVersion: number }>
```

### Behaviour

1. Reads the current max version for the stream.
2. If the stream already exists (version > 0), throws `ConcurrencyError`.
3. Delegates to `append()` with `expectedAggregateVersion: 0`.

At least one event is required. The aggregate class must have a static
`aggregateName` property.

## loadStream()

Loads all events for an aggregate stream, optionally from a given version.

### Overload 1 -- params object

```typescript
const envelopes = await store.loadStream(tx, {
  aggregateName: "Account",
  aggregateId: "acc-1",
  fromVersion: 5,           // optional, default: 1
  includeDismissed: false,   // optional, default: false
});
```

### Overload 2 -- Marten-style

```typescript
const envelopes = await store.loadStream(tx, "acc-1", AccountAggregate);
```

Both overloads return `EventEnvelope<E>[]` ordered by `aggregate_version ASC`.
Dismissed events are excluded by default unless `includeDismissed: true`.

The upcaster (if configured) runs on every returned envelope.

## loadGlobal()

Loads events across all streams in global position order. Used by catch-up
projections.

```typescript
const envelopes = await store.loadGlobal(tx, {
  fromGlobalPositionExclusive: 1000n,
  limit: 500,
  includeDismissed: false,
});
```

| Parameter                        | Type      | Description                                             |
| -------------------------------- | --------- | ------------------------------------------------------- |
| `fromGlobalPositionExclusive`    | `bigint`  | Events with `global_position > this` are returned.      |
| `limit`                          | `number`  | Maximum number of events to return in one batch.        |
| `includeDismissed`               | `boolean` | If `true`, dismissed events are included.               |

Results are ordered by `global_position ASC`.

## loadByGlobalPositions()

Loads specific events by their global positions. Used by the async projection
runner to resolve outbox rows to their corresponding events.

```typescript
const envelopes = await store.loadByGlobalPositions(tx, [42n, 43n, 44n]);
```

Returns `EventEnvelope<E>[]` ordered by `global_position ASC`. If `positions`
is empty, returns `[]` without a database round-trip.

## dismiss()

Soft-deletes an event by setting its `dismissed_at`, `dismissed_reason`, and
`dismissed_by` columns.

```typescript
await store.dismiss(tx, "a1b2c3d4-...", {
  reason: "GDPR erasure request",
  by: "admin@example.com",
  at: new Date().toISOString(),
});
```

Dismissed events are excluded from `loadStream()` and `loadGlobal()` by default.
The event data remains in the database but is filtered out during reads. Pass
`includeDismissed: true` to include them.

This is not a hard delete -- the `payload` JSONB column is preserved. If you
need true erasure, run an `UPDATE` to null out the payload separately.

## ConcurrencyError

```typescript
import { ConcurrencyError } from "@eventfabric/postgres";

try {
  await store.append(tx, { ... });
} catch (err) {
  if (err instanceof ConcurrencyError) {
    // The stream was modified by another transaction
  }
}
```

Thrown in two scenarios:

1. **Read-time mismatch:** `expectedAggregateVersion` does not match the
   current `MAX(aggregate_version)` in the stream.
2. **Insert-time conflict:** The `UNIQUE(aggregate_name, aggregate_id,
   aggregate_version)` constraint is violated by a concurrent insert
   (PostgreSQL error code `23505`).

Both paths produce the same error class. The `name` property is
`"ConcurrencyError"`, which is what the `withConcurrencyRetry` utility matches
against.

### Retrying on concurrency errors

Use `withConcurrencyRetry` from `@eventfabric/core` to automatically retry the
full load-decide-save cycle:

```typescript
import { withConcurrencyRetry } from "@eventfabric/core";

const balance = await withConcurrencyRetry(
  async () => {
    const session = factory.createSession();
    const account = await session.loadAggregateAsync<AccountAggregate>(id);
    account.deposit(amount);
    await session.saveChangesAsync();
    return account.balance;
  },
  { maxAttempts: 3, backoff: { minMs: 10, maxMs: 100, factor: 2, jitter: 0.2 } }
);
```

Only retry when the command is idempotent and has no side effects outside the
transaction. When in doubt, surface the error to the caller.

## RowShapeError

```typescript
import { RowShapeError } from "@eventfabric/postgres";
```

Thrown when a row read from `eventfabric.events` fails shape validation at the
database-to-domain boundary. Conditions that trigger it:

- The row is not an object.
- Required fields (`event_id`, `aggregate_name`, `aggregate_id`,
  `aggregate_version`, `global_position`, `occurred_at`, `payload`) are missing
  or null.
- The `payload` is not an object, or is missing `type` (string) or `version`
  (number).

`RowShapeError` signals schema drift, query typos, or database corruption. It
is a programming error, not a business error. Surfacing it as a distinct class
prevents malformed envelopes from silently flowing into projections or
aggregates.

## Internal: mapRow()

Every row returned from a query passes through `mapRow()`, which:

1. Calls `assertEventRow()` for shape validation (throws `RowShapeError`).
2. Runs the upcaster (if configured) on `payload`.
3. Converts PostgreSQL types to JavaScript (`BIGSERIAL` to `bigint`,
   `TIMESTAMPTZ` to ISO-8601 string, etc.).
4. Returns an `EventEnvelope<E>`.

## Related documentation

- [Events](./events.md) -- Event types, envelopes, versioning, upcasters
- [Sessions](./sessions.md) -- Higher-level API that wraps `PgEventStore`
- [Schema Reference](./schema-reference.md) -- `eventfabric.events` table definition
- [Core Concepts](./core-concepts.md) -- The transactional outbox pattern
