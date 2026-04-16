# Inline Projections

Inline projections run inside the same database transaction that appends events. If the projection handler fails, the entire write -- events and read model update -- rolls back. This guarantees **strong consistency** between the event log and the read model.

For an overview of all projection tiers, see [Projections Overview](./overview.md).

## Core interface

```typescript
// @eventfabric/core

export interface InlineProjection<E extends AnyEvent, TTx extends Transaction = Transaction> {
  name: string;
  handle(tx: TTx, env: EventEnvelope<E>): Promise<void>;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique identifier for the projection. Used for logging and diagnostics. |
| `handle` | `(tx, env) => Promise<void>` | Called once per event envelope, inside the write transaction. Receives the same `tx` used to append events. |

## InlineProjector class

The `InlineProjector` class holds an array of inline projections and runs them all for each event. It skips dismissed events automatically.

```typescript
// @eventfabric/core

export class InlineProjector<E extends AnyEvent, TTx extends Transaction = Transaction> {
  constructor(private readonly projections: InlineProjection<E, TTx>[]) {}

  async run(tx: TTx, envelopes: EventEnvelope<E>[]) {
    for (const env of envelopes) {
      if (env.dismissed) continue;
      for (const p of this.projections) {
        await p.handle(tx, env);
      }
    }
  }
}
```

For each non-dismissed event envelope, every registered projection's `handle` method is called sequentially within the same transaction.

## Registering an inline projector

When using the `SessionFactory` (the recommended Marten-style API), register the inline projector once at startup:

```typescript
import { SessionFactory, InlineProjector } from "@eventfabric/postgres";
import type { PgTx } from "@eventfabric/postgres";
import type { BankingEvent } from "./domain/events";

const sessionFactory = new SessionFactory<BankingEvent>(pool, store);

// Define inline projections
const accountReadProjection = {
  name: "account-read",
  async handle(tx: PgTx, env: EventEnvelope<BankingEvent>) {
    // Update the account_read table based on the event
    // (see full example below)
  }
};

// Register the inline projector
sessionFactory.registerInlineProjector(
  new InlineProjector([accountReadProjection])
);
```

When using the `Repository` class directly, pass the projector via the `opts` parameter:

```typescript
import { Repository, InlineProjector } from "@eventfabric/core";

const repo = new Repository<AccountAggregate, AccountState, BankingEvent, PgTx>(
  "Account",
  uow,
  store,
  (id, snap) => new AccountAggregate(id, snap),
  {
    inlineProjector: new InlineProjector([accountReadProjection])
  }
);
```

In both cases, the projector is invoked automatically after events are appended -- inside the same transaction.

## Example: building an `account_read` table

This projection maintains a denormalized `account_read` table that supports efficient balance queries without replaying event streams:

```typescript
import type { InlineProjection, EventEnvelope } from "@eventfabric/core";
import type { PgTx } from "@eventfabric/postgres";
import type { BankingEvent } from "./domain/events";

const accountReadProjection: InlineProjection<BankingEvent, PgTx> = {
  name: "account-read",
  async handle(tx: PgTx, env: EventEnvelope<BankingEvent>) {
    const event = env.payload;

    if (event.type === "AccountOpened") {
      await tx.client.query(
        `INSERT INTO account_read (account_id, customer_id, balance, currency, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (account_id) DO NOTHING`,
        [event.accountId, event.customerId, event.initialBalance, event.currency]
      );
    }

    if (event.type === "AccountDeposited" || event.type === "AccountWithdrawn") {
      await tx.client.query(
        `UPDATE account_read SET balance = $2, updated_at = now() WHERE account_id = $1`,
        [event.accountId, event.balance]
      );
    }

    if (event.type === "AccountClosed") {
      await tx.client.query(
        `DELETE FROM account_read WHERE account_id = $1`,
        [event.accountId]
      );
    }
  }
};
```

After a deposit, the `account_read` table is guaranteed to reflect the new balance before the HTTP response is sent -- because both the event append and the table update happen in the same transaction.

You can then query this table directly using the [Query Builder](../query-builder.md):

```typescript
import { query } from "@eventfabric/postgres";

type AccountReadModel = {
  account_id: string;
  customer_id: string;
  balance: number;
  currency: string;
  updated_at: string;
};

const highBalanceAccounts = await query<AccountReadModel>(pool, "account_read")
  .where("balance", ">=", 10000)
  .orderBy("balance", "desc")
  .limit(20)
  .toList();
```

## Trade-offs

**Benefits:**

- **Strong consistency.** The read model is always in sync with the event log. There is no window of staleness.
- **Simplicity.** No checkpoint tracking, no polling loop, no background worker. The projection just runs.
- **Atomicity.** If the projection fails, the write rolls back too. No inconsistent half-states.

**Costs:**

- **Increased write latency.** Every SQL statement the projection executes adds to the write transaction's duration. A slow projection slows down every write.
- **Blast radius.** A bug in the projection (e.g., a SQL error) prevents all writes from succeeding until the bug is fixed. The projection is in the critical write path.
- **Cannot call external services.** Because the projection runs inside a database transaction, it must not call external HTTP services, send emails, or do anything that cannot be rolled back. For external side effects, use [Async Projections](./async-projections.md).

**When to use inline projections:**

- The read model must never be stale relative to the event log.
- The projection logic is fast (simple SQL inserts/updates).
- The projection does not call external services.

**When to avoid inline projections:**

- Write latency is critical and the projection adds measurable overhead.
- The projection calls external services that cannot participate in a database transaction.
- You can tolerate a few hundred milliseconds of staleness -- use [Catch-Up Projections](./catch-up-projections.md) instead.

## Related docs

- [Projections Overview](./overview.md) -- the three projection tiers and decision matrix
- [Catch-Up Projections](./catch-up-projections.md) -- eventual consistency via checkpoint
- [Async Projections](./async-projections.md) -- eventual consistency via outbox
- [Query Builder](../query-builder.md) -- querying read models built by inline projections
