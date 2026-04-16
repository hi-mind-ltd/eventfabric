# Concurrency Control

EventFabric uses **optimistic concurrency control** to prevent conflicting writes to the same aggregate stream. When two requests try to append events to the same aggregate at the same version, exactly one wins and the other receives a `ConcurrencyError`. The caller can then decide whether to retry or surface the error.

## How EventFabric implements optimistic concurrency

Every event in an aggregate stream has an `aggregate_version` — a monotonically increasing integer that starts at 1. When appending events, the caller provides an `expectedAggregateVersion` representing the version they believe the stream is currently at.

### The stream_versions gate

The `eventfabric.stream_versions` table is the **single source of truth** for stream versions. It has one row per aggregate stream, with a composite primary key of `(aggregate_name, aggregate_id)`.

Every `PgEventStore.append()` call performs an **atomic version check** on this table before inserting any events. Both the version check and the event insert happen in the same database transaction.

#### New stream (expectedVersion = 0)

```sql
INSERT INTO eventfabric.stream_versions
  (aggregate_name, aggregate_id, current_version)
VALUES ($1, $2, $3)
```

If the stream already exists, the PRIMARY KEY violation is caught and translated into a `ConcurrencyError`:

```
ConcurrencyError: Cannot start stream: Account:acc-1 already exists
```

#### Existing stream (expectedVersion > 0)

```sql
UPDATE eventfabric.stream_versions
SET current_version = $3, updated_at = now()
WHERE aggregate_name = $1
  AND aggregate_id = $2
  AND current_version = $4   -- ← atomic check
```

If `rowCount === 0`, another writer has already moved the version forward:

```
ConcurrencyError: Expected version 3 but stream Account:acc-1 is at 5
```

Only after the version gate passes does the INSERT into `eventfabric.events` happen.

### Why this is stronger than a UNIQUE constraint

EventFabric previously used a `UNIQUE (aggregate_name, aggregate_id, aggregate_version)` constraint on the events table as a fallback concurrency check. The stream_versions approach replaces this and is strictly stronger:

| | UNIQUE constraint (old) | stream_versions (current) |
|---|---|---|
| **Mechanism** | INSERT events → constraint catches duplicates after the fact | Atomic UPDATE on stream_versions → then INSERT events |
| **Race window** | TOCTOU gap between `SELECT MAX(version)` and `INSERT` under READ COMMITTED | None — a single `UPDATE ... WHERE current_version = expected` is atomic |
| **Error clarity** | Raw PostgreSQL 23505 error, requires translation | Clean `ConcurrencyError` with expected vs actual version |
| **Partitioning** | Blocks it (UNIQUE must include the partition key) | Enables it (stream_versions is a separate unpartitioned table) |

