import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import type { CatchUpProjection, EventEnvelope } from "@eventfabric/core";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { createProjectionDaemon } from "../src/projections/pg-projection-daemon";
import type { PgTx } from "../src/unitofwork/pg-transaction";
import { migrate } from "../src/pg-migrator";
import { endPool } from "./helpers/end-pool";

type E = { type: "X"; version: 1; id: string };

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;
const store = new PgEventStore<E>();
const fastBackoff = { minMs: 1, maxMs: 5, factor: 2, jitter: 0 };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
  await migrate(pool);
  // A read model the test projections write to, so retries / rollbacks /
  // concurrent instances are checked against committed rows.
  await pool.query(`
    CREATE TABLE read_model (
      projection TEXT NOT NULL,
      tenant_id  TEXT NOT NULL,
      event_id   TEXT NOT NULL,
      times      INT  NOT NULL,
      PRIMARY KEY (projection, tenant_id, event_id)
    )`);
}, 60000);

afterAll(async () => {
  if (pool) await endPool(pool);
  if (container) await container.stop();
});

beforeEach(async () => {
  for (const t of [
    "read_model",
    "eventfabric.projection_dead_letters",
    "eventfabric.projection_checkpoints",
    "eventfabric.outbox",
    "eventfabric.stream_versions",
    "eventfabric.events"
  ]) {
    await pool.query(`DELETE FROM ${t}`);
  }
}, 60000);

async function appendOne(id: string, tenantId = "default"): Promise<bigint> {
  const res = await new PgUnitOfWork(pool, tenantId).withTransaction((tx) =>
    store.append(tx, {
      aggregateName: "Agg",
      aggregateId: id,
      expectedAggregateVersion: 0,
      events: [{ type: "X", version: 1, id }]
    })
  );
  return res.appended[0]!.globalPosition;
}

async function appendHeldOpen(id: string) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await store.append({ client, tenantId: "default" } as PgTx, {
    aggregateName: "Agg",
    aggregateId: id,
    expectedAggregateVersion: 0,
    events: [{ type: "X", version: 1, id }]
  });
  return async () => {
    await client.query("COMMIT");
    client.release();
  };
}

/** A projection that counts each event into read_model inside the batch transaction. */
function readModel(name: string, opts: { failOn?: (env: EventEnvelope<E>) => boolean; withReset?: boolean } = {}): CatchUpProjection<E, PgTx> {
  const p: CatchUpProjection<E, PgTx> = {
    name,
    async handle(tx, env) {
      if (opts.failOn?.(env)) throw new Error(`cannot handle ${env.payload.id}`);
      await tx.client.query(
        `INSERT INTO read_model (projection, tenant_id, event_id, times) VALUES ($1, $2, $3, 1)
         ON CONFLICT (projection, tenant_id, event_id) DO UPDATE SET times = read_model.times + 1`,
        [name, tx.tenantId, env.payload.id]
      );
    }
  };
  if (opts.withReset) {
    p.reset = async (tx) => {
      await tx.client.query(`DELETE FROM read_model WHERE projection = $1 AND tenant_id = $2`, [name, tx.tenantId]);
    };
  }
  return p;
}

async function rows(projection: string): Promise<Array<[string, string, number]>> {
  const r = await pool.query(
    `SELECT tenant_id, event_id, times FROM read_model WHERE projection = $1 ORDER BY tenant_id, event_id`,
    [projection]
  );
  return r.rows.map((x) => [x.tenant_id, x.event_id, x.times]);
}

