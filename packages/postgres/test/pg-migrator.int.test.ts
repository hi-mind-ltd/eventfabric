import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "../src/pg-migrator";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { PgSnapshotStore } from "../src/snapshots/pg-snapshot-store";
import { PgProjectionCheckpointStore } from "../src/projections/pg-projection-checkpoint-store";
import { PgPartitionManager } from "../src/partitioning/pg-partition-manager";

type E = { type: "Tick"; version: 1; n: number };

describe("migrate() — fresh database", () => {
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it("applies all core migrations on a fresh database", async () => {
    const result = await migrate(pool);

    expect(result.applied).toEqual([
      "001_init",
      "002_projection_checkpoints",
      "003_outbox_and_dlq",
      "004_snapshots",
      "005_stream_versions",
      "006_performance",
      "008_tenant_id",
      "009_per_tenant_projection_checkpoints",
    ]);
    expect(result.partitioned).toBe(false);
  });

  it("is idempotent — second call applies nothing", async () => {
    const result = await migrate(pool);
    expect(result.applied).toEqual([]);
    expect(result.partitioned).toBe(false);
  });

  it("all tables exist and are usable", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    const { appended } = await uow.withTransaction(async (tx) => {
      return store.append(tx, {
        aggregateName: "Migrator",
        aggregateId: "m-1",
        expectedAggregateVersion: 0,
        events: [{ type: "Tick", version: 1, n: 42 }],
        enqueueOutbox: true,
      });
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]!.payload.n).toBe(42);

    const events = await uow.withTransaction(async (tx) => {
      return store.loadStream(tx, { aggregateName: "Migrator", aggregateId: "m-1" });
    });
    expect(events).toHaveLength(1);
  });

  it("enables partitioning on subsequent call", async () => {
    const result = await migrate(pool, {
      partitioning: { enabled: true, partitionSize: 100n },
    });

    expect(result.applied).toEqual(["007_partitioning"]);
    expect(result.partitioned).toBe(true);

    const manager = new PgPartitionManager();
    const partitions = await manager.listPartitions(pool);
    expect(partitions.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves data after partitioning", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    const events = await uow.withTransaction(async (tx) => {
      return store.loadStream(tx, { aggregateName: "Migrator", aggregateId: "m-1" });
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.n).toBe(42);
  });

  it("new writes work after partitioning", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    await uow.withTransaction(async (tx) => {
      await store.append(tx, {
        aggregateName: "Migrator",
        aggregateId: "m-2",
        expectedAggregateVersion: 0,
        events: [{ type: "Tick", version: 1, n: 99 }],
      });
    });

    const events = await uow.withTransaction(async (tx) => {
      return store.loadStream(tx, { aggregateName: "Migrator", aggregateId: "m-2" });
    });
    expect(events).toHaveLength(1);
  });

  it("is fully idempotent after partitioning", async () => {
    const result = await migrate(pool, {
      partitioning: { enabled: true, partitionSize: 100n },
    });
    expect(result.applied).toEqual([]);
    expect(result.partitioned).toBe(true);
  });
});

describe("migrate() — partitioning from scratch", () => {
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it("applies all migrations including partitioning in one call", async () => {
    const result = await migrate(pool, {
      partitioning: { enabled: true, partitionSize: 1000n },
    });

    expect(result.applied).toEqual([
      "001_init",
      "002_projection_checkpoints",
      "003_outbox_and_dlq",
      "004_snapshots",
      "005_stream_versions",
      "006_performance",
      "008_tenant_id",
      "009_per_tenant_projection_checkpoints",
      "007_partitioning",
    ]);
    expect(result.partitioned).toBe(true);
  });

  it("inserts and reads work on a freshly partitioned database", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    await uow.withTransaction(async (tx) => {
      await store.append(tx, {
        aggregateName: "Fresh",
        aggregateId: "f-1",
        expectedAggregateVersion: 0,
        events: [
          { type: "Tick", version: 1, n: 1 },
          { type: "Tick", version: 1, n: 2 },
        ],
      });
    });

    const events = await uow.withTransaction(async (tx) => {
      return store.loadStream(tx, { aggregateName: "Fresh", aggregateId: "f-1" });
    });
    expect(events).toHaveLength(2);
  });
});