This pattern is used by [Marten DB](https://martendb.io/) (`mt_streams`), [SQLStreamStore](https://github.com/SQLStreamStore/SQLStreamStore) (`Streams`), and [EventStoreDB](https://www.eventstore.com/) (internal stream metadata).

### Sequence diagram

```
Writer A                    stream_versions              events
   │                              │                        │
   ├─ UPDATE WHERE v=3 ─────────►│                        │
   │  ◄── rowCount=1 (locked) ───┤                        │
   │                              │                        │
Writer B                          │                        │
   ├─ UPDATE WHERE v=3 ─────────►│                        │
   │  (blocks — row locked by A)  │                        │
   │                              │                        │
Writer A                          │                        │
   ├─ INSERT events ─────────────────────────────────────►│
   ├─ COMMIT ─────────────────────┤                        │
   │                              │                        │
Writer B (unblocks)               │                        │
   │  ◄── rowCount=0 ────────────┤                        │
   │  → ConcurrencyError         │                        │
```

Under PostgreSQL's default `READ COMMITTED` isolation, the `UPDATE` acquires a row-level lock. Writer B blocks until Writer A commits (or rolls back). After A commits, B's `WHERE current_version = 3` no longer matches (A bumped it), so B gets `rowCount = 0` and throws `ConcurrencyError`.

## ConcurrencyError

```typescript
// @eventfabric/postgres

export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}
```

The `name` property is set to `"ConcurrencyError"`, which is how the retry helper identifies it (see below). This design decouples `@eventfabric/core` from `@eventfabric/postgres` — the core package matches on `err.name === "ConcurrencyError"` without importing the class.

## `withConcurrencyRetry(fn, opts)`

The `withConcurrencyRetry` helper runs a function and retries it if a `ConcurrencyError` is thrown. The caller is responsible for doing a complete **load -> decide -> save** cycle inside `fn` — retry re-invokes the entire function, so the aggregate must be re-loaded from the store and the command re-run against the fresh state.

```typescript
// @eventfabric/core

export async function withConcurrencyRetry<T>(
  fn: () => Promise<T>,
  opts?: ConcurrencyRetryOptions
): Promise<T>;

export type ConcurrencyRetryOptions = {
  maxAttempts?: number;      // Total attempts including first try. Default: 3.
  backoff?: BackoffOptions;  // Exponential backoff between retries. Default: no delay.
  isConcurrencyError?: (err: unknown) => boolean;  // Custom predicate. Default: name === "ConcurrencyError".
};
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxAttempts` | 3 | Maximum total attempts (including the first). After exhausting all attempts, the last error is thrown. |
| `backoff` | `undefined` (no delay) | If provided, exponential backoff between retries. Uses `computeBackoffMs` with jitter. |
| `isConcurrencyError` | `(err) => err.name === "ConcurrencyError"` | Predicate that decides whether an error triggers a retry. Override this to match custom error types. |

### How the retry works

```typescript
let attempt = 0;
while (true) {
  try {
    return await fn();
  } catch (err) {
    attempt++;
    if (attempt >= maxAttempts || !isConcurrency(err)) throw err;
    if (opts.backoff) await sleep(computeBackoffMs(attempt, opts.backoff));
  }
}
```

On each retry, `fn` is called from scratch. The caller must re-load the aggregate inside `fn` to get the latest state — otherwise the retry will fail with the same stale version.

## Example: deposit endpoint with concurrency retry

From the banking-api example:

```typescript
import { withConcurrencyRetry } from "@eventfabric/core";

app.post("/accounts/:id/deposit", async (req, res) => {
  try {
    const id = req.params.id;
    const { amount, transactionId } = req.body;

    const balance = await withConcurrencyRetry(
      async () => {
        // Fresh session on every attempt — re-loads the aggregate
        const session = sessionFactory.createSession();
        const account = await session.loadAggregateAsync<AccountAggregate>(id);
        account.deposit(amount, transactionId);
        await session.saveChangesAsync();
        return account.balance;
      },
      {
        maxAttempts: 3,
        backoff: { minMs: 10, maxMs: 100, factor: 2, jitter: 0.2 }
      }
    );

    res.json({ ok: true, accountId: id, balance });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});
```

Key points in this example:

1. **A new session is created inside the retry function.** This ensures the aggregate is re-loaded from the database on each attempt, picking up any events appended by concurrent requests.
2. **Backoff is small.** For in-process retries, 10-100ms is sufficient to let the conflicting transaction commit.
3. **The entire load -> decide -> save cycle is inside `fn`.** No state leaks between attempts.

## When to retry vs when to surface the error

Retrying a concurrency error is **not always correct**. Consider these scenarios:

### Safe to retry

- **Deposit**: The command is "add $100 to the balance." If a concurrent deposit changed the balance from $500 to $600, the retry re-loads the aggregate at $600 and deposits $100 to get $700. The business decision (deposit) is valid regardless of the starting state.
- **Increment counter**: Same reasoning — the operation is commutative and makes sense at any starting state.

### Unsafe to retry

- **Business decision invalidation**: "Transfer $100 if balance >= $200." If a concurrent withdrawal reduced the balance to $150, the retry re-loads the aggregate and the business rule rejects the transfer. The retry is safe in this case — it will throw a domain error, not a concurrency error — but the caller should understand that retrying doesn't guarantee success.
- **Side effects already fired**: If the function sends an email or calls an external API before the write, retrying would send the email twice. Move external side effects to [Async Projections](./projections/async-projections.md) instead.
- **User-visible operations**: If the function returned a confirmation to the user before the write (which it shouldn't, but sometimes happens), retrying silently changes what the user was told.

**Rule of thumb:** Only retry when the function is a pure **load -> decide -> save** cycle with no side effects outside the database transaction. When in doubt, surface the `ConcurrencyError` and let the caller (API handler, job scheduler, user) decide.

## BackoffOptions

The backoff configuration shared by `withConcurrencyRetry` and `AsyncProjectionRunner`:

```typescript
export type BackoffOptions = {
  minMs: number;   // Minimum delay in milliseconds
  maxMs: number;   // Maximum delay (cap)
  factor: number;  // Exponential growth factor
  jitter: number;  // Random jitter factor (0 to 1)
};
```

The delay for attempt `n` is computed as:

```
base = min(maxMs, minMs * factor^n)
jitter_offset = base * jitter * random(-1, 1)
delay = max(0, floor(base + jitter_offset))
```

Jitter prevents thundering-herd effects when multiple clients retry simultaneously.

## Related docs

- [Partitioning](./partitioning.md) — how stream_versions enables table partitioning
- [Projections Overview](./projections/overview.md) — how concurrency relates to projection tiers
- [Async Projections](./projections/async-projections.md) — backoff strategy in the async runner
- [Schema Evolution](./schema-evolution.md) — how event versions interact with aggregate versioning
- [Schema Reference](./schema-reference.md) — stream_versions table definition
