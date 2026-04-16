# Events

Events are the atomic records of things that happened in your domain. In
EventFabric they are plain TypeScript objects, stored as JSONB in
`eventfabric.events`.

## AnyEvent

Every event must satisfy this base type from `@eventfabric/core`:

```typescript
export type AnyEvent = { type: string; version: number };
```

`type` is the event discriminator (e.g. `"AccountDeposited"`). `version` is the
schema version of that event type (e.g. `1`).

## Defining events

### The discriminated union pattern

Define each event variant as its own type alias, then combine them into a union:

```typescript
// domain/account.events.ts

export type AccountOpenedV2 = {
  type: "AccountOpened";
  version: 2;
  accountId: string;
  customerId: string;
  initialBalance: number;
  currency: string;
  region: string;
};

export type AccountDepositedV1 = {
  type: "AccountDeposited";
  version: 1;
  accountId: string;
  amount: number;
  balance: number;
  transactionId?: string;
};

export type AccountWithdrawnV1 = {
  type: "AccountWithdrawn";
  version: 1;
  accountId: string;
  amount: number;
  balance: number;
  transactionId?: string;
};

export type AccountClosedV1 = {
  type: "AccountClosed";
  version: 1;
  accountId: string;
  reason: string;
};

export type AccountEvent =
  | AccountOpenedV2
  | AccountDepositedV1
  | AccountWithdrawnV1
  | AccountClosedV1;
```

The union type is what you pass as the `E` generic to `AggregateRoot`,
`PgEventStore`, `SessionFactory`, and all projection interfaces.

### Naming convention

Follow the pattern **`{AggregateAction}V{N}`** for the type alias:

| Event alias              | `type` field value      | `version` field value |
| ------------------------ | ----------------------- | --------------------- |
| `AccountOpenedV1`        | `"AccountOpened"`       | `1`                   |
| `AccountOpenedV2`        | `"AccountOpened"`       | `2`                   |
| `AccountDepositedV1`     | `"AccountDeposited"`    | `1`                   |
| `CustomerRegisteredV1`   | `"CustomerRegistered"`  | `1`                   |

The type alias name carries the version for developer readability. The `type`
field stays the same across versions so that handlers, projections, and queries
can match on a single string.

### Literal version -- version: 1 not version: number

Always use a **literal number** for the `version` field:

```typescript
// Correct -- literal type
export type AccountDepositedV1 = {
  type: "AccountDeposited";
  version: 1;          // <-- literal 1
  accountId: string;
  amount: number;
  balance: number;
};

// Wrong -- widened type
export type AccountDepositedV1 = {
  type: "AccountDeposited";
  version: number;     // <-- TypeScript cannot distinguish V1 from V2
  accountId: string;
  amount: number;
  balance: number;
};
```

A literal version lets TypeScript narrow the event to the exact variant inside
switch statements and upcasters. It also enables the
`AggregateRoot.validateEvent()` runtime check in development mode.

### Multi-aggregate event union

If your application has multiple aggregates, create a top-level union:

```typescript
// domain/events.ts
import type { AccountEvent } from "./account.events";
import type { TransactionEvent } from "./transaction.events";
import type { CustomerEvent } from "./customer.events";

export type BankingEvent = AccountEvent | TransactionEvent | CustomerEvent;
```

Pass `BankingEvent` to `PgEventStore<BankingEvent>` and
`SessionFactory<BankingEvent>`. Each aggregate still uses its own narrower
union (`AccountEvent`, etc.) for the `AggregateRoot` type parameter.

## defineEvent() helper

The `defineEvent()` helper creates a factory that auto-populates `type` and
`version`:

```typescript
import { defineEvent } from "@eventfabric/core";

const AccountDeposited = defineEvent("AccountDeposited", 1);

// Create an event -- type and version are injected automatically:
const event = AccountDeposited.create<AccountDepositedV1>({
  accountId: "acc-1",
  amount: 250,
  balance: 750,
});
// event.type === "AccountDeposited"
// event.version === 1
```

This is useful in tests and when constructing events outside aggregate command
methods. Inside aggregates you typically construct the event literal directly
in `raise()`.

## EventEnvelope&lt;E&gt;

When events are loaded from the store, they arrive wrapped in an
`EventEnvelope`:

```typescript
export type EventEnvelope<E extends AnyEvent> = {
  eventId: string;            // UUID, assigned by the store on append
  aggregateName: string;      // e.g. "Account"
  aggregateId: string;        // e.g. "acc-1"
  aggregateVersion: number;   // 1, 2, 3, ... within this stream
  globalPosition: bigint;     // Monotonically increasing across all streams
  occurredAt: string;         // ISO-8601 timestamp
  payload: E;                 // The domain event itself
  dismissed?: {               // Present only if the event was soft-deleted
    at: string;
    reason?: string;
    by?: string;
  };
  correlationId?: string;     // Optional tracing correlation ID
  causationId?: string;       // Optional tracing causation ID
};
```

### Field reference

