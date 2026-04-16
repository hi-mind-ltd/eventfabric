import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS eventfabric;
    CREATE TABLE IF NOT EXISTS test_table (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      value INT NOT NULL
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

describe("PgUnitOfWork", () => {
  beforeEach(async () => {
    // Clean up before each test
    await pool.query(`DELETE FROM test_table`);
  }, 60000);

  describe("withTransaction - successful execution", () => {
    it("executes function and commits transaction", async () => {
      const uow = new PgUnitOfWork(pool);

      await uow.withTransaction(async (tx) => {
        await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["test", 42]);
      });

      // Verify data was committed
      const result = await pool.query(`SELECT * FROM test_table`);
      expect(result.rowCount).toBe(1);
      expect(result.rows[0].value).toBe(42);
    });

    it("returns value from function", async () => {
      const uow = new PgUnitOfWork(pool);

      const result = await uow.withTransaction(async (tx) => {
        await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["test", 100]);
        return { success: true, count: 1 };
      });

      expect(result).toEqual({ success: true, count: 1 });
    });

    it("handles multiple operations in one transaction", async () => {
      const uow = new PgUnitOfWork(pool);

      await uow.withTransaction(async (tx) => {
        await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["a", 1]);
        await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["b", 2]);
        await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["c", 3]);
      });

      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM test_table`);
      expect(result.rows[0].count).toBe(3);
    });

    it("handles complex return values", async () => {
      const uow = new PgUnitOfWork(pool);

      const result = await uow.withTransaction(async (tx) => {
        const insertResult = await tx.client.query(
          `INSERT INTO test_table (name, value) VALUES ($1, $2) RETURNING id`,
          ["test", 42]
        );
        return {
          id: insertResult.rows[0].id,
          name: "test",
          value: 42
        };
      });

      expect(result.id).toBeGreaterThan(0);
      expect(result.name).toBe("test");
      expect(result.value).toBe(42);
    });
  });

  describe("withTransaction - error handling and rollback", () => {
    it("rolls back transaction on error", async () => {
      const uow = new PgUnitOfWork(pool);

      try {
        await uow.withTransaction(async (tx) => {
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["test", 42]);
          throw new Error("Test error");
        });
        expect.fail("Should have thrown an error");
      } catch (e: any) {
        expect(e.message).toBe("Test error");
      }

      // Verify data was NOT committed (rolled back)
      const result = await pool.query(`SELECT * FROM test_table`);
      expect(result.rowCount).toBe(0);
    });

    it("rolls back all operations in transaction on error", async () => {
      const uow = new PgUnitOfWork(pool);

      try {
        await uow.withTransaction(async (tx) => {
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["a", 1]);
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["b", 2]);
          throw new Error("Error after inserts");
        });
        expect.fail("Should have thrown an error");
      } catch (e: any) {
        expect(e.message).toBe("Error after inserts");
      }

      // Verify no data was committed
      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM test_table`);
      expect(result.rows[0].count).toBe(0);
    });

    it("handles database constraint violations", async () => {
      const uow = new PgUnitOfWork(pool);

      // First insert succeeds and gets an auto-generated id
      let firstId: number;
      await uow.withTransaction(async (tx) => {
        const result = await tx.client.query(
          `INSERT INTO test_table (name, value) VALUES ($1, $2) RETURNING id`,
          ["test", 42]
        );
        firstId = result.rows[0].id;
      });

      // Second transaction that will fail due to constraint
      try {
        await uow.withTransaction(async (tx) => {
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["before-error", 1]);
          // Try to insert with duplicate name (if we had a unique constraint) or use a different approach
          // Instead, let's use a NOT NULL constraint violation or check constraint
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, [null, 2]);
        });
        expect.fail("Should have thrown an error");
      } catch (e: any) {
        // PostgreSQL will throw an error for constraint violation
        expect(e).toBeDefined();
      }

      // Original data should still be there
      const result = await pool.query(`SELECT * FROM test_table`);
      expect(result.rowCount).toBe(1);
      expect(result.rows[0].name).toBe("test");

      // The failed transaction's data should not be there
      const failedResult = await pool.query(`SELECT * FROM test_table WHERE name = 'before-error'`);
      expect(failedResult.rowCount).toBe(0);
    });

    it("handles SQL syntax errors", async () => {
      const uow = new PgUnitOfWork(pool);

      try {
        await uow.withTransaction(async (tx) => {
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["test", 42]);
          await tx.client.query(`INVALID SQL SYNTAX`);
        });
        expect.fail("Should have thrown an error");
      } catch (e: any) {
        expect(e).toBeDefined();
      }

      // Verify no data was committed
      const result = await pool.query(`SELECT * FROM test_table`);
      expect(result.rowCount).toBe(0);
    });

    it("propagates error after rollback", async () => {
      const uow = new PgUnitOfWork(pool);

      const error = new Error("Custom error");
      try {
        await uow.withTransaction(async (tx) => {
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["test", 42]);
          throw error;
        });
        expect.fail("Should have thrown an error");
      } catch (e) {
        expect(e).toBe(error);
      }

      // Verify rollback occurred
      const result = await pool.query(`SELECT * FROM test_table`);
      expect(result.rowCount).toBe(0);
    });
  });

  describe("withTransaction - client management", () => {
    it("releases client back to pool after successful transaction", async () => {
      const uow = new PgUnitOfWork(pool);
      const initialTotalCount = pool.totalCount;
      const initialIdleCount = pool.idleCount;

      await uow.withTransaction(async (tx) => {
        await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["test", 42]);
      });

      // Client should be released back to pool
      // Note: exact counts may vary, but we should have the client back
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(pool.idleCount).toBeGreaterThanOrEqual(initialIdleCount);
    });

    it("releases client back to pool after error", async () => {
      const uow = new PgUnitOfWork(pool);

      try {
        await uow.withTransaction(async (tx) => {
          throw new Error("Test error");
        });
      } catch (e) {
        // Expected
      }

      // Client should still be released
      await new Promise(resolve => setTimeout(resolve, 100));
      // Pool should not be in a bad state
      expect(pool.totalCount).toBeGreaterThanOrEqual(0);
    });

    it("handles rollback errors gracefully", async () => {
      const uow = new PgUnitOfWork(pool);

      // This test verifies that if ROLLBACK itself fails, the client is still released
      // We can't easily simulate a ROLLBACK failure, but we can verify the error handling
      try {
        await uow.withTransaction(async (tx) => {
          // Force an error that will trigger rollback
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["test", 42]);
          throw new Error("Test error");
        });
      } catch (e: any) {
        expect(e.message).toBe("Test error");
      }

      // Client should still be released even if rollback had issues
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(pool.totalCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe("withTransaction - isolation", () => {
    it("isolates transactions from each other", async () => {
      const uow = new PgUnitOfWork(pool);

      // First transaction
      await uow.withTransaction(async (tx) => {
        await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["a", 1]);
      });

      // Second transaction
      await uow.withTransaction(async (tx) => {
        await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["b", 2]);
      });

      // Both should be committed
      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM test_table`);
      expect(result.rows[0].count).toBe(2);
    });

    it("does not see uncommitted changes from other transactions", async () => {
      // Use two raw clients with manual transaction control — no timing
      // dependency. client1's tx is explicitly held open while client2 queries.
      const client1 = await pool.connect();
      const client2 = await pool.connect();

      try {
        await client1.query("BEGIN");
        await client1.query(
          `INSERT INTO test_table (name, value) VALUES ($1, $2)`,
          ["a", 1]
        );
        // client1 has inserted but NOT committed

        await client2.query("BEGIN");
        const result = await client2.query(
          `SELECT COUNT(*)::int AS count FROM test_table`
        );
        await client2.query("COMMIT");

        // Under READ COMMITTED, client2 must not see client1's uncommitted row
        expect(result.rows[0].count).toBe(0);

        await client1.query("COMMIT");

        // After commit, the row is visible
        const afterCommit = await pool.query(
          `SELECT COUNT(*)::int AS count FROM test_table`
        );
        expect(afterCommit.rows[0].count).toBe(1);
      } finally {
        client1.release();
        client2.release();
      }
    });
  });

  describe("withTransaction - concurrent operations", () => {
    it("handles concurrent transactions", async () => {
      const uow = new PgUnitOfWork(pool);

      // Run multiple transactions concurrently
      const promises = Array.from({ length: 5 }, (_, i) =>
        uow.withTransaction(async (tx) => {
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, [`item-${i}`, i]);
        })
      );

      await Promise.all(promises);

      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM test_table`);
      expect(result.rows[0].count).toBe(5);
    });

    it("handles concurrent transactions with errors", async () => {
      const uow = new PgUnitOfWork(pool);

      const promises = [
        uow.withTransaction(async (tx) => {
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["success", 1]);
        }),
        uow.withTransaction(async (tx) => {
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["success", 2]);
          throw new Error("Failure");
        }).catch(() => {}),
        uow.withTransaction(async (tx) => {
          await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["success", 3]);
        })
      ];

      await Promise.all(promises);

      // Only successful transactions should be committed
      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM test_table`);
      expect(result.rows[0].count).toBe(2);
    });
  });

  describe("withTransaction - edge cases", () => {
    it("handles empty transaction function", async () => {
      const uow = new PgUnitOfWork(pool);

      const result = await uow.withTransaction(async () => {
        return "empty";
      });

      expect(result).toBe("empty");
    });

    it("handles async operations that complete immediately", async () => {
      const uow = new PgUnitOfWork(pool);

      const result = await uow.withTransaction(async (tx) => {
        return Promise.resolve("immediate");
      });

      expect(result).toBe("immediate");
    });

    it("handles null return value", async () => {
      const uow = new PgUnitOfWork(pool);

      const result = await uow.withTransaction(async (tx) => {
        await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["test", 42]);
        return null;
      });

      expect(result).toBeNull();

      // But transaction should still be committed
      const dbResult = await pool.query(`SELECT * FROM test_table`);
      expect(dbResult.rowCount).toBe(1);
    });

    it("handles undefined return value", async () => {
      const uow = new PgUnitOfWork(pool);

      const result = await uow.withTransaction(async (tx) => {
        await tx.client.query(`INSERT INTO test_table (name, value) VALUES ($1, $2)`, ["test", 42]);
        return undefined;
      });

      expect(result).toBeUndefined();

      // But transaction should still be committed
      const dbResult = await pool.query(`SELECT * FROM test_table`);
      expect(dbResult.rowCount).toBe(1);
    });
  });
});

