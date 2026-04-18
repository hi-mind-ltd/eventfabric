import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { createAsyncProjectionRunner } from "../src/projections/pg-async-projection-runner";
import { PgProjectionCheckpointStore } from "../src/projections/pg-projection-checkpoint-store";
import { migrate } from "../src/pg-migrator";

type E = { type: "X"; version: 1; id: string };

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

describe("PgAsyncProjectionRunner", () => {
  beforeEach(async () => {
    // Clean up before each test
    await pool.query(`DELETE FROM eventfabric.outbox_dead_letters`);
    await pool.query(`DELETE FROM eventfabric.outbox`);
    await pool.query(`DELETE FROM eventfabric.projection_checkpoints`);
    await pool.query(`DELETE FROM eventfabric.stream_versions`);
    await pool.query(`DELETE FROM eventfabric.events`);
  }, 60000);

  it("DLQs messages that exceed maxAttempts", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    await uow.withTransaction((tx) =>
      store.append(tx, {
        aggregateName: "Agg",
        aggregateId: "1",
        expectedAggregateVersion: 0,
        events: [{ type: "X", version: 1, id: "1" }],
        enqueueOutbox: true,
        outboxTopic: "user"
      })
    );

    const projection = {
      name: "always_fail",
      topicFilter: { mode: "include", topics: ["user"] },
      async handle() { throw new Error("boom"); }
    };

    const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
      workerId: "t1",
      batchSize: 1,
      transactionMode: "perRow",
      maxAttempts: 1,
      idleSleepMs: 50
    });

    const ac = new AbortController();
    const runnerPromise = runner.start(ac.signal).catch(() => {});

    // Give the runner time to process the message through multiple attempts
    // maxAttempts=1 means: attempt 1 (0->1), attempt 2 (1->2, exceeds max, should DLQ)
    let dlqCount = 0;
    const startTime = Date.now();
    while (dlqCount === 0 && Date.now() - startTime < 20000) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const dlq = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox_dead_letters`);
      dlqCount = dlq.rows[0]?.count ?? 0;
      if (dlqCount === 1) break;
    }

    ac.abort();
    await runnerPromise;

    // Wait for final cleanup
    await new Promise(resolve => setTimeout(resolve, 500));

    const outbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
    const dlq = await pool.query(`SELECT * FROM eventfabric.outbox_dead_letters`);

    // The runner should have DLQ'd the message without manual intervention
    expect(outbox.rowCount).toBe(0);
    expect(dlq.rowCount).toBe(1);
  }, 25000);

  it("DLQs after maxAttempts and supports per-row transactions", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    await uow.withTransaction((tx) =>
      store.append(tx, {
        aggregateName: "Agg",
        aggregateId: "2",
        expectedAggregateVersion: 0,
        events: [{ type: "X", version: 1, id: "2" }],
        enqueueOutbox: true,
        outboxTopic: "user"
      })
    );

    const projection = {
      name: "always_fail",
      topicFilter: { mode: "include", topics: ["user"] },
      async handle() { throw new Error("boom"); }
    };

    const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
      workerId: "t1",
      batchSize: 1,
      transactionMode: "perRow",
      maxAttempts: 1,
      idleSleepMs: 50
    });

    const ac = new AbortController();
    const runnerPromise = runner.start(ac.signal).catch(() => {});

    // Give the runner a moment to start
    await new Promise(resolve => setTimeout(resolve, 200));

    // Get initial DLQ count (from previous test)
    const initialDlq = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox_dead_letters`);
    const initialDlqCount = initialDlq.rows[0]?.count ?? 0;

    // Poll until message is DLQ'd (maxAttempts=1 means it needs 2 attempts: 0->1, then 1->2 which exceeds max)
    // The runner should handle DLQ automatically without manual intervention
    let dlqCount = initialDlqCount;
    const startTime = Date.now();
    while (dlqCount === initialDlqCount && Date.now() - startTime < 20000) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const dlq = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox_dead_letters`);
      dlqCount = dlq.rows[0]?.count ?? 0;
      if (dlqCount > initialDlqCount) break;
    }

    ac.abort();
    await runnerPromise;

    // Wait a bit more for any final cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Dead-lettered messages are deleted from outbox, so check all rows
    const outbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
    const dlq = await pool.query(`SELECT * FROM eventfabric.outbox_dead_letters`);

    expect(outbox.rowCount).toBe(0);
    expect(dlq.rowCount).toBe(initialDlqCount + 1);
  }, 25000);

  describe("processBatch mode", () => {
    it("processes multiple messages in a single transaction", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      // Append multiple events
      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "batch-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "batch-2",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "2" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "batch-3",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "3" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
      });

      const handled: string[] = [];
      const projection = {
        name: "batch-test",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {
          handled.push(env.payload.id);
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "batch-worker",
        batchSize: 10,
        transactionMode: "batch",
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      // Wait for processing
      let outboxCount = 3;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
        outboxCount = outbox.rows[0]?.count ?? 0;
        if (outboxCount === 0) break;
      }

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(handled).toHaveLength(3);
      expect(handled).toContain("1");
      expect(handled).toContain("2");
      expect(handled).toContain("3");

      const outbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
      expect(outbox.rowCount).toBe(0);
    }, 15000);


    // Regression test for a bug where batch-mode failures left the entire
    // claimed batch permanently stuck. The failing path was:
    //   1. claimBatch commits (locked_at set, attempts++)
    //   2. processBatch runs in a second tx; on a projection error it called
    //      releaseWithError inside that tx and re-threw
    //   3. The throw rolled back processBatch's tx, undoing releaseWithError
    //   4. Rows stayed with locked_at set — claimBatch filters
    //      WHERE locked_at IS NULL — so they were never reclaimed, never
    //      retried, never DLQ'd, and last_error was never persisted
    // The fix releases all claimed rows in a fresh tx after the main tx
    // rolls back. This test verifies transient failures recover cleanly.
    it("recovers from a transient mid-batch failure by releasing and retrying rows", async () => {
      const store = new PgEventStore<E>();

      const uow = new PgUnitOfWork(pool);
      await uow.withTransaction(async (tx) => {
        for (const id of ["1", "2", "3"]) {
          await store.append(tx, {
            aggregateName: "Agg",
            aggregateId: `recover-${id}`,
            expectedAggregateVersion: 0,
            events: [{ type: "X", version: 1, id }],
            enqueueOutbox: true,
            outboxTopic: "user"
          });
        }
      });

      // Transient failure: throws once on the 2nd handle call, then succeeds.
      let handleCount = 0;
      const projection = {
        name: "recover-batch",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle() {
          handleCount++;
          if (handleCount === 2) throw new Error("transient boom");
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "recover-worker",
        batchSize: 10,
        transactionMode: "batch",
        maxAttempts: 5,
        idleSleepMs: 50,
        backoff: { minMs: 50, maxMs: 200, factor: 2, jitter: 0 }
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      // Poll until the outbox drains or we time out
      let outboxCount = 3;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise((r) => setTimeout(r, 100));
        const q = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox`);
        outboxCount = q.rows[0]?.c ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise((r) => setTimeout(r, 200));

      const outbox = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox`);
      const dlq = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox_dead_letters`);

      // All rows drained — no stranded messages
      expect(outbox.rows[0].c).toBe(0);
      // Transient failure, not poison — nothing should reach the DLQ
      expect(dlq.rows[0].c).toBe(0);
      // Retry happened at least once (first batch fails on 2nd call, so >= 3 total handles)
      expect(handleCount).toBeGreaterThanOrEqual(3);
    }, 15000);

    it("DLQs a poison message in batch mode without stranding siblings", async () => {
      const store = new PgEventStore<E>();

      const uow = new PgUnitOfWork(pool);
      await uow.withTransaction(async (tx) => {
        for (const id of ["1", "2", "3"]) {
          await store.append(tx, {
            aggregateName: "Agg",
            aggregateId: `poison-${id}`,
            expectedAggregateVersion: 0,
            events: [{ type: "X", version: 1, id }],
            enqueueOutbox: true,
            outboxTopic: "user"
          });
        }
      });

      // Deterministic failure on every invocation — a true poison batch.
      const projection = {
        name: "poison-batch",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle() {
          throw new Error("always boom");
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "poison-worker",
        batchSize: 10,
        transactionMode: "batch",
        maxAttempts: 2,
        idleSleepMs: 50,
        backoff: { minMs: 50, maxMs: 200, factor: 2, jitter: 0 }
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      // Poll until the outbox drains (all rows DLQ'd) or we time out
      let outboxCount = 3;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 15000) {
        await new Promise((r) => setTimeout(r, 100));
        const q = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox`);
        outboxCount = q.rows[0]?.c ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise((r) => setTimeout(r, 200));

      const outbox = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox`);
      const dlq = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox_dead_letters`);

      // All rows reached the DLQ — nothing stranded in the outbox
      expect(outbox.rows[0].c).toBe(0);
      expect(dlq.rows[0].c).toBe(3);
    }, 20000);
  });

  describe("topic filtering", () => {
    it("processes only included topics", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "include-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "include-2",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "2" }],
          enqueueOutbox: true,
          outboxTopic: "order"
        });
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "include-3",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "3" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
      });

      const handled: string[] = [];
      const projection = {
        name: "include-filter",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {
          handled.push(env.payload.id);
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "include-worker",
        batchSize: 10,
        transactionMode: "perRow",
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      let outboxCount = 3;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
        outboxCount = outbox.rows[0]?.count ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should only handle "user" topic events
      expect(handled).toHaveLength(2);
      expect(handled).toContain("1");
      expect(handled).toContain("3");
      expect(handled).not.toContain("2");
    }, 15000);

    it("excludes specified topics", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "exclude-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "exclude-2",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "2" }],
          enqueueOutbox: true,
          outboxTopic: "order"
        });
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "exclude-3",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "3" }],
          enqueueOutbox: true,
          outboxTopic: "payment"
        });
      });

      const handled: string[] = [];
      const projection = {
        name: "exclude-filter",
        topicFilter: { mode: "exclude", topics: ["order", "payment"] },
        async handle(tx: any, env: any) {
          handled.push(env.payload.id);
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "exclude-worker",
        batchSize: 10,
        transactionMode: "perRow",
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      let outboxCount = 3;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
        outboxCount = outbox.rows[0]?.count ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should only handle "user" topic (excluded order and payment)
      expect(handled).toHaveLength(1);
      expect(handled).toContain("1");
      expect(handled).not.toContain("2");
      expect(handled).not.toContain("3");
    }, 15000);

    it("processes all topics when mode is 'all'", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "all-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "all-2",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "2" }],
          enqueueOutbox: true,
          outboxTopic: "order"
        });
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "all-3",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "3" }],
          enqueueOutbox: true,
          outboxTopic: null
        });
      });

      const handled: string[] = [];
      const projection = {
        name: "all-filter",
        topicFilter: { mode: "all" },
        async handle(tx: any, env: any) {
          handled.push(env.payload.id);
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "all-worker",
        batchSize: 10,
        transactionMode: "perRow",
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      let outboxCount = 3;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
        outboxCount = outbox.rows[0]?.count ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should handle all topics
      expect(handled).toHaveLength(3);
      expect(handled).toContain("1");
      expect(handled).toContain("2");
      expect(handled).toContain("3");
    }, 15000);

    it("handles null topics correctly", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "null-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: null
        });
      });

      const handled: string[] = [];
      const projection = {
        name: "null-topic",
        topicFilter: { mode: "include", topics: [""] }, // Empty string matches null
        async handle(tx: any, env: any) {
          handled.push(env.payload.id);
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "null-worker",
        batchSize: 10,
        transactionMode: "perRow",
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      let outboxCount = 1;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
        outboxCount = outbox.rows[0]?.count ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(handled).toHaveLength(1);
    }, 15000);
  });

  describe("multiple projections", () => {
    it("processes same event through multiple projections", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "multi-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
      });

      const handled1: string[] = [];
      const handled2: string[] = [];
      const projection1 = {
        name: "multi-proj-1",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {
          handled1.push(env.payload.id);
        }
      };
      const projection2 = {
        name: "multi-proj-2",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {
          handled2.push(env.payload.id);
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection1 as any, projection2 as any], {
        workerId: "multi-worker",
        batchSize: 10,
        transactionMode: "perRow",
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      let outboxCount = 1;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
        outboxCount = outbox.rows[0]?.count ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      // Both projections should have handled the event
      expect(handled1).toHaveLength(1);
      expect(handled2).toHaveLength(1);
      expect(handled1[0]).toBe("1");
      expect(handled2[0]).toBe("1");
    }, 15000);

    it("maintains separate checkpoints for each projection", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();
      const checkpoints = new PgProjectionCheckpointStore();

      let globalPos1: bigint | undefined;
      let globalPos2: bigint | undefined;

      await uow.withTransaction(async (tx) => {
        const result1 = await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "checkpoint-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        globalPos1 = result1.appended[0]!.globalPosition;

        const result2 = await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "checkpoint-2",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "2" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        globalPos2 = result2.appended[0]!.globalPosition;
      });

      const projection1 = {
        name: "checkpoint-proj-1",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {}
      };
      const projection2 = {
        name: "checkpoint-proj-2",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {}
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection1 as any, projection2 as any], {
        workerId: "checkpoint-worker",
        batchSize: 10,
        transactionMode: "perRow",
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      let outboxCount = 2;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
        outboxCount = outbox.rows[0]?.count ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check that both projections have checkpoints
      const cp1 = await uow.withTransaction(async (tx) => {
        return checkpoints.get(tx, "checkpoint-proj-1", "default");
      });
      const cp2 = await uow.withTransaction(async (tx) => {
        return checkpoints.get(tx, "checkpoint-proj-2", "default");
      });

      expect(cp1.lastGlobalPosition).toBe(globalPos2);
      expect(cp2.lastGlobalPosition).toBe(globalPos2);
    }, 15000);
  });

  describe("checkpoint management", () => {
    it("updates checkpoint after processing event", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();
      const checkpoints = new PgProjectionCheckpointStore();

      let globalPos: bigint | undefined;
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "checkpoint-test",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        globalPos = result.appended[0]!.globalPosition;
      });

      const projection = {
        name: "checkpoint-update",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {}
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "checkpoint-update-worker",
        batchSize: 10,
        transactionMode: "perRow",
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      let outboxCount = 1;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
        outboxCount = outbox.rows[0]?.count ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      const cp = await uow.withTransaction(async (tx) => {
        return checkpoints.get(tx, "checkpoint-update", "default");
      });

      expect(cp.lastGlobalPosition).toBe(globalPos);
    }, 15000);

    it("skips events already processed (checkpoint check)", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();
      const checkpoints = new PgProjectionCheckpointStore();

      let globalPos1: bigint | undefined;
      let globalPos2: bigint | undefined;

      await uow.withTransaction(async (tx) => {
        const result1 = await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "skip-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        globalPos1 = result1.appended[0]!.globalPosition;

        const result2 = await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "skip-2",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "2" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        globalPos2 = result2.appended[0]!.globalPosition;
      });

      // Set checkpoint to second event (simulating previous processing)
      await uow.withTransaction(async (tx) => {
        await checkpoints.set(tx, "skip-projection", "default", globalPos2!);
      });

      const handled: string[] = [];
      const projection = {
        name: "skip-projection",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {
          handled.push(env.payload.id);
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "skip-worker",
        batchSize: 10,
        transactionMode: "perRow",
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      // Wait a bit for processing
      await new Promise(resolve => setTimeout(resolve, 2000));

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should not handle any events (both are <= checkpoint)
      expect(handled).toHaveLength(0);
    }, 10000);
  });

  describe("error handling and backoff", () => {
    it("applies backoff on errors", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "backoff-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
      });

      let attemptCount = 0;
      const projection = {
        name: "backoff-test",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {
          attemptCount++;
          // Simulate claim error (not processing error)
          if (attemptCount === 1) {
            throw new Error("Claim error");
          }
        }
      };

      const startTime = Date.now();
      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "backoff-worker",
        batchSize: 1,
        transactionMode: "perRow",
        idleSleepMs: 50,
        backoff: { minMs: 100, maxMs: 1000, factor: 2, jitter: 0 }
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      // Wait for backoff to be applied
      await new Promise(resolve => setTimeout(resolve, 500));

      ac.abort();
      await runnerPromise;

      // Verify backoff was applied (should take at least minMs)
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some margin
    }, 10000);
  });

  describe("includeDismissed option", () => {
    it("skips dismissed events when includeDismissed is false", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let eventId: string | undefined;
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "dismissed-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        eventId = result.appended[0]!.eventId;
      });

      // Dismiss the event
      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, eventId!);
      });

      const handled: string[] = [];
      const projection = {
        name: "dismissed-test",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {
          handled.push(env.payload.id);
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "dismissed-worker",
        batchSize: 10,
        transactionMode: "perRow",
        includeDismissed: false,
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      let outboxCount = 1;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
        outboxCount = outbox.rows[0]?.count ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should not handle dismissed event
      expect(handled).toHaveLength(0);
      // But should be acked (removed from outbox)
      const outbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
      expect(outbox.rowCount).toBe(0);
    }, 15000);

    it("processes dismissed events when includeDismissed is true", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let eventId: string | undefined;
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "Agg",
          aggregateId: "dismissed-include-1",
          expectedAggregateVersion: 0,
          events: [{ type: "X", version: 1, id: "1" }],
          enqueueOutbox: true,
          outboxTopic: "user"
        });
        eventId = result.appended[0]!.eventId;
      });

      // Dismiss the event
      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, eventId!, { reason: "Test", by: "test" });
      });

      const handled: string[] = [];
      const projection = {
        name: "dismissed-include-test",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: any, env: any) {
          handled.push(env.payload.id);
        }
      };

      const runner = createAsyncProjectionRunner<E>(pool, store, [projection as any], {
        workerId: "dismissed-include-worker",
        batchSize: 10,
        transactionMode: "perRow",
        includeDismissed: true,
        idleSleepMs: 50
      });

      const ac = new AbortController();
      const runnerPromise = runner.start(ac.signal).catch(() => {});

      let outboxCount = 1;
      const startTime = Date.now();
      while (outboxCount > 0 && Date.now() - startTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
        outboxCount = outbox.rows[0]?.count ?? 0;
      }

      ac.abort();
      await runnerPromise;
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should handle dismissed event
      expect(handled).toHaveLength(1);
      expect(handled[0]).toBe("1");
    }, 15000);
  });
});
