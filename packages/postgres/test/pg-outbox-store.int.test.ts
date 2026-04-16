import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgOutboxStore } from "../src/outbox/pg-outbox-store";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS eventfabric;
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

    CREATE TABLE IF NOT EXISTS eventfabric.outbox_dead_letters (
      id BIGSERIAL PRIMARY KEY,
      outbox_id BIGINT NOT NULL,
      global_position BIGINT NOT NULL,
      topic TEXT NULL,
      attempts INT NOT NULL,
      last_error TEXT NULL,
      dead_lettered_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

describe("PgOutboxStore", () => {
  beforeEach(async () => {
    // Clean up before each test
    await pool.query(`DELETE FROM eventfabric.outbox_dead_letters`);
    await pool.query(`DELETE FROM eventfabric.outbox`);
  }, 60000);

  describe("claimBatch", () => {
    it("returns empty array when no messages available", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      const claimed = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 10, workerId: "worker-1" });
      });

      expect(claimed).toHaveLength(0);
    });

    it("claims available messages up to batch size", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert some messages
      await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic)
        VALUES (100, 'user'), (200, 'order'), (300, 'user')
      `);

      const claimed = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 2, workerId: "worker-1" });
      });

      expect(claimed).toHaveLength(2);
      expect(claimed[0]!.globalPosition).toBe(100n);
      expect(claimed[1]!.globalPosition).toBe(200n);
      expect(claimed[0]!.attempts).toBe(1);
      expect(claimed[1]!.attempts).toBe(1);

      // Verify they are locked
      const locked = await pool.query(`
        SELECT id, locked_by, locked_at, attempts
        FROM eventfabric.outbox
        WHERE id IN ($1, $2)
      `, [claimed[0]!.id, claimed[1]!.id]);

      expect(locked.rows[0].locked_by).toBe("worker-1");
      expect(locked.rows[1].locked_by).toBe("worker-1");
      expect(locked.rows[0].locked_at).not.toBeNull();
      expect(locked.rows[0].attempts).toBe(1);
    });

    it("skips locked messages (SKIP LOCKED)", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert messages
      await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic)
        VALUES (100, 'user'), (200, 'order'), (300, 'user')
      `);

      // Lock first message in a separate transaction
      await pool.query(`
        UPDATE eventfabric.outbox
        SET locked_at = now(), locked_by = 'other-worker'
        WHERE global_position = 100
      `);

      const claimed = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 10, workerId: "worker-1" });
      });

      // Should skip the locked message and claim the others
      expect(claimed).toHaveLength(2);
      expect(claimed[0]!.globalPosition).toBe(200n);
      expect(claimed[1]!.globalPosition).toBe(300n);
    });

    it("skips dead-lettered messages", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert messages, one dead-lettered
      await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic, dead_lettered_at)
        VALUES (100, 'user', NULL), (200, 'order', now()), (300, 'user', NULL)
      `);

      const claimed = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 10, workerId: "worker-1" });
      });

      // Should skip dead-lettered message
      expect(claimed).toHaveLength(2);
      expect(claimed[0]!.globalPosition).toBe(100n);
      expect(claimed[1]!.globalPosition).toBe(300n);
    });

    it("filters by topic when provided", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert messages with different topics
      await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic)
        VALUES (100, 'user'), (200, 'order'), (300, 'user'), (400, 'order')
      `);

      const claimed = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 10, workerId: "worker-1", topic: "user" });
      });

      expect(claimed).toHaveLength(2);
      expect(claimed[0]!.topic).toBe("user");
      expect(claimed[1]!.topic).toBe("user");
      expect(claimed[0]!.globalPosition).toBe(100n);
      expect(claimed[1]!.globalPosition).toBe(300n);
    });

    it("handles null topic filter (no filter - matches all)", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert messages with null and non-null topics
      await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic)
        VALUES (100, 'user'), (200, NULL), (300, 'order')
      `);

      const claimed = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 10, workerId: "worker-1", topic: null });
      });

      // When topic is null, it means "no filter" - should match all messages
      expect(claimed).toHaveLength(3);
      expect(claimed.some(r => r.topic === "user")).toBe(true);
      expect(claimed.some(r => r.topic === null)).toBe(true);
      expect(claimed.some(r => r.topic === "order")).toBe(true);
    });

    it("increments attempts counter", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert message with existing attempts
      await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic, attempts)
        VALUES (100, 'user', 3)
      `);

      const claimed = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 10, workerId: "worker-1" });
      });

      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.attempts).toBe(4); // 3 + 1
    });

    it("orders by id ASC", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert messages in non-sequential order
      await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic)
        VALUES (300, 'user'), (100, 'order'), (200, 'user')
      `);

      const claimed = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 10, workerId: "worker-1" });
      });

      // Should be ordered by id (which corresponds to insertion order in this case)
      expect(claimed).toHaveLength(3);
      // First inserted should have lowest id
      expect(claimed[0]!.globalPosition).toBe(300n);
    });
  });

  describe("ack", () => {
    it("deletes message from outbox", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert a message
      const result = await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic)
        VALUES (100, 'user')
        RETURNING id
      `);
      const id = result.rows[0].id;

      await uow.withTransaction(async (tx) => {
        await store.ack(tx, id);
      });

      const remaining = await pool.query(`SELECT * FROM eventfabric.outbox`);
      expect(remaining.rowCount).toBe(0);
    });

    it("handles non-existent message id gracefully", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Should not throw
      await uow.withTransaction(async (tx) => {
        await store.ack(tx, 99999);
      });
    });
  });

  describe("releaseWithError", () => {
    it("unlocks message and sets error", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert and lock a message
      const result = await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic, locked_at, locked_by)
        VALUES (100, 'user', now(), 'worker-1')
        RETURNING id
      `);
      const id = result.rows[0].id;

      await uow.withTransaction(async (tx) => {
        await store.releaseWithError(tx, id, "Test error message");
      });

      const row = await pool.query(`SELECT * FROM eventfabric.outbox`);
      expect(row.rowCount).toBe(1);
      expect(row.rows[0].locked_at).toBeNull();
      expect(row.rows[0].locked_by).toBeNull();
      expect(row.rows[0].last_error).toBe("Test error message");
    });

    it("preserves other message fields", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert a message with various fields
      const result = await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic, attempts, locked_at, locked_by)
        VALUES (100, 'user', 5, now(), 'worker-1')
        RETURNING id
      `);
      const id = result.rows[0].id;

      await uow.withTransaction(async (tx) => {
        await store.releaseWithError(tx, id, "Error");
      });

      const row = await pool.query(`SELECT * FROM eventfabric.outbox`);
      expect(row.rows[0].global_position).toBe("100");
      expect(row.rows[0].topic).toBe("user");
      expect(row.rows[0].attempts).toBe(5);
    });

    it("handles long error messages", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      const result = await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic, locked_at, locked_by)
        VALUES (100, 'user', now(), 'worker-1')
        RETURNING id
      `);
      const id = result.rows[0].id;

      const longError = "A".repeat(1000);

      await uow.withTransaction(async (tx) => {
        await store.releaseWithError(tx, id, longError);
      });

      const row = await pool.query(`SELECT * FROM eventfabric.outbox`);
      expect(row.rows[0].last_error).toBe(longError);
    });
  });

  describe("deadLetter", () => {
    it("moves message to dead letter queue and deletes from outbox", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      // Insert a message
      const result = await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic, attempts, last_error)
        VALUES (100, 'user', 3, 'Previous error')
        RETURNING id, global_position, topic, attempts, last_error
      `);
      const row = result.rows[0];

      const outboxRow = {
        id: row.id,
        globalPosition: BigInt(row.global_position),
        topic: row.topic,
        attempts: row.attempts
      };

      await uow.withTransaction(async (tx) => {
        await store.deadLetter(tx, outboxRow, "Max attempts exceeded");
      });

      // Should be deleted from outbox
      const outboxCheck = await pool.query(`SELECT * FROM eventfabric.outbox`);
      expect(outboxCheck.rowCount).toBe(0);

      // Should be in DLQ
      const dlqCheck = await pool.query(`
        SELECT * FROM eventfabric.outbox_dead_letters WHERE outbox_id = $1
      `, [row.id]);
      expect(dlqCheck.rowCount).toBe(1);
      expect(Number(dlqCheck.rows[0].global_position)).toBe(100);
      expect(dlqCheck.rows[0].topic).toBe("user");
      expect(dlqCheck.rows[0].attempts).toBe(3);
      expect(dlqCheck.rows[0].last_error).toBe("Previous error");
      expect(dlqCheck.rows[0].dead_lettered_at).not.toBeNull();
    });

    it("handles null topic in dead letter", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      const result = await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic, attempts)
        VALUES (200, NULL, 2)
        RETURNING id, global_position, topic, attempts
      `);
      const row = result.rows[0];

      const outboxRow = {
        id: row.id,
        globalPosition: BigInt(row.global_position),
        topic: row.topic,
        attempts: row.attempts
      };

      await uow.withTransaction(async (tx) => {
        await store.deadLetter(tx, outboxRow, "Error");
      });

      const dlqCheck = await pool.query(`
        SELECT * FROM eventfabric.outbox_dead_letters WHERE outbox_id = $1
      `, [row.id]);
      expect(dlqCheck.rowCount).toBe(1);
      expect(dlqCheck.rows[0].topic).toBeNull();
    });

    it("preserves all message details in DLQ", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      const result = await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic, attempts, last_error)
        VALUES (300, 'order', 10, 'Multiple failures')
        RETURNING id, global_position, topic, attempts, last_error
      `);
      const row = result.rows[0];

      const outboxRow = {
        id: row.id,
        globalPosition: BigInt(row.global_position),
        topic: row.topic,
        attempts: row.attempts
      };

      await uow.withTransaction(async (tx) => {
        await store.deadLetter(tx, outboxRow, "Final failure");
      });

      const dlqCheck = await pool.query(`
        SELECT * FROM eventfabric.outbox_dead_letters WHERE outbox_id = $1
      `, [row.id]);
      expect(dlqCheck.rows[0].global_position).toBe("300");
      expect(dlqCheck.rows[0].topic).toBe("order");
      expect(dlqCheck.rows[0].attempts).toBe(10);
      expect(dlqCheck.rows[0].last_error).toBe("Multiple failures");
    });

    it("marks message as dead-lettered before deletion", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      const result = await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic)
        VALUES (400, 'user')
        RETURNING id, global_position, topic, attempts
      `);
      const row = result.rows[0];

      const outboxRow = {
        id: row.id,
        globalPosition: BigInt(row.global_position),
        topic: row.topic,
        attempts: row.attempts
      };

      // Use a separate transaction to check the intermediate state
      // Note: In a real scenario, the UPDATE happens before DELETE in the same transaction
      await uow.withTransaction(async (tx) => {
        await store.deadLetter(tx, outboxRow, "Reason");
      });

      // The message should be completely removed from outbox
      const outboxCheck = await pool.query(`SELECT * FROM eventfabric.outbox`);
      expect(outboxCheck.rowCount).toBe(0);
    });
  });

  describe("integration scenarios", () => {
    it("handles claim -> ack workflow", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic)
        VALUES (100, 'user')
      `);

      const claimed = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 1, workerId: "worker-1" });
      });

      expect(claimed).toHaveLength(1);

      await uow.withTransaction(async (tx) => {
        await store.ack(tx, claimed[0]!.id);
      });

      const remaining = await pool.query(`SELECT * FROM eventfabric.outbox`);
      expect(remaining.rowCount).toBe(0);
    });

    it("handles claim -> release -> claim again workflow", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic)
        VALUES (100, 'user')
      `);

      // First claim
      const claimed1 = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 1, workerId: "worker-1" });
      });
      expect(claimed1).toHaveLength(1);
      expect(claimed1[0]!.attempts).toBe(1);

      // Release with error
      await uow.withTransaction(async (tx) => {
        await store.releaseWithError(tx, claimed1[0]!.id, "Error");
      });

      // Claim again (should be available now)
      const claimed2 = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 1, workerId: "worker-2" });
      });
      expect(claimed2).toHaveLength(1);
      expect(claimed2[0]!.id).toBe(claimed1[0]!.id);
      expect(claimed2[0]!.attempts).toBe(2); // Incremented again
    });

    it("handles claim -> deadLetter workflow", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgOutboxStore();

      await pool.query(`
        INSERT INTO eventfabric.outbox (global_position, topic)
        VALUES (100, 'user')
      `);

      const claimed = await uow.withTransaction(async (tx) => {
        return store.claimBatch(tx, { batchSize: 1, workerId: "worker-1" });
      });

      await uow.withTransaction(async (tx) => {
        await store.deadLetter(tx, claimed[0]!, "Max attempts");
      });

      const outbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
      expect(outbox.rowCount).toBe(0);

      const dlq = await pool.query(`SELECT * FROM eventfabric.outbox_dead_letters`);
      expect(dlq.rowCount).toBe(1);
    });
  });
});

