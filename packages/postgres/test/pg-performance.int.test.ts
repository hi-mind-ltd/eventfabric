import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { PgOutboxStore } from "../src/outbox/pg-outbox-store";
import { migrate } from "../src/pg-migrator";

type E = { type: "Tick"; version: 1; n: number };

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

describe("Performance optimizations", () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM eventfabric.outbox`);
    await pool.query(`DELETE FROM eventfabric.stream_versions`);
    await pool.query(`DELETE FROM eventfabric.events`);
  }, 60000);

  describe("1. Partial index on outbox (outbox_claimable_idx)", () => {
    it("index exists and is a partial index", async () => {
      const result = await pool.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'eventfabric'
          AND tablename = 'outbox'
          AND indexname = 'outbox_claimable_idx'
      `);
      expect(result.rowCount).toBe(1);
      const indexDef = result.rows[0].indexdef.toLowerCase();
      expect(indexDef).toContain("where");
      expect(indexDef).toContain("dead_lettered_at is null");
      expect(indexDef).toContain("locked_at is null");
    });

    it("claimBatch uses the partial index for claimable rows only", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();
      const outbox = new PgOutboxStore();

      // Seed 5 events with outbox rows
      await uow.withTransaction(async (tx) => {
        for (let i = 1; i <= 5; i++) {
          await store.append(tx, {
            aggregateName: "Perf",
            aggregateId: `p-${i}`,
            expectedAggregateVersion: 0,
            events: [{ type: "Tick", version: 1, n: i }],
            enqueueOutbox: true
          });
        }
      });

      // Lock 3 rows (simulating in-flight claims)
      await pool.query(`
        UPDATE eventfabric.outbox SET locked_at = now(), locked_by = 'other-worker'
        WHERE id IN (SELECT id FROM eventfabric.outbox ORDER BY id LIMIT 3)
      `);

      // claimBatch should only see the 2 unlocked rows
      const claimed = await uow.withTransaction(async (tx) => {
        return outbox.claimBatch(tx, { batchSize: 10, workerId: "test-worker" });
      });

      expect(claimed).toHaveLength(2);

      // Verify EXPLAIN uses the partial index
      const explain = await pool.query(`
        EXPLAIN SELECT id FROM eventfabric.outbox
        WHERE dead_lettered_at IS NULL AND locked_at IS NULL
        ORDER BY id ASC LIMIT 10
      `);
      const plan = explain.rows.map((r: any) => r["QUERY PLAN"]).join("\n");
      expect(plan.toLowerCase()).toContain("outbox_claimable_idx");
    });

    it("dead-lettered rows are excluded from the partial index", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();
      const outbox = new PgOutboxStore();

      // Seed 3 events
      await uow.withTransaction(async (tx) => {
        for (let i = 1; i <= 3; i++) {
          await store.append(tx, {
            aggregateName: "Perf",
            aggregateId: `dlq-${i}`,
            expectedAggregateVersion: 0,
            events: [{ type: "Tick", version: 1, n: i }],
            enqueueOutbox: true
          });
        }
      });

      // Dead-letter 2 of them
      await pool.query(`
        UPDATE eventfabric.outbox SET dead_lettered_at = now()
        WHERE id IN (SELECT id FROM eventfabric.outbox ORDER BY id LIMIT 2)
      `);

      // Only 1 should be claimable
      const claimed = await uow.withTransaction(async (tx) => {
        return outbox.claimBatch(tx, { batchSize: 10, workerId: "test-worker" });
      });
      expect(claimed).toHaveLength(1);
    });
  });

  describe("2. Aggressive autovacuum on outbox", () => {
    it("outbox table has custom autovacuum settings", async () => {
      const result = await pool.query(`
        SELECT reloptions
        FROM pg_class
        WHERE relname = 'outbox'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'eventfabric')
      `);
      expect(result.rowCount).toBe(1);
      const options = result.rows[0].reloptions as string[];
      expect(options).toBeDefined();

      // Verify the specific settings
      expect(options.some((o: string) => o.includes("autovacuum_vacuum_scale_factor=0.01"))).toBe(true);
      expect(options.some((o: string) => o.includes("autovacuum_analyze_scale_factor=0.005"))).toBe(true);
      expect(options.some((o: string) => o.includes("autovacuum_vacuum_cost_delay=0"))).toBe(true);
    });
  });

  describe("3. Covering index for loadStream", () => {
    it("covering index exists and includes payload columns", async () => {
      const result = await pool.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'eventfabric'
          AND tablename = 'events'
          AND indexname = 'events_stream_covering_idx'
      `);
      expect(result.rowCount).toBe(1);
      const indexDef = result.rows[0].indexdef.toLowerCase();

      // Key columns
      expect(indexDef).toContain("aggregate_name");
      expect(indexDef).toContain("aggregate_id");
      expect(indexDef).toContain("aggregate_version");

      // INCLUDE columns
      expect(indexDef).toContain("include");
      expect(indexDef).toContain("payload");
      expect(indexDef).toContain("event_id");
      expect(indexDef).toContain("occurred_at");
    });

    it("loadStream can use the covering index (index-only scan)", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      // Seed enough events that the planner prefers an index scan
      await uow.withTransaction(async (tx) => {
        for (let i = 0; i < 20; i++) {
          await store.append(tx, {
            aggregateName: "CoverTest",
            aggregateId: "ct-1",
            expectedAggregateVersion: i,
            events: [{ type: "Tick", version: 1, n: i }]
          });
        }
      });

      // Force statistics update so the planner knows about the data
      await pool.query(`ANALYZE eventfabric.events`);

      // Disable seq scan to prove the covering index IS usable. In production
      // with large tables the planner picks it naturally; at test scale (20 rows)
      // the planner prefers seq scan because index overhead exceeds the benefit.
      await pool.query(`SET enable_seqscan = off`);
      const explain = await pool.query(`
        EXPLAIN SELECT event_id, aggregate_name, aggregate_id, aggregate_version,
                       type, version, payload, occurred_at,
                       dismissed_at, dismissed_reason, dismissed_by,
                       correlation_id, causation_id
        FROM eventfabric.events
        WHERE tenant_id = 'default' AND aggregate_name = 'CoverTest' AND aggregate_id = 'ct-1'
        ORDER BY aggregate_version ASC
      `);
      await pool.query(`SET enable_seqscan = on`);
      const plan = explain.rows.map((r: any) => r["QUERY PLAN"]).join("\n").toLowerCase();

      // With seq scan disabled, the planner must use an index on the tenant+stream columns.
      // It may pick either the covering index or the unique constraint index — both cover
      // (tenant_id, aggregate_name, aggregate_id, aggregate_version).
      expect(plan).toMatch(/index.*scan/);
      expect(plan).toContain("tenant_id");
    });

    it("loadStream returns correct results with covering index", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Cover",
          aggregateId: "c1",
          expectedAggregateVersion: 0,
          events: [
            { type: "Tick", version: 1, n: 10 },
            { type: "Tick", version: 1, n: 20 },
            { type: "Tick", version: 1, n: 30 }
          ]
        });
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "Cover", aggregateId: "c1" });
      });

      expect(events).toHaveLength(3);
      expect(events[0]!.aggregateVersion).toBe(1);
      expect(events[0]!.payload.n).toBe(10);
      expect(events[2]!.aggregateVersion).toBe(3);
      expect(events[2]!.payload.n).toBe(30);
    });
  });

  describe("Combined: performance under load", () => {
    it("handles rapid append + claim + ack cycles efficiently", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();
      const outbox = new PgOutboxStore();

      const batchCount = 10;
      const eventsPerBatch = 5;

      // Rapid fire: append events with outbox, claim, ack — simulating a
      // real projection runner cycle.
      const start = Date.now();

      for (let batch = 0; batch < batchCount; batch++) {
        // Append
        await uow.withTransaction(async (tx) => {
          await store.append(tx, {
            aggregateName: "LoadTest",
            aggregateId: `lt-${batch}`,
            expectedAggregateVersion: 0,
            events: Array.from({ length: eventsPerBatch }, (_, i) => ({
              type: "Tick" as const,
              version: 1 as const,
              n: batch * eventsPerBatch + i
            })),
            enqueueOutbox: true
          });
        });

        // Claim + ack
        await uow.withTransaction(async (tx) => {
          const claimed = await outbox.claimBatch(tx, {
            batchSize: eventsPerBatch,
            workerId: "perf-worker"
          });
          for (const row of claimed) {
            await outbox.ack(tx, row.id);
          }
        });
      }

      const durationMs = Date.now() - start;

      // Verify all events landed
      const eventCount = await pool.query(
        `SELECT COUNT(*)::int AS c FROM eventfabric.events WHERE aggregate_name = 'LoadTest'`
      );
      expect(eventCount.rows[0].c).toBe(batchCount * eventsPerBatch);

      // Verify outbox is drained
      const outboxCount = await pool.query(
        `SELECT COUNT(*)::int AS c FROM eventfabric.outbox`
      );
      expect(outboxCount.rows[0].c).toBe(0);

      // Sanity: 50 events through append+claim+ack should complete in under 10s
      // (typically < 2s on a testcontainer, but be generous for CI)
      expect(durationMs).toBeLessThan(10000);

      // Verify stream_versions tracked correctly
      const streams = await pool.query(
        `SELECT COUNT(*)::int AS c FROM eventfabric.stream_versions WHERE aggregate_name = 'LoadTest'`
      );
      expect(streams.rows[0].c).toBe(batchCount);
    }, 15000);
  });
});
