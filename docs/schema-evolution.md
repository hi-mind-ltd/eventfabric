# Schema Evolution

Event logs are append-only. You cannot go back and rewrite historical events when a schema changes. Instead, EventFabric uses **upcasters** -- functions that transform old event shapes into the current shape at read time. This lets you evolve your domain model forward without rewriting the event log or breaking replay.

## Why event schema evolution matters

Over the lifetime of a system, event schemas change:

- A new required field is added (e.g., `region` on `AccountOpened`).
- A field is renamed or restructured.
- An event is split into two, or two events are merged.
- A numeric field changes from cents to a decimal object.

Because the event log is immutable, old events still have the old shape. Without upcasters, every handler, projection, and aggregate would need to handle every historical version of every event -- an ever-growing matrix of conditional logic scattered across the codebase.

Upcasters centralize this translation: old shapes are converted to the current shape once, at load time, before any downstream code sees them.

## EventUpcaster type

```typescript
// @eventfabric/core

export type AnyEvent = { type: string; version: number };

export type EventUpcaster<E extends AnyEvent> = (raw: AnyEvent) => E;
```

An `EventUpcaster<E>` is a pure function that takes a raw event (with at least `type` and `version`) and returns it in the current shape `E`. The upcaster is called by `PgEventStore` on every loaded event after basic shape validation.

**Contract:**

- Events already in the current shape must be returned as-is (the fast path).
- Historical events must be transformed to the current shape.
- The function runs on every load, so the fast path must be cheap.

## Three dispatch styles

There are three common ways to organize upcasters. All three produce an `EventUpcaster<E>` -- the framework only requires the single-function shape. Pick whatever keeps your schema evolution readable as it grows.

### Style A: inline switch

All upcasting logic lives in a single function with a switch or if-chain. Simple and easy to scan, but gets long as the number of versioned events grows.

```typescript
import type { EventUpcaster } from "@eventfabric/core";
import type { BankingEvent } from "./domain/events";
import type { AccountOpenedV1, AccountOpenedV2 } from "./domain/account.events";

export const bankingEventUpcaster: EventUpcaster<BankingEvent> = (raw) => {
  // AccountOpened V1 -> V2: add region field
  if (raw.type === "AccountOpened" && raw.version === 1) {
    const v1 = raw as AccountOpenedV1;
    return {
      type: "AccountOpened",
      version: 2,
      accountId: v1.accountId,
      customerId: v1.customerId,
      initialBalance: v1.initialBalance,
      currency: v1.currency,
      region: "unknown"  // backfill default
    } satisfies AccountOpenedV2 as BankingEvent;
  }

  // Add more (type, version) cases here as the schema evolves.

  // Current-shape events pass through unchanged (fast path).
  return raw as BankingEvent;
};
```

### Style B: dispatch table

A lookup table keyed by `"${type}:v${version}"`. Scales better than a switch chain and makes it easy to see at a glance which events have upcasters.

```typescript
import type { EventUpcaster, AnyEvent } from "@eventfabric/core";
import type { BankingEvent } from "./domain/events";
import type { AccountOpenedV1, AccountOpenedV2 } from "./domain/account.events";

type UpcasterEntry = (raw: AnyEvent) => BankingEvent;

const upcasters: Record<string, UpcasterEntry> = {
  "AccountOpened:v1": (raw) => {
    const v1 = raw as AccountOpenedV1;
    return {
      type: "AccountOpened",
      version: 2,
      accountId: v1.accountId,
      customerId: v1.customerId,
      initialBalance: v1.initialBalance,
      currency: v1.currency,
      region: "unknown"
    };
  }
  // Add more entries as schema evolves:
  // "CustomerRegistered:v1": (raw) => { ... }
};

export const bankingEventUpcaster: EventUpcaster<BankingEvent> = (raw) => {
  const key = `${raw.type}:v${raw.version}`;
  const up = upcasters[key];
  return up ? up(raw) : (raw as BankingEvent);
};
```

### Style C: per-event co-located (the banking-api pattern)

Each event type's upcaster lives next to its event definition, in a dedicated `*.upcasters.ts` file. The top-level upcaster just dispatches to the right per-event function. This is the pattern used in the banking-api example.