| Field              | Type      | Description                                                                 |
| ------------------ | --------- | --------------------------------------------------------------------------- |
| `eventId`          | `string`  | A `randomUUID()` assigned at append time. Unique across the entire store.  |
| `aggregateName`    | `string`  | The static `aggregateName` of the aggregate class that owns this stream.   |
| `aggregateId`      | `string`  | The identity of the aggregate instance.                                    |
| `aggregateVersion` | `number`  | Sequential version within the stream. Starts at `1`.                       |
| `globalPosition`   | `bigint`  | Auto-incrementing serial across all streams. Used for ordered global reads. |
| `occurredAt`       | `string`  | ISO-8601 timestamp (`TIMESTAMPTZ` in PostgreSQL, default `now()`).         |
| `payload`          | `E`       | The deserialized domain event. After upcasting if an upcaster is configured. |
| `dismissed`        | `object?` | If the event was soft-deleted via `dismiss()`, contains the timestamp, optional reason, and actor. |
| `correlationId`    | `string?` | Optional. Passed through `meta.correlationId` at append time.              |
| `causationId`      | `string?` | Optional. Passed through `meta.causationId` at append time.               |

`globalPosition` is a `bigint` because PostgreSQL `BIGSERIAL` values can exceed
`Number.MAX_SAFE_INTEGER` in high-throughput stores. Always use `BigInt`
comparisons and string serialization when working with it in JavaScript.

### Using envelopes in projections

Projection handlers receive `EventEnvelope<E>`. You typically destructure
`payload` to access domain fields:

```typescript
const depositAudit = forEventType<BankingEvent, "AccountDeposited", PgTx>(
  "deposit-audit",
  "AccountDeposited",
  async (_tx, env) => {
    const { accountId, amount, balance } = env.payload;
    console.log(`deposit: account=${accountId} +${amount} (balance=${balance})`);
  }
);
```

Use `env.globalPosition` for checkpoint tracking and `env.occurredAt` for
time-based logic.

## Versioning and event evolution

Over time your event schemas will change. EventFabric handles this with
**event upcasting** -- a function that transforms old event shapes into the
current shape at read time.

### Historical vs. current event types

Keep the historical type definition exported (for the upcaster to reference) but
exclude it from the aggregate's event union:

```typescript
// Historical -- exported for the upcaster, NOT in the AccountEvent union
export type AccountOpenedV1 = {
  type: "AccountOpened";
  version: 1;
  accountId: string;
  customerId: string;
  initialBalance: number;
  currency: string;
  // V1 did not have "region"
};

// Current -- in the AccountEvent union
export type AccountOpenedV2 = {
  type: "AccountOpened";
  version: 2;
  accountId: string;
  customerId: string;
  initialBalance: number;
  currency: string;
  region: string;        // Added in V2
};

export type AccountEvent =
  | AccountOpenedV2       // <-- V2 only
  | AccountDepositedV1
  | AccountWithdrawnV1
  | AccountClosedV1;
```

### Writing an upcaster

```typescript
import type { EventUpcaster } from "@eventfabric/core";
import type { BankingEvent } from "./events";
import type { AccountOpenedV1, AccountOpenedV2 } from "./account.events";

export const accountEventUpcaster: EventUpcaster<BankingEvent> = (raw) => {
  if (raw.type === "AccountOpened" && raw.version === 1) {
    const v1 = raw as AccountOpenedV1;
    return {
      type: "AccountOpened",
      version: 2,
      accountId: v1.accountId,
      customerId: v1.customerId,
      initialBalance: v1.initialBalance,
      currency: v1.currency,
      region: "unknown",   // Backfill default
    } satisfies AccountOpenedV2;
  }
  // Current-shape events pass through unchanged.
  return raw as BankingEvent;
};
```

Pass the upcaster to `PgEventStore`:

```typescript
const store = new PgEventStore<BankingEvent>(
  "eventfabric.events",
  "eventfabric.outbox",
  accountEventUpcaster
);
```

The upcaster runs on **every** loaded event, so the fast path (current-shape
events that need no transformation) must be cheap. See
[Event Store](./event-store.md) for details on how upcasting integrates with
`mapRow()`.

## Defining an event hierarchy

For a medium-to-large application, organise event files by aggregate:

```
src/domain/
  account.events.ts       # AccountEvent union + all variants
  account.upcasters.ts    # accountEventUpcaster
  customer.events.ts      # CustomerEvent union
  transaction.events.ts   # TransactionEvent union
  events.ts               # Top-level BankingEvent = AccountEvent | CustomerEvent | ...
```

Each aggregate file exports its union and all variant types. The top-level
`events.ts` re-exports the combined union. Upcasters are kept next to their
event definitions so schema evolution is easy to review.

## Related documentation

- [Aggregates](./aggregates.md) -- How aggregates use events via `raise()` and `HandlerMap`
- [Event Store](./event-store.md) -- Persistence, loading, and upcasting
- [Sessions](./sessions.md) -- `startStream()` and `saveChangesAsync()` for appending events
- [Core Concepts](./core-concepts.md) -- Events as source of truth
