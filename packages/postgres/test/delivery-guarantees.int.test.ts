/**
 * Delivery-guarantee regression tests for the async outbox runner, the
 * catch-up projector, and the DLQ service.
 *
 * Each test asserts the behaviour the docs promise ("if the event is committed
 * to the event log, it will eventually be delivered") under a scenario the
 * existing suites do not exercise. They are written against the CORRECT
 * behaviour, so they currently FAIL on 0.3.0 — each failure maps to a known
 * defect:
 *
 *   1. Late commits: global_position is assigned at INSERT (BIGSERIAL), not at
 *      COMMIT. Both runners treat "position <= checkpoint" as "already done",
 *      so an event that commits after a higher position was processed is
 *      skipped (and its outbox row deleted).
 *   2. Stranded outbox rows: claimBatch commits locked_at in its own tx and
 *      only reclaims rows WHERE locked_at IS NULL — there is no lease expiry,
 *      and several code paths leave claimed rows locked.
 *   3. DLQ requeue is a no-op: the requeued row is acked without the handler
 *      running because the checkpoint has already moved past it.
 *   4. Competing runners: runners sharing the outbox steal each other's rows
 *      (different projections) or skip each other's rows via the shared
 *      checkpoint (replicas of the same runner).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import type { EventEnvelope } from "@eventfabric/core";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { createAsyncProjectionRunner } from "../src/projections/pg-async-projection-runner";
import { createCatchUpProjector } from "../src/projections/pg-catch-up-projector";
import { PgOutboxStore } from "../src/outbox/pg-outbox-store";
import { PgDlqService } from "../src/outbox/pg-dlq-service";
import { migrate } from "../src/pg-migrator";
import { endPool } from "./helpers/end-pool";

type E = { type: "X"; version: 1; id: string };

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
  await migrate(pool);
}, 60000);

afterAll(async () => {
  if (pool) await endPool(pool);
  if (container) await container.stop();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const store = new PgEventStore<E>();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 5000, stepMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await delay(stepMs);
  }
  return pred();
}

async function appendOne(id: string, topic: string | null = "t"): Promise<bigint> {
  const uow = new PgUnitOfWork(pool);
  const res = await uow.withTransaction((tx) =>
    store.append(tx, {
      aggregateName: "Agg",
      aggregateId: id,
      expectedAggregateVersion: 0,
      events: [{ type: "X", version: 1, id }],
      enqueueOutbox: true,
      outboxTopic: topic
    })
  );
  return res.appended[0]!.globalPosition;
}

/**
 * Start an append in its own transaction and hold the transaction open.
 * Resolves `position` once the INSERT has run (position allocated); the tx
 * commits only when `commit()` is called.
 */
function appendHeldOpen(id: string) {
  const gate = deferred();
  let gotPosition!: (p: bigint) => void;
  const position = new Promise<bigint>((r) => (gotPosition = r));
  const uow = new PgUnitOfWork(pool);
  const done = uow.withTransaction(async (tx) => {
    const res = await store.append(tx, {
      aggregateName: "Agg",
      aggregateId: id,
      expectedAggregateVersion: 0,
      events: [{ type: "X", version: 1, id }],
      enqueueOutbox: true,
      outboxTopic: "t"
    });
    gotPosition(res.appended[0]!.globalPosition);
    await gate.promise;
  });
  return {
    position,
    commit: async () => {
      gate.resolve();
      await done;
    }
  };
}

async function outboxCount(): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox`);
  return r.rows[0].c;
}

async function lockedOutboxCount(): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox WHERE locked_at IS NOT NULL`);
  return r.rows[0].c;
}

