import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { PgPartitionManager } from "../src/partitioning/pg-partition-manager";

type E = { type: "Tick"; version: 1; n: number };

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS eventfabric;

    CREATE TABLE IF NOT EXISTS eventfabric.stream_versions (
      aggregate_name TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      current_version INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (aggregate_name, aggregate_id)
    );

    CREATE TABLE IF NOT EXISTS eventfabric.events (
      global_position BIGSERIAL PRIMARY KEY,
      event_id UUID NOT NULL,
      aggregate_name TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INT NOT NULL,
      type TEXT NOT NULL,
      version INT NOT NULL,
      payload JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dismissed_at TIMESTAMPTZ NULL,
      dismissed_reason TEXT NULL,
      dismissed_by TEXT NULL,
      correlation_id TEXT NULL,
      causation_id TEXT NULL
    );
    CREATE INDEX IF NOT EXISTS events_global_idx ON eventfabric.events (global_position);

    CREATE TABLE IF NOT EXISTS eventfabric.outbox (
      id BIGSERIAL PRIMARY KEY,
      global_position BIGINT NOT NULL UNIQUE,
      topic TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_at TIMESTAMPTZ NULL,
      locked_by TEXT NULL,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      dead_lettered_at TIMESTAMPTZ NULL,
      dead_letter_reason TEXT NULL
    );
  `);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate();
}, 120000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

describe("PgPartitionManager", () => {
  const manager = new PgPartitionManager();
  const store = new PgEventStore<E>();
  const uow = () => new PgUnitOfWork(pool);

  it("reports table as not partitioned before enablePartitioning", async () => {
    expect(await manager.isPartitioned(pool)).toBe(false);
  });

  it("enables partitioning on an empty table", async () => {
    await manager.enablePartitioning(pool, { partitionSize: 100n });

    expect(await manager.isPartitioned(pool)).toBe(true);

    const partitions = await manager.listPartitions(pool);
    expect(partitions).toHaveLength(2);
    expect(partitions[0]!.name).toBe("events_p0");
    expect(partitions[1]!.name).toBe("events_p1");
    expect(partitions[1]!.from).toBe(100n);
    expect(partitions[1]!.to).toBe(200n);
  });

  it("is idempotent — second call is a no-op", async () => {
    await manager.enablePartitioning(pool, { partitionSize: 100n });
    expect(await manager.isPartitioned(pool)).toBe(true);
  });

  it("inserts into the partitioned table transparently", async () => {
    const result = await uow().withTransaction(async (tx) => {
      return store.append(tx, {
        aggregateName: "Part",
        aggregateId: "p-1",
        expectedAggregateVersion: 0,
        events: [{ type: "Tick", version: 1, n: 1 }]
      });
    });

    expect(result.appended).toHaveLength(1);
    expect(result.appended[0]!.globalPosition).toBeGreaterThan(0n);
  });

  it("loadStream works across partitioned table", async () => {
    const events = await uow().withTransaction(async (tx) => {
      return store.loadStream(tx, { aggregateName: "Part", aggregateId: "p-1" });
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.n).toBe(1);
  });

  it("loadGlobal works with partition pruning", async () => {
    const events = await uow().withTransaction(async (tx) => {
      return store.loadGlobal(tx, {
        fromGlobalPositionExclusive: 0n,
        limit: 100
      });
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("creates additional partitions", async () => {
    const name = await manager.createPartition(pool, 200n, 300n);
    expect(name).toBe("eventfabric.events_p_200_300");

    const partitions = await manager.listPartitions(pool);
    expect(partitions).toHaveLength(3);
  });

  it("detaches a partition for archival", async () => {
    const partitionsBefore = await manager.listPartitions(pool);
    const toDetach = partitionsBefore.find(p => p.name === "events_p_200_300");
    expect(toDetach).toBeDefined();

    await manager.detachPartition(pool, "events_p_200_300");

    const partitionsAfter = await manager.listPartitions(pool);
    expect(partitionsAfter).toHaveLength(2);

    // Detached table still exists as a standalone table
    const exists = await pool.query(`
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'events_p_200_300' AND n.nspname = 'eventfabric'
    `);
    expect(exists.rowCount).toBe(1);
  });

  it("handles high-volume inserts across partition boundary", async () => {
    // Current partition p1 covers [100, 200). Fill it and spill into a new one.
    await manager.createPartition(pool, 200n, 10_000n);

    // Insert many events
    for (let i = 0; i < 20; i++) {
      await uow().withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Bulk",
          aggregateId: `b-${i}`,
          expectedAggregateVersion: 0,
          events: Array.from({ length: 5 }, (_, j) => ({
            type: "Tick" as const,
            version: 1 as const,
            n: i * 5 + j
          }))
        });
      });
    }

    // All events should be queryable
    const all = await uow().withTransaction(async (tx) => {
      return store.loadGlobal(tx, { fromGlobalPositionExclusive: 0n, limit: 1000 });
    });
    // At least the 100 bulk events + 1 from earlier test
    expect(all.length).toBeGreaterThanOrEqual(101);
  });

  it("covering index exists on the partitioned table", async () => {
    const result = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'eventfabric'
        AND tablename = 'events'
        AND indexname = 'events_stream_covering_idx'
    `);
    // Parent-level index entry exists for partitioned tables
    expect(result.rowCount).toBe(1);
    // The actual indexes live on the partitions
    const partitionIndexes = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'eventfabric'
        AND indexdef LIKE '%aggregate_name%aggregate_id%aggregate_version%'
        AND indexdef LIKE '%INCLUDE%payload%'
    `);
    expect(partitionIndexes.rowCount).toBeGreaterThan(0);
  });
});

describe("PgPartitionManager with pre-existing data", () => {
  let pool2: Pool;
  let container2: Awaited<ReturnType<PostgreSqlContainer["start"]>>;

  beforeAll(async () => {
    container2 = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool2 = new Pool({ connectionString: container2.getConnectionUri() });

    // Create schema with data BEFORE partitioning
    await pool2.query(`
      CREATE SCHEMA IF NOT EXISTS eventfabric;
      CREATE TABLE IF NOT EXISTS eventfabric.stream_versions (
        aggregate_name TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        current_version INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (aggregate_name, aggregate_id)
      );
      CREATE TABLE IF NOT EXISTS eventfabric.events (
        global_position BIGSERIAL PRIMARY KEY,
        event_id UUID NOT NULL,
        aggregate_name TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        aggregate_version INT NOT NULL,
        type TEXT NOT NULL,
        version INT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        dismissed_at TIMESTAMPTZ NULL,
        dismissed_reason TEXT NULL,
        dismissed_by TEXT NULL,
        correlation_id TEXT NULL,
        causation_id TEXT NULL
      );
      CREATE TABLE IF NOT EXISTS eventfabric.outbox (
        id BIGSERIAL PRIMARY KEY,
        global_position BIGINT NOT NULL UNIQUE,
        topic TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_at TIMESTAMPTZ NULL,
        locked_by TEXT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT NULL,
        dead_lettered_at TIMESTAMPTZ NULL,
        dead_letter_reason TEXT NULL
      );
    `);

    // Seed 15 events across 3 streams
    const store = new PgEventStore<E>();
    const uow2 = new PgUnitOfWork(pool2);
    for (let i = 0; i < 3; i++) {
      await uow2.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Pre",
          aggregateId: `pre-${i}`,
          expectedAggregateVersion: 0,
          events: Array.from({ length: 5 }, (_, j) => ({
            type: "Tick" as const,
            version: 1 as const,
            n: i * 5 + j
          }))
        });
      });
    }
  }, 120000);

  afterAll(async () => {
    if (pool2) await pool2.end();
    if (container2) await container2.stop();
  });

  it("preserves all existing events after enabling partitioning", async () => {
    const manager = new PgPartitionManager();
    const store = new PgEventStore<E>();
    const uow2 = new PgUnitOfWork(pool2);

    // Verify pre-existing data
    const before = await uow2.withTransaction(async (tx) => {
      return store.loadGlobal(tx, { fromGlobalPositionExclusive: 0n, limit: 100 });
    });
    expect(before).toHaveLength(15);

    // Enable partitioning (small partitions for testing)
    await manager.enablePartitioning(pool2, { partitionSize: 50n });
    expect(await manager.isPartitioned(pool2)).toBe(true);

    // Verify all data survived
    const after = await uow2.withTransaction(async (tx) => {
      return store.loadGlobal(tx, { fromGlobalPositionExclusive: 0n, limit: 100 });
    });
    expect(after).toHaveLength(15);

    // Verify individual streams still load correctly
    for (let i = 0; i < 3; i++) {
      const stream = await uow2.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "Pre", aggregateId: `pre-${i}` });
      });
      expect(stream).toHaveLength(5);
      expect(stream[0]!.aggregateVersion).toBe(1);
      expect(stream[4]!.aggregateVersion).toBe(5);
    }

    // Verify new writes work after partitioning
    await uow2.withTransaction(async (tx) => {
      await store.append(tx, {
        aggregateName: "Post",
        aggregateId: "post-1",
        expectedAggregateVersion: 0,
        events: [{ type: "Tick", version: 1, n: 99 }]
      });
    });

    const postEvents = await uow2.withTransaction(async (tx) => {
      return store.loadStream(tx, { aggregateName: "Post", aggregateId: "post-1" });
    });
    expect(postEvents).toHaveLength(1);
    expect(postEvents[0]!.payload.n).toBe(99);

    // Sequence continues from where it left off
    expect(postEvents[0]!.globalPosition).toBeGreaterThan(15n);
  });
});
