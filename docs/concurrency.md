# Concurrency Control

EventFabric uses **optimistic concurrency control** to prevent conflicting writes to the same aggregate stream. When two requests try to append events to the same aggregate at the same version, exactly one wins and the other receives a `ConcurrencyError`. The caller can then decide whether to retry or surface the error.

## How EventFabric implements optimistic concurrency

Every event in an aggregate stream has an `aggregate_version` -- a monotonically increasing integer that starts at 1. When appending events, the caller provides an `expectedAggregateVersion` representing the version they believe the stream is currently at.

The concurrency check has two layers:

### Layer 1: read-time version check

Before inserting, `PgEventStore.append()` queries the current maximum version:

```sql
SELECT COALESCE(MAX(aggregate_version), 0) AS v
FROM eventfabric.events
WHERE aggregate_name = $1 AND aggregate_id = $2
```

If the result doesn't match `expectedAggregateVersion`, the append fails immediately with a `ConcurrencyError`:

```typescript
if (currentVersion !== params.expectedAggregateVersion) {
  throw new ConcurrencyError(
    `Expected version ${params.expectedAggregateVersion} but stream is at ${currentVersion}`
  );
}
```

This catches the common case where the caller's state is clearly stale.

### Layer 2: insert-time UNIQUE constraint

The events table has a composite unique constraint:

```sql
UNIQUE (aggregate_name, aggregate_id, aggregate_version)
```

This catches the **TOCTOU race** (time-of-check-to-time-of-use) that exists under PostgreSQL's `READ COMMITTED` isolation level. Here is the scenario:

1. Transaction A reads `MAX(aggregate_version) = 3`, passes the check.
2. Transaction B reads `MAX(aggregate_version) = 3`, passes the check.
3. Transaction A inserts version 4 and commits.
4. Transaction B tries to insert version 4 -- the UNIQUE constraint rejects it with PostgreSQL error code `23505`.

EventFabric translates this raw database error into a `ConcurrencyError`:

```typescript
try {
  ins = await tx.client.query(`INSERT INTO ... VALUES ...`, values);
} catch (err: any) {
  if (err?.code === "23505" && String(err?.constraint ?? "").includes("aggregate_version")) {
    throw new ConcurrencyError(
      `Concurrent append to ${params.aggregateName}:${params.aggregateId} ` +
      `at expected version ${params.expectedAggregateVersion}`
    );
  }
  throw err;
}
```

Together, the two layers guarantee that exactly one concurrent writer succeeds for any given version, regardless of transaction isolation level or timing.

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

The `name` property is set to `"ConcurrencyError"`, which is how the retry helper identifies it (see below). This design decouples `@eventfabric/core` from `@eventfabric/postgres` -- the core package matches on `err.name === "ConcurrencyError"` without importing the class.

## `withConcurrencyRetry(fn, opts)`

The `withConcurrencyRetry` helper runs a function and retries it if a `ConcurrencyError` is thrown. The caller is responsible for doing a complete **load -> decide -> save** cycle inside `fn` -- retry re-invokes the entire function, so the aggregate must be re-loaded from the store and the command re-run against the fresh state.

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

On each retry, `fn` is called from scratch. The caller must re-load the aggregate inside `fn` to get the latest state -- otherwise the retry will fail with the same stale version.

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
        // Fresh session on every attempt -- re-loads the aggregate
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
- **Increment counter**: Same reasoning -- the operation is commutative and makes sense at any starting state.

### Unsafe to retry

- **Business decision invalidation**: "Transfer $100 if balance >= $200." If a concurrent withdrawal reduced the balance to $150, the retry re-loads the aggregate and the business rule rejects the transfer. The retry is safe in this case -- it will throw a domain error, not a concurrency error -- but the caller should understand that retrying doesn't guarantee success.
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

- [Projections Overview](./projections/overview.md) -- how concurrency relates to projection tiers
- [Async Projections](./projections/async-projections.md) -- backoff strategy in the async runner
- [Schema Evolution](./schema-evolution.md) -- how event versions interact with aggregate versioning
