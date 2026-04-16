import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgDlqService } from "../src/outbox/pg-dlq-service";

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

describe("PgDlqService", () => {
  beforeEach(async () => {
    // Clean up before each test
    await pool.query(`DELETE FROM eventfabric.outbox_dead_letters`);
    await pool.query(`DELETE FROM eventfabric.outbox`);
  }, 60000);

  it("lists DLQ items with pagination", async () => {
    const service = new PgDlqService(pool);

    // Create some DLQ items
    await pool.query(`
      INSERT INTO eventfabric.outbox_dead_letters (outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
      VALUES 
        (1, 100, 'user', 3, 'Error 1', now() - interval '3 hours'),
        (2, 200, 'user', 5, 'Error 2', now() - interval '2 hours'),
        (3, 300, 'order', 2, 'Error 3', now() - interval '1 hour')
    `);

    const result = await service.list({ limit: 2, offset: 0 });
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.globalPosition).toBe(300n); // Most recent first
    expect(result.items[1]!.globalPosition).toBe(200n);

    const result2 = await service.list({ limit: 2, offset: 2 });
    expect(result2.items).toHaveLength(1);
    expect(result2.items[0]!.globalPosition).toBe(100n);
  });

  it("filters DLQ items by topic", async () => {
    const service = new PgDlqService(pool);

    // Create DLQ items for this test
    await pool.query(`
      INSERT INTO eventfabric.outbox_dead_letters (outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
      VALUES 
        (1, 100, 'user', 3, 'Error 1', now() - interval '3 hours'),
        (2, 200, 'user', 5, 'Error 2', now() - interval '2 hours'),
        (3, 300, 'order', 2, 'Error 3', now() - interval '1 hour')
    `);

    const result = await service.list({ topic: "user" });
    expect(result.total).toBe(2);
    expect(result.items.every(item => item.topic === "user")).toBe(true);

    const result2 = await service.list({ topic: "order" });
    expect(result2.total).toBe(1);
    expect(result2.items[0]!.topic).toBe("order");

    const result3 = await service.list({ topic: null });
    expect(result3.total).toBe(3); // All items
  });

  it("gets a single DLQ item by ID", async () => {
    const service = new PgDlqService(pool);

    const insertResult = await pool.query(`
      INSERT INTO eventfabric.outbox_dead_letters (outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
      VALUES (10, 1000, 'test', 7, 'Test error', now())
      RETURNING id
    `);
    const dlqId = Number(insertResult.rows[0].id);

    const item = await service.get(dlqId);
    expect(item).not.toBeNull();
    expect(item!.id).toBe(dlqId);
    expect(item!.outboxId).toBe(10);
    expect(item!.globalPosition).toBe(1000n);
    expect(item!.topic).toBe("test");
    expect(item!.attempts).toBe(7);
    expect(item!.lastError).toBe("Test error");
    expect(item!.deadLetteredAt).toBeTruthy();

    const notFound = await service.get(99999);
    expect(notFound).toBeNull();
  });

  it("requeues a DLQ item back to outbox", async () => {
    const service = new PgDlqService(pool);

    // Create a DLQ item
    const insertResult = await pool.query(`
      INSERT INTO eventfabric.outbox_dead_letters (outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
      VALUES (20, 2000, 'requeue-test', 3, 'Some error', now())
      RETURNING id
    `);
    const dlqId = Number(insertResult.rows[0].id);

    const result = await service.requeue(dlqId);
    expect(result.requeued).toBe(true);

    // Verify it's in outbox
    const outbox = await pool.query(`
      SELECT * FROM eventfabric.outbox WHERE global_position = 2000
    `);
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].topic).toBe("requeue-test");
    expect(outbox.rows[0].attempts).toBe(0); // Reset attempts
    expect(outbox.rows[0].locked_at).toBeNull();

    // Verify it's removed from DLQ
    const dlq = await pool.query(`SELECT * FROM eventfabric.outbox_dead_letters`);
    expect(dlq.rowCount).toBe(0);

    // Try to requeue non-existent item
    const notFound = await service.requeue(99999);
    expect(notFound.requeued).toBe(false);
    expect(notFound.reason).toBe("DLQ item not found");
  });

  it("requeues by global position", async () => {
    const service = new PgDlqService(pool);

    // Create a DLQ item
    await pool.query(`
      INSERT INTO eventfabric.outbox_dead_letters (outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
      VALUES (30, 3000, 'position-test', 4, 'Error', now())
    `);

    const result = await service.requeueByGlobalPosition(3000n);
    expect(result.requeued).toBe(true);

    // Verify it's in outbox
    const outbox = await pool.query(`
      SELECT * FROM eventfabric.outbox WHERE global_position = 3000
    `);
    expect(outbox.rowCount).toBe(1);

    // Try to requeue non-existent position
    const notFound = await service.requeueByGlobalPosition(99999n);
    expect(notFound.requeued).toBe(false);
    expect(notFound.reason).toBe("DLQ item not found");
  }, 10000);

  it("requeues a range of DLQ items", async () => {
    const service = new PgDlqService(pool);

    // Create multiple DLQ items
    await pool.query(`
      INSERT INTO eventfabric.outbox_dead_letters (outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
      VALUES 
        (40, 4000, 'range-test', 1, 'Error 1', now()),
        (41, 4001, 'range-test', 2, 'Error 2', now()),
        (42, 4002, 'other-topic', 3, 'Error 3', now()),
        (43, 4003, 'range-test', 4, 'Error 4', now())
    `);

    // Requeue range (note: interface doesn't support topic filter in requeueRange)
    const result = await service.requeueRange(4000n, 4003n);
    expect(result.requeued).toBe(4); // All 4 items in range

    // Verify they're in outbox
    const outbox = await pool.query(`
      SELECT * FROM eventfabric.outbox WHERE global_position IN (4000, 4001, 4002, 4003)
    `);
    expect(outbox.rowCount).toBe(4);
  }, 15000);

  it("requeues all items in range", async () => {
    const service = new PgDlqService(pool);

    // Create multiple DLQ items
    await pool.query(`
      INSERT INTO eventfabric.outbox_dead_letters (outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
      VALUES 
        (50, 5000, 'limit-test', 1, 'Error', now()),
        (51, 5001, 'limit-test', 2, 'Error', now()),
        (52, 5002, 'limit-test', 3, 'Error', now())
    `);

    const result = await service.requeueRange(5000n, 5002n);
    expect(result.requeued).toBe(3);

    // Verify all were requeued
    const outbox = await pool.query(`
      SELECT * FROM eventfabric.outbox WHERE global_position BETWEEN 5000 AND 5002
    `);
    expect(outbox.rowCount).toBe(3);
  }, 15000);

  it("purges DLQ items by topic", async () => {
    const service = new PgDlqService(pool);

    // Create DLQ items with different topics
    await pool.query(`
      INSERT INTO eventfabric.outbox_dead_letters (outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
      VALUES 
        (60, 6000, 'purge-test', 5, 'Error', now()),
        (61, 6001, 'purge-test', 6, 'Error', now()),
        (62, 6002, 'other-topic', 7, 'Error', now())
    `);

    // Purge by topic
    const result = await service.purge({ topic: "purge-test" });
    expect(result.purged).toBe(2);

    // Verify only items with that topic are deleted
    const remaining = await pool.query(`
      SELECT * FROM eventfabric.outbox_dead_letters WHERE topic = 'other-topic'
    `);
    expect(remaining.rowCount).toBe(1);

    // Purge all remaining
    const result2 = await service.purge();
    expect(result2.purged).toBe(1);
  }, 15000);

  it("purges all DLQ items when no filter provided", async () => {
    const service = new PgDlqService(pool);

    // Create some DLQ items
    await pool.query(`
      INSERT INTO eventfabric.outbox_dead_letters (outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
      VALUES 
        (70, 7000, 'purge-all-1', 1, 'Error', now()),
        (71, 7001, 'purge-all-1', 2, 'Error', now()),
        (72, 7002, 'purge-all-2', 3, 'Error', now())
    `);

    // Purge all (no filter)
    const result = await service.purge();
    expect(result.purged).toBe(3);

    // Verify all are gone
    const all = await pool.query(`SELECT * FROM eventfabric.outbox_dead_letters`);
    expect(all.rowCount).toBe(0);
  }, 15000);

  it("handles empty DLQ gracefully", async () => {
    const service = new PgDlqService(pool);

    const list = await service.list();
    expect(list.total).toBe(0);
    expect(list.items).toHaveLength(0);

    const get = await service.get(999);
    expect(get).toBeNull();

    const requeue = await service.requeue(999);
    expect(requeue.requeued).toBe(false);

    const purge = await service.purge();
    expect(purge.purged).toBe(0);
  }, 15000);

  it("handles ON CONFLICT when requeuing duplicate global positions", async () => {
    const service = new PgDlqService(pool);

    // Create DLQ item
    const insertResult = await pool.query(`
      INSERT INTO eventfabric.outbox_dead_letters (outbox_id, global_position, topic, attempts, last_error, dead_lettered_at)
      VALUES (80, 8000, 'duplicate-test', 1, 'Error', now())
      RETURNING id
    `);
    const dlqId = Number(insertResult.rows[0].id);

    // Create existing outbox item with same global position
    await pool.query(`
      INSERT INTO eventfabric.outbox (global_position, topic)
      VALUES (8000, 'existing')
    `);

    // Requeue should succeed (ON CONFLICT DO NOTHING)
    const result = await service.requeue(dlqId);
    expect(result.requeued).toBe(true);

    // DLQ item should still be deleted
    const dlq = await pool.query(`SELECT * FROM eventfabric.outbox_dead_letters`);
    expect(dlq.rowCount).toBe(0);

    // Outbox should still have the original item
    const outbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].topic).toBe("existing");
  }, 15000);
});

