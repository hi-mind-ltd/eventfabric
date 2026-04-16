# Snapshots

When an aggregate's event stream grows long, replaying every event on each load
becomes expensive. Snapshots cache the aggregate state at a specific version so
subsequent loads can skip the replayed prefix and only process events after the
snapshot.

## When to snapshot

**Do snapshot** when:

- The aggregate has hundreds or thousands of events and load latency matters.
- The aggregate is read frequently relative to how often it is written.
- You have measured that event replay is a bottleneck (not assumed).

**Do not snapshot** when:

- The aggregate stream is short (under ~100 events). Replaying 50-100 small
  JSONB rows is typically sub-millisecond.
- The aggregate is write-heavy but rarely read. Snapshots add write overhead
  with no read benefit.
- You are still iterating on the aggregate's state shape. Every state change
  requires a snapshot upcaster or a snapshot rebuild.
- You want a simpler operational model. Snapshots are a performance
  optimisation, not a correctness requirement. You can always add them later.

## PgSnapshotStore&lt;S&gt;

```typescript
import { PgSnapshotStore } from "@eventfabric/postgres";
```

### Constructor

```typescript
const snapshotStore = new PgSnapshotStore<AccountState>(
  tableName?,              // default: "eventfabric.snapshots"
  currentSchemaVersion?,   // default: 1
  upcasters?               // default: {}
);
```

| Parameter              | Type                      | Default                    | Description                                           |
| ---------------------- | ------------------------- | -------------------------- | ----------------------------------------------------- |
| `tableName`            | `string`                  | `"eventfabric.snapshots"`  | Schema-qualified table name.                          |
| `currentSchemaVersion` | `number`                  | `1`                        | The schema version of the current state type `S`.     |
| `upcasters`            | `SnapshotUpcasters<S>`    | `{}`                       | Map from old schema versions to transform functions.  |

### Snapshot type

```typescript
export type Snapshot<S> = {
  aggregateName: string;       // e.g. "Account"
  aggregateId: string;         // e.g. "acc-1"
  aggregateVersion: number;    // The stream version at snapshot time
  createdAt: string;           // ISO-8601 timestamp
  snapshotSchemaVersion: number; // Schema version of the serialized state
  state: S;                    // The aggregate state, stored as JSONB
};
```

### save()

```typescript
await snapshotStore.save(tx, {
  aggregateName: "Account",
  aggregateId: "acc-1",
  aggregateVersion: 100,
  createdAt: new Date().toISOString(),
  snapshotSchemaVersion: 1,
  state: account.state,
});
```

Inserts or replaces the snapshot for the given `(aggregate_name, aggregate_id)`
pair. The upsert uses a **version gate** to prevent an older snapshot from
overwriting a newer one:

```sql
INSERT INTO eventfabric.snapshots
  (aggregate_name, aggregate_id, aggregate_version, created_at, snapshot_schema_version, state)
VALUES ($1, $2, $3, $4::timestamptz, $5, $6::jsonb)
ON CONFLICT (aggregate_name, aggregate_id)
DO UPDATE SET
  aggregate_version = EXCLUDED.aggregate_version,
  created_at = EXCLUDED.created_at,
  snapshot_schema_version = EXCLUDED.snapshot_schema_version,
  state = EXCLUDED.state
WHERE eventfabric.snapshots.aggregate_version <= EXCLUDED.aggregate_version
```

The `WHERE` clause on the `DO UPDATE` ensures that if two concurrent
transactions try to save a snapshot, only the one with the higher (or equal)
`aggregate_version` wins. A stale snapshot is silently discarded.

### load()

```typescript
const snap = await snapshotStore.load(tx, "Account", "acc-1");
// snap is Snapshot<AccountState> | null
```

Returns the latest snapshot for the aggregate, or `null` if none exists. If the
stored `snapshot_schema_version` differs from `currentSchemaVersion`, the
snapshot state is transformed through the registered upcaster before being
returned.

## Snapshot policies

A snapshot policy controls when the session (or repository) automatically saves
a snapshot after appending events:

```typescript
export type SnapshotPolicy = { everyNEvents: number };
```

When `aggregateVersion % everyNEvents === 0`, the session saves a snapshot
inside the same transaction as the event append.

Example: with `{ everyNEvents: 50 }`, snapshots are taken at versions 50, 100,
150, and so on.

### Choosing a policy value

- `everyNEvents: 50` is a reasonable default. For most aggregates with small
  events this keeps replay under 50 rows.