async function dlqCount(): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.outbox_dead_letters`);
  return r.rows[0].c;
}

function startRunner(
  projections: any[],
  opts: Partial<Parameters<typeof createAsyncProjectionRunner>[3]> & { workerId: string }
) {
  const runner = createAsyncProjectionRunner<E>(pool, store, projections, {
    batchSize: 10,
    idleSleepMs: 20,
    backoff: { minMs: 10, maxMs: 50, factor: 2, jitter: 0 },
    ...opts
  });
  const ac = new AbortController();
  const done = runner.start(ac.signal).catch(() => {});
  return {
    ac,
    stop: async () => {
      ac.abort();
      await done;
    },
    done
  };
}

function recordingProjection(name: string, handled: string[], extra?: (env: EventEnvelope<E>) => Promise<void> | void) {
  return {
    name,
    topicFilter: { mode: "all" as const },
    async handle(_tx: unknown, env: EventEnvelope<E>) {
      if (extra) await extra(env);
      handled.push(env.payload.id);
    }
  };
}

beforeEach(async () => {
  await pool.query(`DELETE FROM eventfabric.outbox_dead_letters`);
  await pool.query(`DELETE FROM eventfabric.outbox`);
  await pool.query(`DELETE FROM eventfabric.projection_checkpoints`);
  await pool.query(`DELETE FROM eventfabric.stream_versions`);
  await pool.query(`DELETE FROM eventfabric.events`);
}, 60000);

// ---------------------------------------------------------------------------
// 1. Late commits (position allocated at INSERT, visible at COMMIT)
// ---------------------------------------------------------------------------

describe("late-committing events", () => {
  it("async runner delivers an event whose tx commits after a higher position was processed", async () => {
    const slow = appendHeldOpen("late");
    const latePos = await slow.position;
    const fastPos = await appendOne("fast");
    expect(fastPos).toBeGreaterThan(latePos);

    const handled: string[] = [];
    const r = startRunner([recordingProjection("late-async", handled)], {
      workerId: "late-w",
      transactionMode: "perRow"
    });

    // Runner sees only "fast" (the "late" row is not yet visible).
    expect(await waitFor(() => handled.includes("fast"))).toBe(true);

    // Now the earlier position becomes visible.
    await slow.commit();

    await waitFor(async () => (await outboxCount()) === 0);
    await r.stop();

    // BUG: "late" is <= checkpoint(fast) so it is skipped and its outbox row acked.
    expect(handled).toContain("late");
  }, 20000);

  it("catch-up projector processes an event whose tx commits after the checkpoint passed it", async () => {
    const projector = createCatchUpProjector<E>(pool, store);
    const handled: string[] = [];
    const projection = recordingProjection("late-catchup", handled);

    const slow = appendHeldOpen("late");
    const latePos = await slow.position;
    const fastPos = await appendOne("fast");
    expect(fastPos).toBeGreaterThan(latePos);

    // While "late" is in flight the high water mark must hold below it, so
    // the checkpoint cannot jump past it ("fast" waits too).
    await projector.catchUpProjection(projection as any, { highWaterMarkWaitMs: 200 });
    expect(handled).toEqual([]);

    await slow.commit();
    await projector.catchUpProjection(projection as any);

    // Previously: loadGlobal read global_position > checkpoint with no upper
    // bound, so "fast" advanced the checkpoint and "late" was never read.
    expect(handled).toEqual(["late", "fast"]);
  }, 20000);
});

// ---------------------------------------------------------------------------
// 2. Stranded outbox rows (no lease expiry; paths that leave rows locked)
// ---------------------------------------------------------------------------

describe("stranded outbox rows", () => {
  it("reclaims rows left locked by a worker that crashed after claiming", async () => {
    await appendOne("orphaned-claim");

    // Simulate a worker that claimed the row (claim tx committed) and then died.
    const uow = new PgUnitOfWork(pool);
    const outbox = new PgOutboxStore();
    const claimed = await uow.withTransaction((tx) => outbox.claimBatch(tx, { batchSize: 10, workerId: "dead-worker" }));
    expect(claimed).toHaveLength(1);
    // Make the lock unambiguously stale for any sane lease duration.
    await pool.query(`UPDATE eventfabric.outbox SET locked_at = now() - interval '1 day'`);

    const handled: string[] = [];
    const r = startRunner([recordingProjection("crash-recovery", handled)], {
      workerId: "live-worker",
      transactionMode: "perRow"
    });
    await waitFor(() => handled.includes("orphaned-claim"), 3000);
    await r.stop();

    // BUG: claimBatch only picks locked_at IS NULL; nothing ever expires a lock.
    expect(handled).toContain("orphaned-claim");
    expect(await outboxCount()).toBe(0);
  }, 20000);

  it("perRow: a handler failure does not strand the other rows of the claimed batch", async () => {
    await appendOne("a");
    await appendOne("b");
    await appendOne("c");

    let failedOnce = false;
    const handled: string[] = [];
    const projection = recordingProjection("perrow-strand", handled, (env) => {
      if (env.payload.id === "a" && !failedOnce) {
        failedOnce = true;
        throw new Error("transient");
      }
    });

    const r = startRunner([projection], { workerId: "strand-w", transactionMode: "perRow", batchSize: 3 });
    await waitFor(async () => (await outboxCount()) === 0, 5000);
    await r.stop();

    // BUG: processOne rethrows, the for-loop in start() exits, and rows b/c stay
    // locked forever (only row a is released).
    expect(await lockedOutboxCount()).toBe(0);
    expect(handled).toEqual(expect.arrayContaining(["a", "b", "c"]));
  }, 20000);

  it("perRow: aborting mid-batch releases the unprocessed claimed rows", async () => {
    await appendOne("a");
    await appendOne("b");
    await appendOne("c");

    const handled: string[] = [];
    let r!: ReturnType<typeof startRunner>;
    const projection = recordingProjection("perrow-abort", handled, (env) => {
      if (env.payload.id === "a") r.ac.abort(); // graceful shutdown (SIGTERM) mid-batch
    });
    r = startRunner([projection], { workerId: "abort-w", transactionMode: "perRow", batchSize: 3 });
    await r.done;

    expect(handled).toEqual(["a"]);
    // BUG: `if (signal.aborted) break;` leaves b and c locked by abort-w forever,
    // so no other worker (or a restart of this one) can ever claim them.
    expect(await lockedOutboxCount()).toBe(0);
  }, 20000);

  it("batch mode: an outbox row whose event cannot be loaded is dead-lettered, not left locked", async () => {
    await appendOne("real");
    // Orphan outbox row pointing at a position with no event (e.g. partition
    // dropped, manual cleanup). perRow mode DLQs this; batch mode should too.
    await pool.query(
      `INSERT INTO eventfabric.outbox (global_position, topic) VALUES (999999999, 't')`
    );

    const handled: string[] = [];
    const r = startRunner([recordingProjection("batch-orphan", handled)], {
      workerId: "orphan-w",
      transactionMode: "batch"
    });
    await waitFor(async () => (await outboxCount()) === 0, 3000);
    await r.stop();

    expect(handled).toEqual(["real"]);
    // BUG: processBatch only iterates loaded envelopes; the orphan row is never
    // acked, released, or dead-lettered — it stays locked forever.
    expect(await lockedOutboxCount()).toBe(0);
    expect(await dlqCount()).toBe(1);
  }, 20000);
});

// ---------------------------------------------------------------------------
// 3. DLQ requeue
// ---------------------------------------------------------------------------

describe("DLQ requeue", () => {
  it("re-runs the handler for a requeued dead letter after later events advanced the checkpoint", async () => {
    await appendOne("poison");
    await appendOne("next");

    let broken = true;
    const handled: string[] = [];
    const projection = recordingProjection("requeue-proj", handled, (env) => {
      if (env.payload.id === "poison" && broken) throw new Error("downstream down");
    });

    const r1 = startRunner([projection], {
      workerId: "dlq-w1",
      transactionMode: "perRow",
      batchSize: 1,
      maxAttempts: 1
    });
    await waitFor(async () => (await dlqCount()) === 1 && handled.includes("next"), 10000);
    await r1.stop();
    expect(await dlqCount()).toBe(1);
    expect(handled).toEqual(["next"]);

    // Operator fixes the root cause and requeues, as the docs instruct.
    broken = false;
    const dlq = new PgDlqService(pool);
    const { items } = await dlq.list();
    expect(items).toHaveLength(1);
    expect((await dlq.requeue(items[0]!.id)).requeued).toBe(true);

    const r2 = startRunner([projection], { workerId: "dlq-w2", transactionMode: "perRow" });
    await waitFor(async () => (await outboxCount()) === 0, 5000);
    await r2.stop();

    // BUG: the requeued row is acked without running the handler because
    // position(poison) <= checkpoint(next).
    expect(handled).toContain("poison");
  }, 30000);
});

// ---------------------------------------------------------------------------
// 4. Multiple runners on the same outbox
// ---------------------------------------------------------------------------

describe("multiple runners on one outbox", () => {
  // "Two runners with different projections each see every event" moved to
  // pg-projection-daemon.int.test.ts ("daemons running different projections
  // each see every event"). Projections now run on the ProjectionDaemon, which
  // keeps a checkpoint per projection. The outbox runner is for external
  // delivery: each outbox row is delivered once, to whichever runner claims it,
  // so runners with different handlers must split the outbox with claimTopic.

  it("two replicas of the same runner do not skip each other's in-flight events", async () => {
    for (let i = 1; i <= 10; i++) await appendOne(`e${i}`);
    const entered = deferred();
    const release = deferred();
    const handled: string[] = [];
    let gated = false;
    const projection = recordingProjection("replicated", handled, async (env) => {
      if (env.payload.id === "e1" && !gated) {
        gated = true;
        entered.resolve();
        await release.promise; // replica A is slow on its first event
      }
    });

    // Replica A claims e1..e5 and stalls on e1 inside its batch tx.
    const ra = startRunner([projection], { workerId: "replica-a", transactionMode: "batch", batchSize: 5 });
    await entered.promise;

    // Replica B claims e6..e10, processes them, commits checkpoint = pos(e10).
    const rb = startRunner([projection], { workerId: "replica-b", transactionMode: "batch", batchSize: 5 });
    await waitFor(async () => (await outboxCount()) === 5, 5000);

    // A resumes: under READ COMMITTED it now sees checkpoint = pos(e10).
    release.resolve();
    await waitFor(async () => (await outboxCount()) === 0, 5000);
    await Promise.all([ra.stop(), rb.stop()]);

    // BUG: A skips e2..e5 (position <= shared checkpoint) and acks them.
    expect([...handled].sort()).toEqual(
      ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10"].sort()
    );
  }, 30000);
});

// ---------------------------------------------------------------------------
// 5. Concurrent catch-up projector instances
// ---------------------------------------------------------------------------

describe("concurrent catch-up projectors", () => {
  it("handles every event exactly once when several instances run the same projection", async () => {
    const N = 40;
    for (let i = 0; i < N; i++) await appendOne(`e${i}`, null);

    const counts = new Map<string, number>();
    const projection = recordingProjection("shared", [], async (env) => {
      counts.set(env.payload.id, (counts.get(env.payload.id) ?? 0) + 1);
      await delay(2); // widen the window in which instances could overlap
    });

    // Three instances (think: three nodes), racing on the same projection.
    const projectors = [0, 1, 2].map(() => createCatchUpProjector<E>(pool, store));
    const deadline = Date.now() + 20000;
    while (counts.size < N && Date.now() < deadline) {
      await Promise.all(projectors.map((p) => p.catchUpProjection(projection as any, { batchSize: 5 })));
    }

    expect(counts.size).toBe(N);
    const duplicates = [...counts].filter(([, c]) => c > 1);
    expect(duplicates).toEqual([]);
  }, 30000);
});

// ---------------------------------------------------------------------------
// 5. A failing row must not be charged to the rest of its batch
// ---------------------------------------------------------------------------

describe("batch mode: failure attribution", () => {
  it("dead-letters only the failing row, not the healthy rows claimed with it", async () => {
    await appendOne("poison");
    await appendOne("ok-1");
    await appendOne("ok-2");

    const handled: string[] = [];
    const projection = recordingProjection("poison-batch", handled, (env) => {
      if (env.payload.id === "poison") throw new Error("always fails");
    });
    const r = startRunner([projection], { workerId: "poison-w", transactionMode: "batch", batchSize: 3, maxAttempts: 2 });
    await waitFor(async () => (await outboxCount()) === 0, 8000);
    await r.stop();

    const dlq = await pool.query(
      `SELECT e.payload->>'id' AS id FROM eventfabric.outbox_dead_letters d
         JOIN eventfabric.events e ON e.global_position = d.global_position`
    );
    expect(dlq.rows.map((x: any) => x.id)).toEqual(["poison"]);
    expect(handled).toEqual(expect.arrayContaining(["ok-1", "ok-2"]));
  }, 20000);
});

// ---------------------------------------------------------------------------
// 6. Lease fencing: a worker whose lease was taken over must not ack / release
// ---------------------------------------------------------------------------

describe("lease fencing", () => {
  it("a worker that lost its lease cannot ack: its handler's writes roll back and the row stays with the new owner", async () => {
    await appendOne("slow");
    const outbox = new PgOutboxStore();
    const uow = new PgUnitOfWork(pool);
    await pool.query(`CREATE TABLE IF NOT EXISTS public.fence_effects (worker text)`);
    await pool.query(`DELETE FROM public.fence_effects`);

    const [a] = await uow.withTransaction((tx) => outbox.claimBatch(tx, { batchSize: 1, workerId: "A" }));
    // A's lease expires while its handler runs; B takes the row over.
    await pool.query(`UPDATE eventfabric.outbox SET locked_at = now() - interval '1 hour'`);
    const [b] = await uow.withTransaction((tx) => outbox.claimBatch(tx, { batchSize: 1, workerId: "B", leaseMs: 1000 }));
    expect(b!.id).toBe(a!.id);

    // A finishes late: writes its effect and acks in one tx.
    await expect(
      uow.withTransaction(async (tx) => {
        await tx.client.query(`INSERT INTO public.fence_effects VALUES ('A')`);
        await outbox.ack(tx, a!.id, "A");
      })
    ).rejects.toThrow(/lease/i);

    expect((await pool.query(`SELECT * FROM public.fence_effects`)).rowCount).toBe(0);
    const row = await pool.query(`SELECT locked_by FROM eventfabric.outbox WHERE id = $1`, [a!.id]);
    expect(row.rows[0]?.locked_by).toBe("B");
  }, 20000);

  it("a worker that lost its lease cannot release the new owner's lock", async () => {
    await appendOne("slow-2");
    const outbox = new PgOutboxStore();
    const uow = new PgUnitOfWork(pool);
    const [a] = await uow.withTransaction((tx) => outbox.claimBatch(tx, { batchSize: 1, workerId: "A" }));
    await pool.query(`UPDATE eventfabric.outbox SET locked_at = now() - interval '1 hour'`);
    await uow.withTransaction((tx) => outbox.claimBatch(tx, { batchSize: 1, workerId: "B", leaseMs: 1000 }));

    await uow.withTransaction((tx) => outbox.releaseWithError(tx, a!.id, "late failure", "A"));
    await uow.withTransaction((tx) => outbox.release(tx, [a!.id], "A"));

    const row = await pool.query(`SELECT locked_by, attempts FROM eventfabric.outbox WHERE id = $1`, [a!.id]);
    expect(row.rows[0]).toEqual({ locked_by: "B", attempts: 2 });
  }, 20000);
});
