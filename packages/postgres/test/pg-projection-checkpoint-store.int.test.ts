import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgProjectionCheckpointStore } from "../src/projections/pg-projection-checkpoint-store";
import { migrate } from "../src/pg-migrator";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

describe("PgProjectionCheckpointStore", () => {
  beforeEach(async () => {
    // Clean up before each test
    await pool.query(`DELETE FROM eventfabric.projection_checkpoints`);
  }, 60000);

  it("creates checkpoint with position 0 when getting non-existent projection", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgProjectionCheckpointStore();

    const checkpoint = await uow.withTransaction(async (tx) => {
      return store.get(tx, "new-projection", "default");
    });

    expect(checkpoint.projectionName).toBe("new-projection");
    expect(checkpoint.lastGlobalPosition).toBe(0n);
    expect(checkpoint.updatedAt).toBeTruthy();

    // Verify it was created in database
    const dbCheck = await pool.query(
      `SELECT * FROM eventfabric.projection_checkpoints WHERE projection_name = $1`,
      ["new-projection"]
    );
    expect(dbCheck.rowCount).toBe(1);
    expect(Number(dbCheck.rows[0].last_global_position)).toBe(0);
  });

  it("gets existing checkpoint", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgProjectionCheckpointStore();

    // Create checkpoint manually
    await pool.query(`
      INSERT INTO eventfabric.projection_checkpoints (projection_name, last_global_position, updated_at)
      VALUES ('existing-projection', 100, now())
    `);

    const checkpoint = await uow.withTransaction(async (tx) => {
      return store.get(tx, "existing-projection", "default");
    });

    expect(checkpoint.projectionName).toBe("existing-projection");
    expect(checkpoint.lastGlobalPosition).toBe(100n);
    expect(checkpoint.updatedAt).toBeTruthy();
  });

  it("sets checkpoint position", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgProjectionCheckpointStore();

    await uow.withTransaction(async (tx) => {
      await store.set(tx, "test-projection", "default", 500n);
    });

    const checkpoint = await uow.withTransaction(async (tx) => {
      return store.get(tx, "test-projection", "default");
    });

    expect(checkpoint.lastGlobalPosition).toBe(500n);
  });

  it("updates checkpoint when new position is greater", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgProjectionCheckpointStore();

    // Set initial position
    await uow.withTransaction(async (tx) => {
      await store.set(tx, "update-test", "default", 100n);
    });

    // Update to higher position
    await uow.withTransaction(async (tx) => {
      await store.set(tx, "update-test", "default", 200n);
    });

    const checkpoint = await uow.withTransaction(async (tx) => {
      return store.get(tx, "update-test", "default");
    });

    expect(checkpoint.lastGlobalPosition).toBe(200n);
  });

  it("updates checkpoint when new position is equal", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgProjectionCheckpointStore();

    // Set initial position
    await uow.withTransaction(async (tx) => {
      await store.set(tx, "equal-test", "default", 100n);
    });

    // Update to same position (should update updated_at)
    const beforeUpdate = await uow.withTransaction(async (tx) => {
      return store.get(tx, "equal-test", "default");
    });

    await new Promise(resolve => setTimeout(resolve, 10)); // Small delay

    await uow.withTransaction(async (tx) => {
      await store.set(tx, "equal-test", "default", 100n);
    });

    const afterUpdate = await uow.withTransaction(async (tx) => {
      return store.get(tx, "equal-test", "default");
    });

    expect(afterUpdate.lastGlobalPosition).toBe(100n);
    // updated_at should be refreshed
    expect(new Date(afterUpdate.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(beforeUpdate.updatedAt).getTime()
    );
  });

  it("does not update checkpoint when new position is less", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgProjectionCheckpointStore();

    // Set initial position
    await uow.withTransaction(async (tx) => {
      await store.set(tx, "downgrade-test", "default", 200n);
    });

    // Try to set lower position
    await uow.withTransaction(async (tx) => {
      await store.set(tx, "downgrade-test", "default", 100n);
    });

    const checkpoint = await uow.withTransaction(async (tx) => {
      return store.get(tx, "downgrade-test", "default");
    });

    // Should keep the higher position
    expect(checkpoint.lastGlobalPosition).toBe(200n);
  });

  it("handles multiple projections independently", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgProjectionCheckpointStore();

    await uow.withTransaction(async (tx) => {
      await store.set(tx, "projection-1", "default", 100n);
      await store.set(tx, "projection-2", "default", 200n);
      await store.set(tx, "projection-3", "default", 300n);
    });

    const cp1 = await uow.withTransaction(async (tx) => {
      return store.get(tx, "projection-1", "default");
    });
    const cp2 = await uow.withTransaction(async (tx) => {
      return store.get(tx, "projection-2", "default");
    });
    const cp3 = await uow.withTransaction(async (tx) => {
      return store.get(tx, "projection-3", "default");
    });

    expect(cp1.lastGlobalPosition).toBe(100n);
    expect(cp2.lastGlobalPosition).toBe(200n);
    expect(cp3.lastGlobalPosition).toBe(300n);
  });

  it("handles very large global positions", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgProjectionCheckpointStore();

    const largePosition = BigInt("9223372036854775807"); // Max bigint

    await uow.withTransaction(async (tx) => {
      await store.set(tx, "large-position-test", "default", largePosition);
    });

    const checkpoint = await uow.withTransaction(async (tx) => {
      return store.get(tx, "large-position-test", "default");
    });

    expect(checkpoint.lastGlobalPosition).toBe(largePosition);
  });

  it("handles concurrent get calls for same projection", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgProjectionCheckpointStore();

    // Multiple concurrent gets should all create the same checkpoint
    const results = await Promise.all([
      uow.withTransaction(async (tx) => store.get(tx, "concurrent-test", "default")),
      uow.withTransaction(async (tx) => store.get(tx, "concurrent-test", "default")),
      uow.withTransaction(async (tx) => store.get(tx, "concurrent-test", "default"))
    ]);

    // All should return the same checkpoint
    expect(results[0]!.projectionName).toBe("concurrent-test");
    expect(results[1]!.projectionName).toBe("concurrent-test");
    expect(results[2]!.projectionName).toBe("concurrent-test");
    expect(results[0]!.lastGlobalPosition).toBe(0n);

    // Should only have one row in database (ON CONFLICT DO NOTHING)
    const dbCheck = await pool.query(
      `SELECT COUNT(*)::int as count FROM eventfabric.projection_checkpoints WHERE projection_name = $1`,
      ["concurrent-test"]
    );
    expect(dbCheck.rows[0].count).toBe(1);
  });

  it("updates updated_at timestamp when setting checkpoint", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgProjectionCheckpointStore();

    // Create initial checkpoint
    await uow.withTransaction(async (tx) => {
      await store.set(tx, "timestamp-test", "default", 100n);
    });

    const before = await uow.withTransaction(async (tx) => {
      return store.get(tx, "timestamp-test", "default");
    });

    await new Promise(resolve => setTimeout(resolve, 100)); // Wait a bit

    // Update checkpoint
    await uow.withTransaction(async (tx) => {
      await store.set(tx, "timestamp-test", "default", 200n);
    });

    const after = await uow.withTransaction(async (tx) => {
      return store.get(tx, "timestamp-test", "default");
    });

    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.updatedAt).getTime()
    );
  });
});

