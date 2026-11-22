import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { PgHighWaterMark } from "../src/projections/pg-high-water-mark";
import { migrate } from "../src/pg-migrator";
import { endPool } from "./helpers/end-pool";

type E = { type: "X"; version: 1; id: string };

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;
const store = new PgEventStore<E>();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
  await migrate(pool);
}, 60000);

afterAll(async () => {
  if (pool) await endPool(pool);
  if (container) await container.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM eventfabric.outbox`);
  await pool.query(`DELETE FROM eventfabric.stream_versions`);
  await pool.query(`DELETE FROM eventfabric.events`);
}, 60000);

async function appendOne(id: string): Promise<bigint> {
  const res = await new PgUnitOfWork(pool).withTransaction((tx) =>
    store.append(tx, {
      aggregateName: "Agg",
      aggregateId: id,
      expectedAggregateVersion: 0,
      events: [{ type: "X", version: 1, id }]
    })
  );
  return res.appended[0]!.globalPosition;
}

/** Append inside a transaction that stays open until finish("commit" | "rollback"). */
async function appendHeldOpen(id: string) {
  const client = await pool.connect();
  await client.query("BEGIN");
  const res = await store.append({ client, tenantId: "default" } as any, {
    aggregateName: "Agg",
    aggregateId: id,
    expectedAggregateVersion: 0,
    events: [{ type: "X", version: 1, id }]
  });
  return {
    position: res.appended[0]!.globalPosition,
    finish: async (how: "commit" | "rollback") => {
      await client.query(how === "commit" ? "COMMIT" : "ROLLBACK");
      client.release();
    }
  };
}

describe("PgHighWaterMark", () => {
  it("is 0 for an empty event log", async () => {
    expect(await new PgHighWaterMark(pool).safePosition()).toBe(0n);
  });

  it("returns the latest position immediately when nothing is in flight", async () => {
    await appendOne("a");
    const b = await appendOne("b");
    expect(await new PgHighWaterMark(pool).safePosition()).toBe(b);
  });

  it("holds below an in-flight append, then advances once it commits", async () => {
    const before = await appendOne("before");
    const slow = await appendHeldOpen("slow");
    const fast = await appendOne("fast");
    expect(fast).toBeGreaterThan(slow.position);

    const hwm = new PgHighWaterMark(pool);
    // The first sample is taken while "slow" is open; nothing newer is known safe yet.
    expect(await hwm.safePosition({ waitMs: 100 })).toBeLessThan(slow.position);

    await slow.finish("commit");
    expect(await hwm.safePosition()).toBe(fast);
    expect(before).toBeLessThan(slow.position);
  });

  it("moves past the gap left by a rolled-back append", async () => {
    const doomed = await appendHeldOpen("doomed");
    const after = await appendOne("after");
    expect(after).toBeGreaterThan(doomed.position);

    await doomed.finish("rollback");
    expect(await new PgHighWaterMark(pool).safePosition()).toBe(after);
  });

  it("waits up to waitMs for in-flight transactions to finish", async () => {
    const slow = await appendHeldOpen("slow");
    const fast = await appendOne("fast");
    setTimeout(() => void slow.finish("commit"), 150);

    const hwm = new PgHighWaterMark(pool);
    expect(await hwm.safePosition({ waitMs: 5000 })).toBe(fast);
  });

  it("is conservative about an unrelated open write transaction", async () => {
    // Any transaction holding an xid when the sample is taken could, in
    // principle, still append. The mark waits for it.
    const other = await pool.connect();
    await other.query("BEGIN");
    await other.query("SELECT pg_current_xact_id()");
    const pos = await appendOne("x");

    const hwm = new PgHighWaterMark(pool);
    expect(await hwm.safePosition({ waitMs: 100 })).toBe(0n);

    await other.query("COMMIT");
    other.release();
    expect(await hwm.safePosition()).toBe(pos);
  });

  it("skipLiveTransactionsAfterMs forces the mark past a long-running transaction", async () => {
    const slow = await appendHeldOpen("slow");
    const fast = await appendOne("fast");

    const hwm = new PgHighWaterMark(pool, { skipLiveTransactionsAfterMs: 100 });
    expect(await hwm.safePosition()).toBe(0n);
    await new Promise((r) => setTimeout(r, 150));
    expect(await hwm.safePosition()).toBe(fast);

    await slow.finish("rollback");
  });

  it("never moves backwards", async () => {
    const a = await appendOne("a");
    const hwm = new PgHighWaterMark(pool);
    expect(await hwm.safePosition()).toBe(a);
    await pool.query(`DELETE FROM eventfabric.events`);
    expect(await hwm.safePosition()).toBe(a);
  });
});
