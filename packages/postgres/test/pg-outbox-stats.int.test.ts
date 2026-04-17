import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgOutboxStatsService } from "../src/outbox/pg-outbox-stats";
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

describe("PgOutboxStatsService", () => {
  beforeEach(async () => {
    // Clean up before each test
    await pool.query(`DELETE FROM eventfabric.outbox`);
  }, 60000);

  it("returns empty stats for empty outbox", async () => {
    const service = new PgOutboxStatsService(pool);

    const stats = await service.getBacklogStats();

    expect(stats.totalPending).toBe(0);
    expect(stats.oldestPendingAt).toBeNull();
    expect(stats.oldestAgeSeconds).toBeNull();
    expect(stats.perTopic).toHaveLength(0);
  });

  it("counts total pending items", async () => {
    const service = new PgOutboxStatsService(pool);

    // Create some pending items
    await pool.query(`
      INSERT INTO eventfabric.outbox (global_position, topic, created_at)
      VALUES 
        (100, 'user', now()),
        (200, 'order', now()),
        (300, 'user', now())
    `);

    const stats = await service.getBacklogStats();

    expect(stats.totalPending).toBe(3);
  });

  it("excludes dead-lettered items from stats", async () => {
    const service = new PgOutboxStatsService(pool);

    // Create pending and dead-lettered items
    await pool.query(`
      INSERT INTO eventfabric.outbox (global_position, topic, created_at, dead_lettered_at)
      VALUES 
        (100, 'user', now(), NULL),
        (200, 'order', now(), now()),
        (300, 'user', now(), NULL)
    `);

    const stats = await service.getBacklogStats();

    expect(stats.totalPending).toBe(2);
    expect(stats.perTopic.every(t => t.topic === "user")).toBe(true);
  });

  it("calculates oldest pending item timestamp", async () => {
    const service = new PgOutboxStatsService(pool);

    const oldTime = new Date(Date.now() - 3600000); // 1 hour ago
    const recentTime = new Date(Date.now() - 1800000); // 30 minutes ago

    await pool.query(`
      INSERT INTO eventfabric.outbox (global_position, topic, created_at)
      VALUES 
        (100, 'user', $1::timestamptz),
        (200, 'order', $2::timestamptz)
    `, [oldTime.toISOString(), recentTime.toISOString()]);

    const stats = await service.getBacklogStats();

    expect(stats.oldestPendingAt).not.toBeNull();
    expect(stats.oldestPendingAt).toBe(oldTime.toISOString());
  });

  it("calculates oldest age in seconds", async () => {
    const service = new PgOutboxStatsService(pool);

    const twoHoursAgo = new Date(Date.now() - 7200000); // 2 hours ago

    await pool.query(`
      INSERT INTO eventfabric.outbox (global_position, topic, created_at)
      VALUES (100, 'user', $1::timestamptz)
    `, [twoHoursAgo.toISOString()]);

    const stats = await service.getBacklogStats();

    expect(stats.oldestAgeSeconds).not.toBeNull();
    expect(stats.oldestAgeSeconds).toBeGreaterThan(7000); // ~2 hours in seconds (with some tolerance)
    expect(stats.oldestAgeSeconds).toBeLessThan(7300);
  });

  it("groups stats by topic", async () => {
    const service = new PgOutboxStatsService(pool);

    // Create items with different topics
    await pool.query(`
      INSERT INTO eventfabric.outbox (global_position, topic, created_at)
      VALUES 
        (100, 'user', now()),
        (200, 'user', now()),
        (300, 'order', now()),
        (400, 'order', now()),
        (500, 'order', now()),
        (600, NULL, now())
    `);

    const stats = await service.getBacklogStats();

    expect(stats.perTopic).toHaveLength(3);
    
    // Should be ordered by count DESC
    expect(stats.perTopic[0]!.topic).toBe("order");
    expect(stats.perTopic[0]!.count).toBe(3);
    
    expect(stats.perTopic[1]!.topic).toBe("user");
    expect(stats.perTopic[1]!.count).toBe(2);
    
    expect(stats.perTopic[2]!.topic).toBeNull();
    expect(stats.perTopic[2]!.count).toBe(1);
  });

  it("handles null topics correctly", async () => {
    const service = new PgOutboxStatsService(pool);

    await pool.query(`
      INSERT INTO eventfabric.outbox (global_position, topic, created_at)
      VALUES 
        (100, NULL, now()),
        (200, NULL, now()),
        (300, 'user', now())
    `);

    const stats = await service.getBacklogStats();

    expect(stats.totalPending).toBe(3);
    const nullTopic = stats.perTopic.find(t => t.topic === null);
    expect(nullTopic).not.toBeUndefined();
    expect(nullTopic!.count).toBe(2);
  });

  it("includes locked items in pending count", async () => {
    const service = new PgOutboxStatsService(pool);

    await pool.query(`
      INSERT INTO eventfabric.outbox (global_position, topic, created_at, locked_at, locked_by)
      VALUES 
        (100, 'user', now(), now(), 'worker1'),
        (200, 'order', now(), NULL, NULL)
    `);

    const stats = await service.getBacklogStats();

    // Locked items are still pending (not dead-lettered)
    expect(stats.totalPending).toBe(2);
  });

  it("handles items with high attempt counts", async () => {
    const service = new PgOutboxStatsService(pool);

    await pool.query(`
      INSERT INTO eventfabric.outbox (global_position, topic, created_at, attempts, last_error)
      VALUES 
        (100, 'user', now(), 5, 'Some error'),
        (200, 'order', now(), 10, 'Another error')
    `);

    const stats = await service.getBacklogStats();

    expect(stats.totalPending).toBe(2);
    // High attempts don't exclude items from stats (only dead-lettered does)
  });
});

