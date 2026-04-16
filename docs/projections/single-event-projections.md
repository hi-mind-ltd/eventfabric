# Single-Event Projections

When a projection only cares about one event type, the `forEventType` and `asyncForEventType` helpers eliminate boilerplate and give you precise TypeScript narrowing. Instead of writing an `if (env.payload.type !== ...)` guard and casting, the helper does it for you -- and the handler receives `env.payload` typed as the exact variant you matched.

For an overview of all projection tiers, see [Projections Overview](./overview.md).

## `forEventType` (catch-up)

Creates a `CatchUpProjection` that only reacts to events of a single type.

```typescript
// @eventfabric/core

export function forEventType<
  E extends AnyEvent,
  K extends E["type"],
  TTx extends Transaction = Transaction
>(
  name: string,
  eventType: K,
  handle: (tx: TTx, env: EventEnvelope<Extract<E, { type: K }>>) => Promise<void>
): CatchUpProjection<E, TTx>;
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Projection name (checkpoint key). |
| `eventType` | `K extends E["type"]` | The event type string to match. |
| `handle` | `(tx, env) => Promise<void>` | Handler called only for matching events. `env.payload` is narrowed to `Extract<E, { type: K }>`. |

**Returns:** A `CatchUpProjection<E, TTx>` that can be passed to `CatchUpProjector.catchUpProjection()` or `catchUpAll()`.

### How it works

The returned projection's `handle` method checks `env.payload.type !== eventType` and returns early for non-matching events. The checkpoint still advances past non-matching events -- this is correct behavior, since the projection has "seen" the event and decided it didn't care.

```typescript
// Simplified internal implementation
return {
  name,
  async handle(tx, env) {
    if (env.payload.type !== eventType) return;
    await handle(tx, env as EventEnvelope<Extract<E, { type: K }>>);
  }
};
```

## `asyncForEventType` (async/outbox)

Creates an `AsyncProjection` that only reacts to events of a single type, with optional topic filtering.

```typescript
// @eventfabric/core

export function asyncForEventType<
  E extends AnyEvent,
  K extends E["type"],
  TTx extends Transaction = Transaction
>(
  name: string,
  eventType: K,
  handle: (tx: TTx, env: EventEnvelope<Extract<E, { type: K }>>) => Promise<void>,
  options?: { topicFilter?: TopicFilter }
): AsyncProjection<E, TTx>;
```

The optional `topicFilter` composes with the event-type check: the runner's topic filter decides which outbox rows are claimed at all, and the event-type check narrows further inside the handler.

## TypeScript `Extract` narrowing

The key type-safety feature is the use of TypeScript's `Extract` utility type. Given a discriminated union:

```typescript
type BankingEvent =
  | { type: "AccountOpened"; version: 2; accountId: string; customerId: string; initialBalance: number; currency: string; region: string }
  | { type: "AccountDeposited"; version: 1; accountId: string; amount: number; balance: number; transactionId?: string }
  | { type: "AccountWithdrawn"; version: 1; accountId: string; amount: number; balance: number; transactionId?: string }
  | { type: "AccountClosed"; version: 1; accountId: string; reason: string }
  // ... more variants
```

When you write `forEventType<BankingEvent, "AccountDeposited", PgTx>(...)`, TypeScript resolves the handler's `env.payload` type to:

```typescript
Extract<BankingEvent, { type: "AccountDeposited" }>
// resolves to:
{ type: "AccountDeposited"; version: 1; accountId: string; amount: number; balance: number; transactionId?: string }
```

This means you get full field-level type safety inside the handler without any casts or type guards.

## Example: deposit audit projection

From the banking-api example:

```typescript
import { forEventType } from "@eventfabric/core";
import type { BankingEvent } from "./domain/events";
import type { PgTx } from "@eventfabric/postgres";

export const depositAuditProjection = forEventType<BankingEvent, "AccountDeposited", PgTx>(
  "deposit-audit",
  "AccountDeposited",
  async (_tx, env) => {
    // env.payload is typed as AccountDepositedV1 -- full field narrowing
    const { accountId, amount, balance, transactionId } = env.payload;
    console.log(
      `[deposit-audit] account=${accountId} +${amount} (balance=${balance})` +
        (transactionId ? ` tx=${transactionId}` : "")
    );
  }
);
```

Use it like any other catch-up projection:

```typescript
import { createCatchUpProjector } from "@eventfabric/postgres";

const projector = createCatchUpProjector<BankingEvent>(pool, store);

// Compose with other projections -- each tracks its own checkpoint
await projector.catchUpAll([
  withdrawalProjection,
  depositProjection,
  completionProjection,
  depositAuditProjection  // <-- single-event projection, mixed in freely
], { batchSize: 100 });
```

## When to use `forEventType` vs a plain `if` guard

| Approach | Best when |
|----------|-----------|
| `forEventType` helper | The entire projection reacts to exactly one event type. Gives you the cleanest type narrowing with zero boilerplate. |
| Plain `if (event.type !== ...)` guard | The projection reacts to multiple event types, or the dispatching logic is more complex (e.g., checking event fields beyond `type`). |

For projections that handle multiple event types, use a standard `CatchUpProjection` with explicit type checks:

```typescript
const multiEventProjection: CatchUpProjection<BankingEvent, PgTx> = {
  name: "balance-tracker",
  async handle(tx, env) {
    const event = env.payload;
    if (event.type === "AccountDeposited") {
      // event is narrowed to AccountDepositedV1 by TypeScript control flow
      await updateBalance(tx, event.accountId, event.balance);
    }
    if (event.type === "AccountWithdrawn") {
      // event is narrowed to AccountWithdrawnV1
      await updateBalance(tx, event.accountId, event.balance);
    }
    // Other event types are ignored; checkpoint still advances.
  }
};
```

## Async variant example

```typescript
import { asyncForEventType } from "@eventfabric/core";
import type { BankingEvent } from "./domain/events";
import type { PgTx } from "@eventfabric/postgres";

const depositEmailProjection = asyncForEventType<BankingEvent, "AccountDeposited", PgTx>(
  "deposit-email",
  "AccountDeposited",
  async (_tx, env) => {
    const { accountId, amount, balance } = env.payload;
    await emailService.sendEmail(
      `customer-${accountId}@example.com`,
      "Deposit Confirmed",
      `Your account has been credited with $${amount}. New balance: $${balance}`
    );
  },
  {
    topicFilter: { mode: "include", topics: ["account"] }
  }
);
```

## Related docs

- [Projections Overview](./overview.md) -- the three projection tiers and decision matrix
- [Catch-Up Projections](./catch-up-projections.md) -- catch-up projector API and polling loop
- [Async Projections](./async-projections.md) -- async runner API and transaction modes