describe("migrate() — data integrity across all tables", () => {
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let pool: Pool;

  // Snapshot of data seeded before partitioning migration
  const STREAM_COUNT = 10;
  const EVENTS_PER_STREAM = 5;
  const TOTAL_EVENTS = STREAM_COUNT * EVENTS_PER_STREAM;
  let snapshotsBefore: {
    events: any[];
    streamVersions: any[];
    outboxCount: number;
    checkpoints: any[];
    snapshots: any[];
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it("step 1: apply core migrations and seed data across all tables", async () => {
    await migrate(pool);

    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();
    const snapshots = new PgSnapshotStore<{ n: number }>();
    const checkpoints = new PgProjectionCheckpointStore();

    // Seed events + outbox rows across multiple streams
    for (let i = 0; i < STREAM_COUNT; i++) {
      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Integrity",
          aggregateId: `int-${i}`,
          expectedAggregateVersion: 0,
          events: Array.from({ length: EVENTS_PER_STREAM }, (_, j) => ({
            type: "Tick" as const,
            version: 1 as const,
            n: i * EVENTS_PER_STREAM + j,
          })),
          enqueueOutbox: true,
        });
      });
    }

    // Seed snapshots for a few aggregates
    for (let i = 0; i < 3; i++) {
      await uow.withTransaction(async (tx) => {
        await snapshots.save(tx, {
          aggregateName: "Integrity",
          aggregateId: `int-${i}`,
          aggregateVersion: EVENTS_PER_STREAM,
          createdAt: new Date().toISOString(),
          snapshotSchemaVersion: 1,
          state: { n: i * 100 },
        });
      });
    }

    // Seed projection checkpoints
    await uow.withTransaction(async (tx) => {
      await checkpoints.set(tx, "test-projection-a", "default", BigInt(TOTAL_EVENTS - 10));
      await checkpoints.set(tx, "test-projection-b", "default", BigInt(TOTAL_EVENTS));
    });

    // Verify counts
    const eventCount = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.events`);
    expect(eventCount.rows[0].c).toBe(TOTAL_EVENTS);

    const outboxCount = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox`);
    expect(outboxCount.rows[0].c).toBe(TOTAL_EVENTS);

    const svCount = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.stream_versions`);
    expect(svCount.rows[0].c).toBe(STREAM_COUNT);

    const snapCount = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.snapshots`);
    expect(snapCount.rows[0].c).toBe(3);

    const cpCount = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.projection_checkpoints`);
    expect(cpCount.rows[0].c).toBe(2);
  });

  it("step 2: capture a full snapshot of all data before partitioning", async () => {
    const events = await pool.query(
      `SELECT global_position, event_id, aggregate_name, aggregate_id,
              aggregate_version, type, payload, correlation_id
       FROM eventfabric.events ORDER BY global_position`
    );
    const streamVersions = await pool.query(
      `SELECT aggregate_name, aggregate_id, current_version
       FROM eventfabric.stream_versions ORDER BY aggregate_name, aggregate_id`
    );
    const outboxCount = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox`);
    const checkpoints = await pool.query(
      `SELECT projection_name, last_global_position
       FROM eventfabric.projection_checkpoints ORDER BY projection_name`
    );
    const snapshotsRes = await pool.query(
      `SELECT aggregate_name, aggregate_id, aggregate_version, state
       FROM eventfabric.snapshots ORDER BY aggregate_name, aggregate_id`
    );

    snapshotsBefore = {
      events: events.rows,
      streamVersions: streamVersions.rows,
      outboxCount: outboxCount.rows[0].c,
      checkpoints: checkpoints.rows,
      snapshots: snapshotsRes.rows,
    };

    expect(snapshotsBefore.events).toHaveLength(TOTAL_EVENTS);
    expect(snapshotsBefore.streamVersions).toHaveLength(STREAM_COUNT);
    expect(snapshotsBefore.snapshots).toHaveLength(3);
    expect(snapshotsBefore.checkpoints).toHaveLength(2);
  });

  it("step 3: enable partitioning and verify zero data loss", async () => {
    const result = await migrate(pool, {
      partitioning: { enabled: true, partitionSize: 100n },
    });

    expect(result.applied).toEqual(["007_partitioning"]);
    expect(result.partitioned).toBe(true);

    // ---- EVENTS: every row must match exactly ----
    const eventsAfter = await pool.query(
      `SELECT global_position, event_id, aggregate_name, aggregate_id,
              aggregate_version, type, payload, correlation_id
       FROM eventfabric.events ORDER BY global_position`
    );
    expect(eventsAfter.rows).toHaveLength(snapshotsBefore.events.length);

    for (let i = 0; i < snapshotsBefore.events.length; i++) {
      const before = snapshotsBefore.events[i];
      const after = eventsAfter.rows[i];
      expect(after.event_id).toBe(before.event_id);
      expect(after.aggregate_name).toBe(before.aggregate_name);
      expect(after.aggregate_id).toBe(before.aggregate_id);
      expect(Number(after.aggregate_version)).toBe(Number(before.aggregate_version));
      expect(String(after.global_position)).toBe(String(before.global_position));
      expect(after.type).toBe(before.type);
      expect(after.payload).toEqual(before.payload);
    }

    // ---- STREAM VERSIONS: unchanged (separate table) ----
    const svAfter = await pool.query(
      `SELECT aggregate_name, aggregate_id, current_version
       FROM eventfabric.stream_versions ORDER BY aggregate_name, aggregate_id`
    );
    expect(svAfter.rows).toEqual(snapshotsBefore.streamVersions);

    // ---- OUTBOX: unchanged (separate table) ----
    const outboxAfter = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox`);
    expect(outboxAfter.rows[0].c).toBe(snapshotsBefore.outboxCount);

    // ---- PROJECTION CHECKPOINTS: unchanged ----
    const cpAfter = await pool.query(
      `SELECT projection_name, last_global_position
       FROM eventfabric.projection_checkpoints ORDER BY projection_name`
    );
    expect(cpAfter.rows).toHaveLength(snapshotsBefore.checkpoints.length);
    for (let i = 0; i < snapshotsBefore.checkpoints.length; i++) {
      expect(cpAfter.rows[i].projection_name).toBe(snapshotsBefore.checkpoints[i].projection_name);
      expect(String(cpAfter.rows[i].last_global_position)).toBe(
        String(snapshotsBefore.checkpoints[i].last_global_position)
      );
    }

    // ---- SNAPSHOTS: unchanged ----
    const snapshotsAfter = await pool.query(
      `SELECT aggregate_name, aggregate_id, aggregate_version, state
       FROM eventfabric.snapshots ORDER BY aggregate_name, aggregate_id`
    );
    expect(snapshotsAfter.rows).toEqual(snapshotsBefore.snapshots);
  });

  it("step 4: loadStream returns correct data through the event store API", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    for (let i = 0; i < STREAM_COUNT; i++) {
      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "Integrity", aggregateId: `int-${i}` });
      });
      expect(events).toHaveLength(EVENTS_PER_STREAM);
      expect(events[0]!.aggregateVersion).toBe(1);
      expect(events[EVENTS_PER_STREAM - 1]!.aggregateVersion).toBe(EVENTS_PER_STREAM);

      // Verify payload values
      for (let j = 0; j < EVENTS_PER_STREAM; j++) {
        expect(events[j]!.payload.n).toBe(i * EVENTS_PER_STREAM + j);
      }
    }
  });

  it("step 5: loadGlobal returns all events in order", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    const all = await uow.withTransaction(async (tx) => {
      return store.loadGlobal(tx, { fromGlobalPositionExclusive: 0n, limit: 1000 });
    });

    expect(all).toHaveLength(TOTAL_EVENTS);

    // Global positions must be monotonically increasing
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.globalPosition).toBeGreaterThan(all[i - 1]!.globalPosition);
    }
  });

  it("step 6: concurrency control still works after partitioning", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    // Append to an existing stream
    await uow.withTransaction(async (tx) => {
      await store.append(tx, {
        aggregateName: "Integrity",
        aggregateId: "int-0",
        expectedAggregateVersion: EVENTS_PER_STREAM,
        events: [{ type: "Tick", version: 1, n: 999 }],
      });
    });

    // Stale version should throw ConcurrencyError
    await expect(
      uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Integrity",
          aggregateId: "int-0",
          expectedAggregateVersion: EVENTS_PER_STREAM,
          events: [{ type: "Tick", version: 1, n: 1000 }],
        });
      })
    ).rejects.toThrow("Expected version");
  });

  it("step 7: sequence continues correctly for new writes", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    const { appended } = await uow.withTransaction(async (tx) => {
      return store.append(tx, {
        aggregateName: "Integrity",
        aggregateId: "new-after-partition",
        expectedAggregateVersion: 0,
        events: [{ type: "Tick", version: 1, n: 777 }],
      });
    });

    // New global_position must be higher than all seeded events
    expect(appended[0]!.globalPosition).toBeGreaterThan(BigInt(TOTAL_EVENTS));
  });
});
