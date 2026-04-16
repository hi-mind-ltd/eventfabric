import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgSnapshotStore, type Snapshot } from "../src/snapshots/pg-snapshot-store";

type StateV1 = { count: number };
type StateV2 = { count: number; label: string };

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS eventfabric;
    CREATE TABLE IF NOT EXISTS eventfabric.snapshots (
      aggregate_name TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      snapshot_schema_version INT NOT NULL,
      state JSONB NOT NULL,
      PRIMARY KEY (aggregate_name, aggregate_id)
    );
  `);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate();
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

describe("PgSnapshotStore", () => {
  beforeEach(async () => {
    // Clean up before each test
    await pool.query(`DELETE FROM eventfabric.snapshots`);
  }, 60000);

  it("returns null when snapshot does not exist", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgSnapshotStore<StateV1>();

    const snapshot = await uow.withTransaction(async (tx) => {
      return store.load(tx, "User", "u1");
    });

    expect(snapshot).toBeNull();
  });

  it("saves and loads a snapshot", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgSnapshotStore<StateV1>();

    const snapshot = {
      aggregateName: "User",
      aggregateId: "u1",
      aggregateVersion: 5,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: { count: 42 }
    };

    await uow.withTransaction(async (tx) => {
      await store.save(tx, snapshot);
    });

    const loaded = await uow.withTransaction(async (tx) => {
      return store.load(tx, "User", "u1");
    });

    expect(loaded).not.toBeNull();
    expect(loaded!.aggregateName).toBe("User");
    expect(loaded!.aggregateId).toBe("u1");
    expect(loaded!.aggregateVersion).toBe(5);
    expect(loaded!.snapshotSchemaVersion).toBe(1);
    expect(loaded!.state).toEqual({ count: 42 });
    expect(loaded!.createdAt).toBeTruthy();
  });

  it("updates snapshot when new version is greater", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgSnapshotStore<StateV1>();

    const snapshot1 = {
      aggregateName: "User",
      aggregateId: "u1",
      aggregateVersion: 5,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: { count: 42 }
    };

    const snapshot2 = {
      aggregateName: "User",
      aggregateId: "u1",
      aggregateVersion: 10,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: { count: 100 }
    };

    await uow.withTransaction(async (tx) => {
      await store.save(tx, snapshot1);
    });

    await uow.withTransaction(async (tx) => {
      await store.save(tx, snapshot2);
    });

    const loaded = await uow.withTransaction(async (tx) => {
      return store.load(tx, "User", "u1");
    });

    expect(loaded!.aggregateVersion).toBe(10);
    expect(loaded!.state).toEqual({ count: 100 });
  });

  it("updates snapshot when new version is equal", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgSnapshotStore<StateV1>();

    const snapshot1 = {
      aggregateName: "User",
      aggregateId: "u1",
      aggregateVersion: 5,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: { count: 42 }
    };

    const snapshot2 = {
      aggregateName: "User",
      aggregateId: "u1",
      aggregateVersion: 5,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: { count: 99 }
    };

    await uow.withTransaction(async (tx) => {
      await store.save(tx, snapshot1);
    });

    await uow.withTransaction(async (tx) => {
      await store.save(tx, snapshot2);
    });

    const loaded = await uow.withTransaction(async (tx) => {
      return store.load(tx, "User", "u1");
    });

    expect(loaded!.aggregateVersion).toBe(5);
    expect(loaded!.state).toEqual({ count: 99 });
  });

  it("does not update snapshot when new version is less", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgSnapshotStore<StateV1>();

    const snapshot1 = {
      aggregateName: "User",
      aggregateId: "u1",
      aggregateVersion: 10,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: { count: 100 }
    };

    const snapshot2 = {
      aggregateName: "User",
      aggregateId: "u1",
      aggregateVersion: 5,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: { count: 42 }
    };

    await uow.withTransaction(async (tx) => {
      await store.save(tx, snapshot1);
    });

    await uow.withTransaction(async (tx) => {
      await store.save(tx, snapshot2);
    });

    const loaded = await uow.withTransaction(async (tx) => {
      return store.load(tx, "User", "u1");
    });

    // Should keep the original (higher version)
    expect(loaded!.aggregateVersion).toBe(10);
    expect(loaded!.state).toEqual({ count: 100 });
  });

  it("upcasts snapshot from older schema version", async () => {
    const uow = new PgUnitOfWork(pool);
    
    // Define upcaster from v1 to v2
    const upcasters = {
      1: (input: unknown): StateV2 => {
        const v1 = input as StateV1;
        return { count: v1.count, label: `Item-${v1.count}` };
      }
    };

    const store = new PgSnapshotStore<StateV2>("eventfabric.snapshots", 2, upcasters);

    // Save a snapshot with schema version 1
    await pool.query(`
      INSERT INTO eventfabric.snapshots (aggregate_name, aggregate_id, aggregate_version, created_at, snapshot_schema_version, state)
      VALUES ('User', 'u1', 5, now(), 1, $1::jsonb)
    `, [JSON.stringify({ count: 42 })]);

    const loaded = await uow.withTransaction(async (tx) => {
      return store.load(tx, "User", "u1");
    });

    expect(loaded).not.toBeNull();
    expect(loaded!.snapshotSchemaVersion).toBe(2); // Current version
    expect(loaded!.state).toEqual({ count: 42, label: "Item-42" }); // Upcasted
  });

  it("does not upcast when schema version matches current", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgSnapshotStore<StateV1>("eventfabric.snapshots", 1, {});

    const snapshot = {
      aggregateName: "User",
      aggregateId: "u1",
      aggregateVersion: 5,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: { count: 42 }
    };

    await uow.withTransaction(async (tx) => {
      await store.save(tx, snapshot);
    });

    const loaded = await uow.withTransaction(async (tx) => {
      return store.load(tx, "User", "u1");
    });

    expect(loaded!.snapshotSchemaVersion).toBe(1);
    expect(loaded!.state).toEqual({ count: 42 }); // No upcasting needed
  });

  it("throws error when upcaster is missing for schema version", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgSnapshotStore<StateV2>("eventfabric.snapshots", 2, {}); // No upcasters

    // Save a snapshot with schema version 1
    await pool.query(`
      INSERT INTO eventfabric.snapshots (aggregate_name, aggregate_id, aggregate_version, created_at, snapshot_schema_version, state)
      VALUES ('User', 'u1', 5, now(), 1, $1::jsonb)
    `, [JSON.stringify({ count: 42 })]);

    await expect(
      uow.withTransaction(async (tx) => {
        return store.load(tx, "User", "u1");
      })
    ).rejects.toThrow("No snapshot upcaster for schema version 1");
  });

  it("handles multiple upcasters for different schema versions", async () => {
    const uow = new PgUnitOfWork(pool);
    
    // Define upcasters: v1 -> v2, v2 -> v3
    type StateV3 = { count: number; label: string; tags: string[] };
    
    const upcasters = {
      1: (input: unknown): StateV3 => {
        const v1 = input as StateV1;
        return { count: v1.count, label: `Item-${v1.count}`, tags: [] };
      },
      2: (input: unknown): StateV3 => {
        const v2 = input as StateV2;
        return { count: v2.count, label: v2.label, tags: [v2.label] };
      }
    };

    const store = new PgSnapshotStore<StateV3>("eventfabric.snapshots", 3, upcasters);

    // Save a snapshot with schema version 1
    await pool.query(`
      INSERT INTO eventfabric.snapshots (aggregate_name, aggregate_id, aggregate_version, created_at, snapshot_schema_version, state)
      VALUES ('User', 'u1', 5, now(), 1, $1::jsonb)
    `, [JSON.stringify({ count: 42 })]);

    const loaded = await uow.withTransaction(async (tx) => {
      return store.load(tx, "User", "u1");
    });

    expect(loaded!.snapshotSchemaVersion).toBe(3);
    expect(loaded!.state).toEqual({ count: 42, label: "Item-42", tags: [] });
  });

  it("handles complex state objects", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgSnapshotStore<any>();

    type ComplexState = {
      user: { id: string; name: string };
      settings: { theme: string; notifications: boolean };
      metadata: { created: string; tags: string[] };
    };

    const snapshot: Snapshot<ComplexState> = {
      aggregateName: "User",
      aggregateId: "u1",
      aggregateVersion: 10,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: {
        user: { id: "123", name: "John" },
        settings: { theme: "dark", notifications: true },
        metadata: { created: "2024-01-01", tags: ["admin", "premium"] }
      }
    };

    await uow.withTransaction(async (tx) => {
      await store.save(tx, snapshot);
    });

    const loaded = await uow.withTransaction(async (tx) => {
      return store.load(tx, "User", "u1");
    });

    expect(loaded!.state).toEqual(snapshot.state);
    expect(loaded!.state.user.name).toBe("John");
    expect(loaded!.state.settings.theme).toBe("dark");
    expect(loaded!.state.metadata.tags).toEqual(["admin", "premium"]);
  });

  it("handles different aggregate names and IDs independently", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgSnapshotStore<StateV1>();

    const snapshot1 = {
      aggregateName: "User",
      aggregateId: "u1",
      aggregateVersion: 5,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: { count: 10 }
    };

    const snapshot2 = {
      aggregateName: "Order",
      aggregateId: "o1",
      aggregateVersion: 3,
      createdAt: new Date().toISOString(),
      snapshotSchemaVersion: 1,
      state: { count: 20 }
    };

    await uow.withTransaction(async (tx) => {
      await store.save(tx, snapshot1);
      await store.save(tx, snapshot2);
    });

    const loaded1 = await uow.withTransaction(async (tx) => {
      return store.load(tx, "User", "u1");
    });

    const loaded2 = await uow.withTransaction(async (tx) => {
      return store.load(tx, "Order", "o1");
    });

    expect(loaded1!.state.count).toBe(10);
    expect(loaded2!.state.count).toBe(20);
  });

  // The INSERT ... ON CONFLICT DO UPDATE ... WHERE pattern was flagged as racy
  // ("older snapshot could win the WHERE clause, newer is silently discarded").
  // This test tries hard to provoke that race to verify whether it's real.
  //
  // Under READ COMMITTED, Postgres takes a row-level lock on the conflicting
  // row during ON CONFLICT resolution and uses EvalPlanQual to re-read the
  // latest committed version before evaluating the WHERE clause. So concurrent
  // upserts should serialize and the highest version should always win.
  describe("concurrent save safety", () => {
    it("highest version always wins under many concurrent saves", async () => {
      const store = new PgSnapshotStore<StateV1>();
      const uow = new PgUnitOfWork(pool);

      const aggregateName = "Race";
      const aggregateId = "r1";

      // 50 concurrent saves, each at a different version (1..50), in random order.
      // Each save has a state value equal to its version, so we can verify the
      // final stored state matches the final stored version.
      const versions = Array.from({ length: 50 }, (_, i) => i + 1);
      // Fisher-Yates shuffle (deterministic enough — we rely on wall-clock races)
      for (let i = versions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [versions[i], versions[j]] = [versions[j]!, versions[i]!];
      }

      const saves = versions.map((v) =>
        uow.withTransaction((tx) =>
          store.save(tx, {
            aggregateName,
            aggregateId,
            aggregateVersion: v,
            createdAt: new Date().toISOString(),
            snapshotSchemaVersion: 1,
            state: { count: v }
          })
        )
      );

      await Promise.all(saves);

      const loaded = await uow.withTransaction((tx) => store.load(tx, aggregateName, aggregateId));

      expect(loaded).not.toBeNull();
      // Final stored version must be the max
      expect(loaded!.aggregateVersion).toBe(50);
      // Critical: state must match that version (no torn writes — the row that
      // "won" the WHERE clause persisted both its version AND its state)
      expect(loaded!.state.count).toBe(50);
    });

    it("state and version stay consistent after interleaved higher/lower saves", async () => {
      const store = new PgSnapshotStore<StateV1>();
      const uow = new PgUnitOfWork(pool);

      const aggregateName = "Race";
      const aggregateId = "r2";

      // Alternating pattern designed to tempt a torn write: a high version
      // immediately followed by a low one, repeated. If the WHERE clause ever
      // evaluates against a stale snapshot, the low version could overwrite
      // a higher one.
      const pairs: Array<{ v: number; s: number }> = [];
      for (let i = 0; i < 20; i++) {
        pairs.push({ v: 100 + i, s: 100 + i });
        pairs.push({ v: 1 + i, s: 1 + i });
      }

      await Promise.all(
        pairs.map((p) =>
          uow.withTransaction((tx) =>
            store.save(tx, {
              aggregateName,
              aggregateId,
              aggregateVersion: p.v,
              createdAt: new Date().toISOString(),
              snapshotSchemaVersion: 1,
              state: { count: p.s }
            })
          )
        )
      );

      const loaded = await uow.withTransaction((tx) => store.load(tx, aggregateName, aggregateId));

      expect(loaded).not.toBeNull();
      // Max version among pairs is 119 (100+19). State must match.
      expect(loaded!.aggregateVersion).toBe(119);
      expect(loaded!.state.count).toBe(119);
    });
  });
});