```typescript
// domain/account.upcasters.ts

import type { EventUpcaster } from "@eventfabric/core";
import type { BankingEvent } from "./events";
import type { AccountOpenedV1, AccountOpenedV2 } from "./account.events";

/**
 * Per-event upcaster: AccountOpened V1 -> V2.
 * Kept next to the event definitions for discoverability.
 */
function upcastAccountOpenedV1(raw: AccountOpenedV1): AccountOpenedV2 {
  return {
    type: "AccountOpened",
    version: 2,
    accountId: raw.accountId,
    customerId: raw.customerId,
    initialBalance: raw.initialBalance,
    currency: raw.currency,
    region: "unknown"  // V1 predates the region field
  };
}

export const accountEventUpcaster: EventUpcaster<BankingEvent> = (raw) => {
  if (raw.type === "AccountOpened" && raw.version === 1) {
    return upcastAccountOpenedV1(raw as AccountOpenedV1);
  }
  // Current-shape events pass through unchanged (the fast path).
  return raw as BankingEvent;
};
```

As the system grows, you would add `customer.upcasters.ts`, `transaction.upcasters.ts`, etc., and compose them in a top-level upcaster:

```typescript
// domain/upcasters.ts

import type { EventUpcaster } from "@eventfabric/core";
import type { BankingEvent } from "./events";
import { accountEventUpcaster } from "./account.upcasters";
// import { customerEventUpcaster } from "./customer.upcasters";
// import { transactionEventUpcaster } from "./transaction.upcasters";

export const bankingEventUpcaster: EventUpcaster<BankingEvent> = (raw) => {
  // Each per-aggregate upcaster handles its own types and passes through the rest.
  // Order doesn't matter -- each only matches its own (type, version) tuples.
  return accountEventUpcaster(raw);
  // When more aggregates have upcasters, chain them:
  // let event = accountEventUpcaster(raw);
  // event = customerEventUpcaster(event as AnyEvent);
  // return transactionEventUpcaster(event as AnyEvent);
};
```

## Wiring into PgEventStore

The upcaster is passed as the third argument to the `PgEventStore` constructor:

```typescript
import { PgEventStore } from "@eventfabric/postgres";
import type { BankingEvent } from "./domain/events";
import { accountEventUpcaster } from "./domain/account.upcasters";

const store = new PgEventStore<BankingEvent>(
  "eventfabric.events",     // events table
  "eventfabric.outbox",     // outbox table
  accountEventUpcaster      // upcaster (optional)
);
```

The upcaster runs on **every loaded event** -- in `loadStream`, `loadGlobal`, and `loadByGlobalPositions`. Downstream code (aggregates, projections, handlers) always sees events in the current shape.

## Worked example: AccountOpened V1 -> V2

### Step 1: Define the new event version

Add the V2 type alongside V1 in the events file. Keep V1 exported so the upcaster can reference it.

```typescript
// domain/account.events.ts

/** Historical shape. Kept for upcaster reference. */
export type AccountOpenedV1 = {
  type: "AccountOpened";
  version: 1;
  accountId: string;
  customerId: string;
  initialBalance: number;
  currency: string;
};

/** Current shape. Adds region for regulatory tracking. */
export type AccountOpenedV2 = {
  type: "AccountOpened";
  version: 2;
  accountId: string;
  customerId: string;
  initialBalance: number;
  currency: string;
  region: string;           // <-- new field
};
```

### Step 2: Update the event union

The event union models the **current** shapes that downstream code sees. Replace V1 with V2:

```typescript
// The union uses V2, not V1. Historical V1 events are upcast before reaching handlers.
export type AccountEvent =
  | AccountOpenedV2         // was AccountOpenedV1
  | AccountDepositedV1
  | AccountWithdrawnV1
  | AccountClosedV1;
```

### Step 3: Write the upcaster

