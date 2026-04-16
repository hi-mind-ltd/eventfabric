# Partitioning

> **Warning**: Enabling partitioning is a **one-way operation**. Once enabled, it
> cannot be disabled or reverted. All existing data is preserved and the
> application layer is unaffected, but the table structure change is permanent.
> See [Why partitioning cannot be disabled](#why-partitioning-cannot-be-disabled)
> for details.

EventFabric supports **range partitioning** of the `eventfabric.events` table by
`global_position`. Partitioning is optional and designed for large-scale
deployments where the events table grows into the tens of millions of rows.

## Why partition?

| Benefit | Explanation |
|---------|-------------|
| **Archival** | Detach old partitions and move them to cold storage or drop them entirely. No `DELETE` needed — partition detach is instant. |
| **Vacuum performance** | Each partition is vacuumed independently. A 100M-row table vacuums much faster as ten 10M-row partitions. |
| **Partition pruning** | Queries that filter by `global_position` (e.g. `loadGlobal`) only scan relevant partitions. |
| **Parallel query** | PostgreSQL can scan multiple partitions concurrently. |

## Prerequisites

If you use the `migrate()` function (recommended), prerequisites are handled
automatically. Otherwise, apply these migrations manually in order:

```bash
psql "$DATABASE_URL" -f packages/postgres/migrations/005_stream_versions.sql
psql "$DATABASE_URL" -f packages/postgres/migrations/006_performance.sql
psql "$DATABASE_URL" -f packages/postgres/migrations/007_partitioning.sql
```

## How concurrency stays safe without the UNIQUE constraint

Migration 007 drops two constraints from `eventfabric.events`:

- `UNIQUE (aggregate_name, aggregate_id, aggregate_version)`
- `UNIQUE (event_id)`

This is safe because **neither constraint is the concurrency mechanism**.

Since migration 005, the `eventfabric.stream_versions` table is the concurrency
gatekeeper. Every `append()` call goes through an **atomic version check** on
this table _before_ any events are inserted:

```
┌──────────────────────────────────────────────────────────────┐
│  stream_versions                                              │
│                                                               │
│  New stream (version 0):                                      │
│    INSERT INTO stream_versions (name, id, current_version)    │
│    → PK violation = ConcurrencyError("stream already exists") │
│                                                               │
│  Existing stream:                                             │
│    UPDATE stream_versions                                     │
│    SET current_version = new_version                          │
│    WHERE name = $1 AND id = $2 AND current_version = expected │
│    → 0 rows updated = ConcurrencyError("version mismatch")   │
│                                                               │
│  Only if the gate passes → INSERT INTO events                 │
│  All within the same transaction.                             │
└──────────────────────────────────────────────────────────────┘
```

This pattern is used by Marten DB (`mt_streams`), SQLStreamStore (`Streams`),
and EventStoreDB (internal stream metadata). It is **stronger** than the
old UNIQUE constraint approach:

| | Old approach (UNIQUE constraint) | New approach (stream_versions) |
|---|---|---|
| **Mechanism** | INSERT events → hope UNIQUE catches duplicates | Atomic UPDATE on stream_versions → then INSERT events |
| **Race window** | TOCTOU gap between SELECT MAX and INSERT | None — single UPDATE is atomic |
| **Partitioning** | Blocked (UNIQUE must include partition key) | Enabled (stream_versions is separate) |
| **Error detection** | Reactive (constraint violation after the fact) | Proactive (gate checked before insert) |

The `event_id` UNIQUE constraint is also safe to drop — event IDs are generated
by `crypto.randomUUID()`, and UUID v4 collisions are astronomically unlikely
(1 in 2^122).

## Enabling partitioning

### Option A: `migrate()` (recommended)

The `migrate()` function handles all migrations and partitioning in one call.
Safe to run on every app startup — already-applied steps are skipped.

```typescript
import { Pool } from "pg";
import { migrate } from "@eventfabric/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Without partitioning — applies migrations 001-006
await migrate(pool);

// With partitioning — also applies 007 and converts the table
await migrate(pool, {
  partitioning: { enabled: true, partitionSize: 1_000_000n }
});
```

The banking-api example runs this on startup:

```typescript
async function start() {
  const result = await migrate(pool);
  if (result.applied.length > 0) {
    console.log(`Applied migrations: ${result.applied.join(", ")}`);
  }
  app.listen(PORT);
}
```

To enable partitioning later without code changes, the banking-api also
exposes an ops endpoint:

```bash
# Check current state
curl http://localhost:3001/ops/partitions

# Enable partitioning (one-time)
curl -X POST http://localhost:3001/ops/partitions/enable \
  -H "Content-Type: application/json" \
  -d '{ "partitionSize": "1000000" }'
```

### Option B: `PgPartitionManager` directly

```typescript
import { PgPartitionManager } from "@eventfabric/postgres";

const manager = new PgPartitionManager();
await manager.enablePartitioning(pool, { partitionSize: 1_000_000n });
```

This assumes migrations 005-007 have already been applied.

### What happens during conversion

`enablePartitioning()` takes an `ACCESS EXCLUSIVE` lock and performs these
steps atomically:

1. Renames `eventfabric.events` → `eventfabric.events_p0`
2. Creates a new `eventfabric.events` as `PARTITION BY RANGE (global_position)`
3. Attaches the old table as the first partition (`events_p0`)
4. Creates the next empty partition (`events_p1`) for new writes
5. Re-creates indexes on the parent (automatically propagated to all partitions)
6. Reassigns the `BIGSERIAL` sequence to the new parent table

The operation is **idempotent** — calling it again after conversion is a no-op.

**Downtime**: The lock duration depends on the number of existing rows, because
PostgreSQL validates that all rows in `events_p0` fall within the partition
bounds. For typical tables (< 10M rows), this takes seconds. For very large
tables, consider running during a maintenance window.

## Managing partitions

### Listing partitions

```typescript
const partitions = await manager.listPartitions(pool);
// [
//   { name: "events_p0", from: 0n, to: 1000000n, rowEstimate: 842000 },
//   { name: "events_p1", from: 1000000n, to: 2000000n, rowEstimate: 156000 }
// ]
```

### Creating new partitions

Create partitions **before** the current one fills up. If an INSERT targets a
range with no partition, PostgreSQL throws an error.

```typescript
// Check where writes are landing
const currentPos = await manager.getCurrentPosition(pool);
// → 1_850_000n (approaching the end of events_p1)

// Create the next partition
await manager.createPartition(pool, 2_000_000n, 3_000_000n);
```

**Automation tip**: Run a periodic job that checks `getCurrentPosition()` and
creates the next partition when the current one is 80% full:

```typescript
async function ensurePartitionHeadroom(pool: Pool) {
  const manager = new PgPartitionManager();
  const partitions = await manager.listPartitions(pool);
  const current = partitions[partitions.length - 1];
  if (!current) return;

  const pos = await manager.getCurrentPosition(pool);
  const usage = Number(pos - current.from) / Number(current.to - current.from);

  if (usage > 0.8) {
    const size = current.to - current.from;
    await manager.createPartition(pool, current.to, current.to + size);
  }
}
```

### Archiving old partitions

Detaching a partition removes it from the parent table but keeps it as a
standalone table. You can then back it up, move it to another tablespace, or
drop it.

```typescript
// Detach the oldest partition
await manager.detachPartition(pool, "events_p0");

// The table still exists — back it up or drop it
// pg_dump -t eventfabric.events_p0 > events_p0_backup.sql
// DROP TABLE eventfabric.events_p0;
```

**Warning**: Detaching a partition makes its events invisible to `loadGlobal()`
and catch-up projections. Only detach partitions whose events are no longer
needed for projection catch-up. Check your projection checkpoints first:

```sql
SELECT projection_name, last_global_position
FROM eventfabric.projection_checkpoints;
```

If any projection's checkpoint falls within the partition's range, that
projection will miss events after detach.

## Partition sizing guidelines

| Events/day | Recommended partition size | Partitions/year |
|------------|---------------------------|-----------------|
| < 10,000   | 1,000,000 (default)       | ~4              |
| 10,000 - 100,000 | 1,000,000          | ~36             |
| 100,000 - 1,000,000 | 5,000,000       | ~73             |
| > 1,000,000 | 10,000,000              | ~36             |

Aim for partitions that contain **1-4 weeks of data**. Too many small partitions
add planning overhead; too few large partitions reduce the benefits.

## Query behavior with partitioning

All existing queries work transparently — PostgreSQL routes reads and writes
to the correct partition automatically.

| Query | Partition behavior |
|-------|-------------------|
| `append()` | Inserts routed to the partition covering the new `global_position` |
| `loadStream()` | Scans all partitions (stream events may span multiple). The covering index on each partition keeps this fast. |
| `loadGlobal()` | Partition pruning — only scans partitions that could contain `global_position > checkpoint` |
| `loadByGlobalPositions()` | Partition pruning on `IN (...)` list |
| Catch-up projections | Benefit from pruning (reads forward from checkpoint) |
| Async projections | Read from `outbox` table (not partitioned), then `loadByGlobalPositions` with pruning |

## Zero code changes required

The `PgEventStore`, `Session`, and all projection runners work identically with
partitioned and non-partitioned tables. Partitioning is purely a storage-layer
optimization — enable it when you need it, with no application changes.

## PgPartitionManager API reference

```typescript
import { PgPartitionManager } from "@eventfabric/postgres";

const manager = new PgPartitionManager(
  schema?,         // Default: "eventfabric"
  table?           // Default: "events"
);

// One-time conversion to partitioned table
await manager.enablePartitioning(pool, { partitionSize?: bigint });

// Create a new partition for a global_position range
await manager.createPartition(pool, from: bigint, to: bigint): string;

// Detach a partition (becomes standalone table)
await manager.detachPartition(pool, partitionName: string): void;

// List all current partitions
await manager.listPartitions(pool): PartitionInfo[];

// Check if the table is currently partitioned
await manager.isPartitioned(pool): boolean;

// Get the current max global_position
await manager.getCurrentPosition(pool): bigint;
```

## Why partitioning cannot be disabled

Enabling partitioning is a **one-way operation**. There is no `disablePartitioning()`
method and no migration to reverse it. This is intentional:

1. **Structural change**: PostgreSQL has no `ALTER TABLE ... UNPARTITION`. Reverting
   requires creating a new regular table, copying all data from every partition,
   dropping the partitioned table, and renaming. For a table with millions of rows
   this is a significant operation that risks data loss if interrupted.

2. **Constraint restoration**: Migration 007 drops the UNIQUE constraints that
   the `stream_versions` table superseded. These constraints were defense-in-depth
   only — restoring them adds no safety but would require a full table scan to
   validate.

3. **No practical reason**: Partitioning is transparent to the application layer.
   All queries, projections, and the event store work identically. If partitions
   are too small, create larger ones going forward. If you no longer need archival,
   simply stop detaching partitions.

If you genuinely need to revert (e.g. moving to a different database engine),
export the data with `pg_dump` and import into a fresh schema using migrations
001-006 only.

## Related docs

- [Concurrency](./concurrency.md) — how stream_versions ensures consistency without UNIQUE constraints
- [Schema Reference](./schema-reference.md) — full table and index definitions
- [Event Store](./event-store.md) — `PgEventStore` API
- [Getting Started](./getting-started.md) — running migrations