- Lower values (e.g. `20`) reduce replay time at the cost of more snapshot
  writes.
- Set `everyNEvents: 0` to disable automatic snapshotting even when a snapshot
  store is registered.

## Snapshot upcasters

When the aggregate's state type changes, existing snapshots in the database
have the old shape. Rather than rebuilding all snapshots, you can register
upcasters that transform old snapshots on load:

```typescript
import type { SnapshotUpcasters } from "@eventfabric/postgres";

type AccountStateV1 = {
  customerId?: string;
  balance: number;
  currency: string;
  isClosed: boolean;
};

// Current state adds "region"
type AccountStateV2 = AccountStateV1 & { region?: string };

const snapshotUpcasters: SnapshotUpcasters<AccountStateV2> = {
  // Schema version 1 -> current
  1: (raw: unknown) => {
    const v1 = raw as AccountStateV1;
    return {
      ...v1,
      region: "unknown", // backfill default
    };
  },
};

const snapshotStore = new PgSnapshotStore<AccountStateV2>(
  "eventfabric.snapshots",
  2,                    // current schema version is now 2
  snapshotUpcasters
);
```

The `SnapshotUpcasters<S>` type is a record keyed by old schema version number:

```typescript
export type SnapshotUpcaster<S> = (input: unknown) => S;
export type SnapshotUpcasters<S> = { [schemaVersion: number]: SnapshotUpcaster<S> };
```

When `load()` reads a snapshot whose `snapshot_schema_version` matches
`currentSchemaVersion`, the state is returned as-is (fast path). When the
versions differ, the upcaster for the stored version is called. If no upcaster
is registered for that version, `load()` throws.

### Versioning workflow

1. Change the aggregate state type.
2. Bump `currentSchemaVersion` in the `PgSnapshotStore` constructor.
3. Add an upcaster entry for the previous version.
4. New snapshots are written with the new schema version.
5. Old snapshots are upcast on load until they are naturally replaced.

## Registering snapshots via SessionFactory

Pass the snapshot store, policy, and schema version to `registerAggregate()`:

```typescript
const snapshotStore = new PgSnapshotStore<AccountState>(
  "eventfabric.snapshots",
  1
);

factory.registerAggregate(
  AccountAggregate,
  [
    "AccountOpened",
    "AccountDeposited",
    "AccountWithdrawn",
    "WithdrawalCompleted",
    "DepositCompleted",
    "AccountTransferredOut",
    "AccountTransferredIn",
    "AccountClosed",
  ],
  snapshotStore,               // optional snapshot store
  { everyNEvents: 50 },        // optional snapshot policy
  1                             // optional schema version (default 1)
);
```

Once registered, `session.loadAggregateAsync<T>(id)` automatically loads the
snapshot (if available) before replaying remaining events. And
`session.saveChangesAsync()` automatically saves a snapshot when the policy
condition is met.

## Complete example

```typescript
import { Pool } from "pg";
import { PgEventStore, PgSnapshotStore, SessionFactory } from "@eventfabric/postgres";
import { AccountAggregate, type AccountState } from "./domain/account.aggregate";
import type { BankingEvent } from "./domain/events";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PgEventStore<BankingEvent>();

// Snapshot store: table, current schema version, optional upcasters
const snapshotStore = new PgSnapshotStore<AccountState>(
  "eventfabric.snapshots",
  1,
  {} // no upcasters needed yet
);

const factory = new SessionFactory<BankingEvent>(pool, store);
factory.registerAggregate(
  AccountAggregate,
  [
    "AccountOpened",
    "AccountDeposited",
    "AccountWithdrawn",
    "WithdrawalCompleted",
    "DepositCompleted",
    "AccountTransferredOut",
    "AccountTransferredIn",
    "AccountClosed",
  ],
  snapshotStore,
  { everyNEvents: 50 }
);

// Usage -- snapshots are transparent to the caller:
const session = factory.createSession();
const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
// If a snapshot exists at version 100, only events 101+ are replayed.
account.deposit(250);
await session.saveChangesAsync();
// If the new version is a multiple of 50, a snapshot is saved automatically.
```

## Related documentation

- [Sessions](./sessions.md) -- `registerAggregate()` and `saveChangesAsync()` snapshot integration
- [Aggregates](./aggregates.md) -- `AggregateRoot`, state types, handlers
- [Schema Reference](./schema-reference.md) -- `eventfabric.snapshots` table definition
- [Event Store](./event-store.md) -- Lower-level store API