```typescript
// domain/account.upcasters.ts

function upcastAccountOpenedV1(raw: AccountOpenedV1): AccountOpenedV2 {
  return {
    type: "AccountOpened",
    version: 2,
    accountId: raw.accountId,
    customerId: raw.customerId,
    initialBalance: raw.initialBalance,
    currency: raw.currency,
    region: "unknown"  // backfill: V1 predates the region field
  };
}

export const accountEventUpcaster: EventUpcaster<BankingEvent> = (raw) => {
  if (raw.type === "AccountOpened" && raw.version === 1) {
    return upcastAccountOpenedV1(raw as AccountOpenedV1);
  }
  return raw as BankingEvent;
};
```

### Step 4: Update the aggregate to raise V2

```typescript
// domain/account.aggregate.ts

open(customerId: string, initialBalance: number, currency: string = "USD", region: string = "unknown") {
  this.raise({
    type: "AccountOpened",
    version: 2,              // <-- now raises V2
    accountId: this.id,
    customerId,
    initialBalance,
    currency,
    region                   // <-- new field
  });
}
```

The aggregate handler only sees V2 -- because the upcaster converts V1 to V2 before events reach the handler:

```typescript
protected handlers = {
  AccountOpened: (s, e) => {
    // e is always AccountOpenedV2 -- V1 was upcast
    s.customerId = e.customerId;
    s.balance = e.initialBalance;
    s.currency = e.currency;
    s.region = e.region;      // safe -- always present after upcasting
    s.isClosed = false;
  },
  // ...
};
```

### Step 5: Wire the upcaster

```typescript
const store = new PgEventStore<BankingEvent>(
  "eventfabric.events",
  "eventfabric.outbox",
  accountEventUpcaster
);
```

That's it. Existing V1 events in the database are never rewritten. On every load, the upcaster transforms them to V2 transparently. New events are always written as V2.

## Snapshot upcasters

Snapshots cache aggregate state at a point in time. When the aggregate's state shape changes, old snapshots need upcasting too.

`PgSnapshotStore` supports snapshot upcasters as a separate concept with the same pattern:

```typescript
import { PgSnapshotStore } from "@eventfabric/postgres";
import type { AccountState } from "./domain/account.aggregate";

export type SnapshotUpcaster<S> = (input: unknown) => S;
export type SnapshotUpcasters<S> = { [schemaVersion: number]: SnapshotUpcaster<S> };

const accountSnapshotStore = new PgSnapshotStore<AccountState>(
  "eventfabric.snapshots",
  2,  // current schema version
  {
    // Upcaster for snapshots saved at schema version 1
    1: (raw: unknown) => {
      const old = raw as { customerId?: string; balance: number; currency: string; isClosed: boolean };
      return {
        ...old,
        region: "unknown"  // backfill the new field
      };
    }
  }
);
```

When loading a snapshot, `PgSnapshotStore` compares the stored `snapshot_schema_version` with `currentSchemaVersion`. If they differ, it looks up the upcaster for the stored version and runs it. If no upcaster is found, it throws.

## Design notes

1. **Writes are always current-shape.** The aggregate's `raise()` method always emits the latest version of an event. The event log contains a mix of historical and current shapes, but all new writes are current.

2. **The fast path is cheap.** For events already in the current shape, the upcaster does a type check (`raw.type === ... && raw.version === ...`) and returns immediately. This runs on every load, so the happy path must be near-zero overhead.

3. **Projections see upcast events.** Because the upcaster runs inside `PgEventStore` before returning events, all downstream consumers -- aggregates, inline projections, catch-up projections, async projections -- see events in the current shape. No consumer needs to handle old versions.

4. **Never rewrite the event log.** Upcasting is a read-time transformation. The raw bytes in the database are unchanged. This preserves the audit trail and avoids the risk of data migration bugs corrupting the log.

5. **Version numbers are per-type, not per-stream.** `AccountOpened` has its own version sequence (1, 2, ...) independent of `AccountDeposited`. When you change only one event type, you only need an upcaster for that type.

## Related docs

- [Concurrency Control](./concurrency.md) -- how `expectedAggregateVersion` interacts with event versions
- [Projections Overview](./projections/overview.md) -- all projections see upcast events
- [Inline Projections](./projections/inline-projections.md) -- read models built from current-shape events