async function runUntil(d: { runOnce(): Promise<boolean> }, done: () => Promise<boolean>, rounds = 50) {
  for (let i = 0; i < rounds && !(await done()); i++) {
    await d.runOnce();
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("ProjectionDaemon (Postgres)", () => {
  it("projects every tenant's events, each exactly once", async () => {
    await appendOne("a1", "a");
    await appendOne("b1", "b");
    await appendOne("a2", "a");

    const d = createProjectionDaemon(pool, store, [readModel("rm")]);
    await d.runOnce();

    expect(await rows("rm")).toEqual([
      ["a", "a1", 1],
      ["a", "a2", 1],
      ["b", "b1", 1]
    ]);
    expect(await d.runOnce()).toBe(false);
  });

  it("waits for a late-committing event, then projects both in position order", async () => {
    const order: string[] = [];
    const p: CatchUpProjection<E, PgTx> = { name: "order", async handle(_tx, env) { order.push(env.payload.id); } };
    const commitLate = await appendHeldOpen("late");
    await appendOne("fast");

    const d = createProjectionDaemon(pool, store, [p]);
    await d.runOnce();
    expect(order).toEqual([]); // the mark holds below "late"

    await commitLate();
    await runUntil(d, async () => order.length === 2);
    expect(order).toEqual(["late", "fast"]);
  });

  it("back-fills a projection added later", async () => {
    await appendOne("e1");
    await appendOne("e2");
    await createProjectionDaemon(pool, store, [readModel("first")]).runOnce();

    await createProjectionDaemon(pool, store, [readModel("first"), readModel("second")]).runOnce();
    expect(await rows("second")).toEqual([
      ["default", "e1", 1],
      ["default", "e2", 1]
    ]);
    expect(await rows("first")).toEqual([
      ["default", "e1", 1],
      ["default", "e2", 1]
    ]);
  });

  it("several instances running the same projections handle each event exactly once", async () => {
    const N = 40;
    for (let i = 0; i < N; i++) await appendOne(`e${i}`, i % 2 ? "a" : "b");

    const daemons = [0, 1, 2].map(() =>
      createProjectionDaemon(pool, store, [readModel("shared"), readModel("other")], { batchSize: 3 })
    );
    const total = async () => (await pool.query(`SELECT COUNT(*)::int AS c FROM read_model`)).rows[0].c;
    for (let i = 0; i < 100 && (await total()) < 2 * N; i++) {
      await Promise.all(daemons.map((d) => d.runOnce()));
    }

    const r = await pool.query(`SELECT projection, COUNT(*)::int AS events, MAX(times)::int AS max_times FROM read_model GROUP BY projection ORDER BY projection`);
    expect(r.rows).toEqual([
      { projection: "other", events: N, max_times: 1 },
      { projection: "shared", events: N, max_times: 1 }
    ]);
  }, 30000);

  it("daemons running different projections each see every event", async () => {
    for (let i = 0; i < 10; i++) await appendOne(`e${i}`);
    const readModels = createProjectionDaemon(pool, store, [readModel("read-model")]);
    const emails = createProjectionDaemon(pool, store, [readModel("email")]);
    await Promise.all([readModels.runOnce(), emails.runOnce()]);

    expect(await rows("read-model")).toHaveLength(10);
    expect(await rows("email")).toHaveLength(10);
  });

  it("retries a failing event without double-applying the events around it", async () => {
    await appendOne("e1");
    await appendOne("e2");
    await appendOne("e3");
    let failures = 2;
    const d = createProjectionDaemon(
      pool,
      store,
      [readModel("rm", { failOn: (env) => env.payload.id === "e2" && failures-- > 0 })],
      { backoff: fastBackoff, maxAttempts: 5 }
    );

    await runUntil(d, async () => (await rows("rm")).length === 3);
    expect(await rows("rm")).toEqual([
      ["default", "e1", 1],
      ["default", "e2", 1],
      ["default", "e3", 1]
    ]);
    const dl = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.projection_dead_letters`);
    expect(dl.rows[0].c).toBe(0);
  });

  it("dead-letters a poison event, keeps going, and replays it once fixed", async () => {
    await appendOne("e1");
    const poisonPos = await appendOne("poison");
    await appendOne("e3");
    let broken = true;
    const d = createProjectionDaemon(
      pool,
      store,
      [readModel("rm", { failOn: (env) => broken && env.payload.id === "poison" })],
      { backoff: fastBackoff, maxAttempts: 3 }
    );

    await runUntil(d, async () => (await rows("rm")).length === 2);
    expect(await rows("rm")).toEqual([
      ["default", "e1", 1],
      ["default", "e3", 1]
    ]);

    const [dead] = await d.listDeadLetters({ projectionName: "rm" });
    expect(dead).toMatchObject({
      projectionName: "rm",
      tenantId: "default",
      globalPosition: poisonPos,
      eventType: "X",
      attempts: 3
    });
    expect(dead!.lastError).toContain("cannot handle poison");

    broken = false;
    expect(await d.replayDeadLetter(dead!.id)).toEqual({ replayed: true });
    expect(await rows("rm")).toContainEqual(["default", "poison", 1]);
    expect(await d.listDeadLetters()).toEqual([]);
  });

  it("rebuild clears the read model via reset() and replays every tenant", async () => {
    await appendOne("a1", "a");
    await appendOne("b1", "b");
    const projection = readModel("rm", { withReset: true });
    const d = createProjectionDaemon(pool, store, [projection]);
    await d.runOnce();

    await d.rebuild("rm");
    // Without reset() each row would now say times = 2.
    expect(await rows("rm")).toEqual([
      ["a", "a1", 1],
      ["b", "b1", 1]
    ]);
    const cps = await pool.query(
      `SELECT tenant_id, last_global_position::text AS pos FROM eventfabric.projection_checkpoints WHERE projection_name = 'rm' ORDER BY tenant_id`
    );
    expect(cps.rows.map((r) => r.tenant_id)).toEqual(["a", "b"]);
    expect(cps.rows.every((r) => r.pos !== "0")).toBe(true);
  });

  it("start() keeps projecting new events until aborted", async () => {
    const d = createProjectionDaemon(pool, store, [readModel("rm")], { idleSleepMs: 20 });
    const ac = new AbortController();
    const running = d.start(ac.signal);

    await appendOne("e1");
    await appendOne("e2", "other-tenant");
    for (let i = 0; i < 200 && (await rows("rm")).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await running;

    expect(await rows("rm")).toEqual([
      ["default", "e1", 1],
      ["other-tenant", "e2", 1]
    ]);
  });
});
