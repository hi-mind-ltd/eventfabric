import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { SessionFactory } from "../src/session";
import { migrate } from "../src/pg-migrator";
import { AggregateRoot, computeEventHash, streamGenesis, toSecret, type HandlerMap } from "@eventfabric/core";
import { endPool } from "./helpers/end-pool";

type E = { type: "A"; version: 1; n: number };
const SECRET = "test-hmac-secret";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
}, 120000);

afterAll(async () => {
  if (pool) await endPool(pool);
  if (container) await container.stop();
});

/** Store with the chaining feature on and "Audit" protected. */
function chainedStore() {
  return new PgEventStore<E>({ hashChain: { secret: SECRET, enabledAggregates: ["Audit"] } });
}

const ev = (n: number): E => ({ type: "A", version: 1, n });

describe("PgEventStore hash chaining", () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM eventfabric.event_chain_anchors`);
    await pool.query(`DELETE FROM eventfabric.outbox`);
    await pool.query(`DELETE FROM eventfabric.stream_versions`);
    await pool.query(`DELETE FROM eventfabric.events`);
  }, 60000);

  it("writes event_hash + head_hash for a chained aggregate and verifies intact", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);

    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1), ev(2)] })
    );

    const rows = await pool.query(`SELECT event_hash FROM eventfabric.events WHERE aggregate_name='Audit' ORDER BY aggregate_version`);
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.every((r) => r.event_hash !== null)).toBe(true);
    expect(rows.rows[0].event_hash.equals(rows.rows[1].event_hash)).toBe(false);

    const sv = await pool.query(`SELECT head_hash FROM eventfabric.stream_versions WHERE aggregate_name='Audit' AND aggregate_id='a1'`);
    expect(sv.rows[0].head_hash).not.toBeNull();
    // head_hash equals the last event's hash
    expect(sv.rows[0].head_hash.equals(rows.rows[1].event_hash)).toBe(true);

    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(result.ok).toBe(true);
    expect(result.eventsChecked).toBe(2);
    expect(result.firstBrokenAt).toBeNull();
  });

  it("leaves event_hash NULL for an unchained aggregate (fast path)", async () => {
    const store = chainedStore(); // feature on, but "User" not enabled
    const uow = new PgUnitOfWork(pool);

    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "User", aggregateId: "u1", expectedAggregateVersion: 0, events: [ev(1)] })
    );

    const rows = await pool.query(`SELECT event_hash FROM eventfabric.events WHERE aggregate_name='User'`);
    expect(rows.rows[0].event_hash).toBeNull();
    const sv = await pool.query(`SELECT head_hash FROM eventfabric.stream_versions WHERE aggregate_name='User'`);
    expect(sv.rows[0].head_hash).toBeNull();

    // Nothing protected: not verified, unless the caller accepts unprotected events.
    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "User", aggregateId: "u1" }));
    expect(result).toMatchObject({ ok: false, eventsChecked: 0, unprotectedEvents: 1, firstBrokenAt: 1 });
    const allowed = await uow.withTransaction((tx) =>
      store.verifyStream(tx, { aggregateName: "User", aggregateId: "u1", allowUnprotectedPrefix: true })
    );
    expect(allowed).toMatchObject({ ok: true, eventsChecked: 0, unprotectedEvents: 1 });
  });

  it("detects a chain whose hashes were all removed", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "s1", expectedAggregateVersion: 0, events: [ev(1), ev(2)] })
    );
    // An attacker with database access strips the chain, then edits an event.
    await pool.query(`UPDATE eventfabric.events SET event_hash = NULL, payload = jsonb_set(payload, '{n}', '99') WHERE aggregate_id = 's1'`);
    await pool.query(`UPDATE eventfabric.stream_versions SET head_hash = NULL WHERE aggregate_id = 's1'`);

    const stripped = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "s1" }));
    expect(stripped).toMatchObject({ ok: false, unprotectedEvents: 2, firstBrokenAt: 1 });
    expect(stripped.reason).toMatch(/no|none/);

    // The next append starts a fresh chain; the stripped events still fail verification.
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "s1", expectedAggregateVersion: 2, events: [ev(3)] })
    );
    const restarted = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "s1" }));
    expect(restarted).toMatchObject({ ok: false, unprotectedEvents: 2, eventsChecked: 1, firstBrokenAt: 1 });

    const results = await uow.withTransaction((tx) => store.verifyAggregate(tx, { aggregateName: "Audit" }));
    expect(results.map((r) => r.ok)).toEqual([false]);
  });

  it("verifies a stream chained mid-life only with allowUnprotectedPrefix", async () => {
    const uow = new PgUnitOfWork(pool);
    // Written before tamper-evidence was enabled for "Audit".
    const before = new PgEventStore<E>({ hashChain: { secret: SECRET } });
    await uow.withTransaction((tx) =>
      before.append(tx, { aggregateName: "Audit", aggregateId: "m1", expectedAggregateVersion: 0, events: [ev(1)] })
    );
    const store = chainedStore();
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "m1", expectedAggregateVersion: 1, events: [ev(2), ev(3)] })
    );

    const strict = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "m1" }));
    expect(strict).toMatchObject({ ok: false, unprotectedEvents: 1, eventsChecked: 2 });
    const allowed = await uow.withTransaction((tx) =>
      store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "m1", allowUnprotectedPrefix: true })
    );
    expect(allowed).toMatchObject({ ok: true, unprotectedEvents: 1, eventsChecked: 2 });

    // A real break still fails with allowUnprotectedPrefix.
    await pool.query(`UPDATE eventfabric.events SET payload = jsonb_set(payload, '{n}', '99') WHERE aggregate_id = 'm1' AND aggregate_version = 3`);
    const broken = await uow.withTransaction((tx) =>
      store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "m1", allowUnprotectedPrefix: true })
    );
    expect(broken).toMatchObject({ ok: false, firstBrokenAt: 3 });
  });

  it("detects a stream whose events and head were all removed", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "e1", expectedAggregateVersion: 0, events: [ev(1)] })
    );
    await pool.query(`DELETE FROM eventfabric.outbox`);
    await pool.query(`DELETE FROM eventfabric.events WHERE aggregate_id = 'e1'`);
    await pool.query(`UPDATE eventfabric.stream_versions SET head_hash = NULL WHERE aggregate_id = 'e1'`);

    const result = await uow.withTransaction((tx) =>
      store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "e1", allowUnprotectedPrefix: true })
    );
    expect(result).toMatchObject({ ok: false, firstBrokenAt: 1 });
    expect(result.reason).toMatch(/no events/);
  });

  it("rejects a missing or empty secret instead of running unprotected", () => {
    expect(() => new PgEventStore<E>({ hashChain: { secret: "", enabledAggregates: ["Audit"] } })).toThrow(/empty/);
    expect(() => new PgEventStore<E>({ hashChain: { secret: Buffer.alloc(0) } })).toThrow(/empty/);
    // process.env.EF_CHAIN_SECRET! when the variable is unset
    expect(
      () => new PgEventStore<E>({ hashChain: { secret: undefined as unknown as string, enabledAggregates: ["Audit"] } })
    ).toThrow(/missing/);
  });

  it("detects a payload mutation", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1), ev(2), ev(3)] })
    );

    await pool.query(
      `UPDATE eventfabric.events SET payload = '{"type":"A","version":1,"n":999}'::jsonb
       WHERE aggregate_name='Audit' AND aggregate_id='a1' AND aggregate_version=2`
    );

    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(result.ok).toBe(false);
    expect(result.firstBrokenAt).toBe(2);
    expect(result.reason).toMatch(/event_hash mismatch/);
  });

  it("detects a deleted middle event as a version gap", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1), ev(2), ev(3)] })
    );

    await pool.query(`DELETE FROM eventfabric.events WHERE aggregate_name='Audit' AND aggregate_id='a1' AND aggregate_version=2`);

    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(result.ok).toBe(false);
    expect(result.firstBrokenAt).toBe(2);
    expect(result.reason).toMatch(/version gap/);
  });

  it("detects tail deletion via head_hash mismatch", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1), ev(2), ev(3)] })
    );

    await pool.query(`DELETE FROM eventfabric.events WHERE aggregate_name='Audit' AND aggregate_id='a1' AND aggregate_version=3`);

    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/head_hash mismatch/);
  });

  it("refuses to dismiss an event in a chained stream", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    let ids: string[] = [];
    await uow.withTransaction(async (tx) => {
      const r = await store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1), ev(2), ev(3)] });
      ids = r.appended.map((e) => e.eventId);
    });

    await expect(
      uow.withTransaction((tx) => store.dismiss(tx, ids[1]!, { reason: "noise", by: "admin" }))
    ).rejects.toThrow(/tamper-evident stream and can't be dismissed/);

    const loaded = await uow.withTransaction((tx) => store.loadStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(loaded).toHaveLength(3);
    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(result).toMatchObject({ ok: true, eventsChecked: 3 });
  });

  it("still dismisses events of an unchained aggregate, and unknown ids are a no-op", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    let id = "";
    await uow.withTransaction(async (tx) => {
      const r = await store.append(tx, { aggregateName: "Plain", aggregateId: "p9", expectedAggregateVersion: 0, events: [ev(1)] });
      id = r.appended[0]!.eventId;
    });
    await uow.withTransaction((tx) => store.dismiss(tx, id, { reason: "noise" }));
    await uow.withTransaction((tx) => store.dismiss(tx, "00000000-0000-0000-0000-000000000000"));

    const loaded = await uow.withTransaction((tx) => store.loadStream(tx, { aggregateName: "Plain", aggregateId: "p9" }));
    expect(loaded).toHaveLength(0);
  });

  it("detects an event dismissed directly in the table (hidden from replay)", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "h1", expectedAggregateVersion: 0, events: [ev(1), ev(2), ev(3)] })
    );
    await pool.query(`UPDATE eventfabric.events SET dismissed_at = now() WHERE aggregate_id = 'h1' AND aggregate_version = 2`);

    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "h1" }));
    expect(result).toMatchObject({ ok: false, firstBrokenAt: 2 });
    expect(result.reason).toMatch(/dismissed/);
  });

  it("detects a changed occurred_at, down to a microsecond", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "t1", expectedAggregateVersion: 0, events: [ev(1), ev(2)] })
    );
    const verify = () => uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "t1" }));
    expect(await verify()).toMatchObject({ ok: true, eventsChecked: 2, legacyFormatEvents: 0 });

    await pool.query(`UPDATE eventfabric.events SET occurred_at = occurred_at - interval '1 day' WHERE aggregate_id = 't1' AND aggregate_version = 2`);
    expect(await verify()).toMatchObject({ ok: false, firstBrokenAt: 2 });

    await pool.query(`UPDATE eventfabric.events SET occurred_at = occurred_at + interval '1 day' WHERE aggregate_id = 't1' AND aggregate_version = 2`);
    expect(await verify()).toMatchObject({ ok: true });

    await pool.query(`UPDATE eventfabric.events SET occurred_at = occurred_at + interval '1 microsecond' WHERE aggregate_id = 't1' AND aggregate_version = 1`);
    expect(await verify()).toMatchObject({ ok: false, firstBrokenAt: 1 });
  });

  it("verifies a chain independent of the session time zone", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "z1", expectedAggregateVersion: 0, events: [ev(1)] })
    );
    const result = await uow.withTransaction(async (tx) => {
      await tx.client.query(`SET LOCAL TIME ZONE 'Asia/Kolkata'`);
      return store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "z1" });
    });
    expect(result).toMatchObject({ ok: true, eventsChecked: 1 });
  });

  it("still verifies chains written in format v1, and reports them", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "v1", expectedAggregateVersion: 0, events: [ev(1), ev(2)] })
    );
    // Rewrite the chain as an earlier release wrote it: no timestamp in the hash.
    const secret = toSecret(SECRET);
    const rows = await pool.query(
      `SELECT event_id, aggregate_version, type, version, payload FROM eventfabric.events WHERE aggregate_id = 'v1' ORDER BY aggregate_version`
    );
    let prev = streamGenesis(secret, "default", "Audit", "v1");
    for (const r of rows.rows) {
      prev = computeEventHash(secret, prev, {
        tenantId: "default", aggregateName: "Audit", aggregateId: "v1",
        aggregateVersion: Number(r.aggregate_version), eventId: r.event_id,
        type: r.type, version: Number(r.version), payload: r.payload,
      });
      await pool.query(`UPDATE eventfabric.events SET event_hash = $1 WHERE event_id = $2`, [prev, r.event_id]);
    }
    await pool.query(`UPDATE eventfabric.stream_versions SET head_hash = $1 WHERE aggregate_id = 'v1'`, [prev]);

    const verify = () => uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "v1" }));
    expect(await verify()).toMatchObject({ ok: true, eventsChecked: 2, legacyFormatEvents: 2 });

    // New events on top are written in v2.
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "v1", expectedAggregateVersion: 2, events: [ev(3)] })
    );
    expect(await verify()).toMatchObject({ ok: true, eventsChecked: 3, legacyFormatEvents: 2 });

    // A v1 event's content is still protected.
    await pool.query(`UPDATE eventfabric.events SET payload = jsonb_set(payload, '{n}', '99') WHERE aggregate_id = 'v1' AND aggregate_version = 1`);
    expect(await verify()).toMatchObject({ ok: false, firstBrokenAt: 1 });
  });

  it("chains across multiple appends to the same stream", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1), ev(2)] })
    );
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 2, events: [ev(3)] })
    );

    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(result.ok).toBe(true);
    expect(result.eventsChecked).toBe(3);
  });

  it("fails verification under the wrong secret", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1), ev(2)] })
    );

    const wrong = new PgEventStore<E>({ hashChain: { secret: "not-the-secret", enabledAggregates: ["Audit"] } });
    const result = await uow.withTransaction((tx) => wrong.verifyStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(result.ok).toBe(false);
    expect(result.firstBrokenAt).toBe(1);
  });

  it("a store that has not registered the aggregate still extends an existing chain", async () => {
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      chainedStore().append(tx, { aggregateName: "Audit", aggregateId: "u1", expectedAggregateVersion: 0, events: [ev(1)] })
    );
    // Same secret, but "Audit" is not registered in this process (a worker, an ops script).
    const unregistered = new PgEventStore<E>({ hashChain: { secret: SECRET } });
    await uow.withTransaction((tx) =>
      unregistered.append(tx, { aggregateName: "Audit", aggregateId: "u1", expectedAggregateVersion: 1, events: [ev(2)] })
    );

    const result = await uow.withTransaction((tx) => chainedStore().verifyStream(tx, { aggregateName: "Audit", aggregateId: "u1" }));
    expect(result).toMatchObject({ ok: true, eventsChecked: 2 });
  });

  it("a store without the chain secret refuses to append to a chained stream", async () => {
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      chainedStore().append(tx, { aggregateName: "Audit", aggregateId: "u2", expectedAggregateVersion: 0, events: [ev(1)] })
    );
    const noSecret = new PgEventStore<E>();
    await expect(
      uow.withTransaction((tx) =>
        noSecret.append(tx, { aggregateName: "Audit", aggregateId: "u2", expectedAggregateVersion: 1, events: [ev(2)] })
      )
    ).rejects.toThrow(/tamper-evident/);

    const result = await uow.withTransaction((tx) => chainedStore().verifyStream(tx, { aggregateName: "Audit", aggregateId: "u2" }));
    expect(result).toMatchObject({ ok: true, eventsChecked: 1 });
  });

  it("an unchained stream still reports a version conflict", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = chainedStore();
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Plain", aggregateId: "p1", expectedAggregateVersion: 0, events: [ev(1)] })
    );
    await expect(
      uow.withTransaction((tx) =>
        store.append(tx, { aggregateName: "Plain", aggregateId: "p1", expectedAggregateVersion: 5, events: [ev(2)] })
      )
    ).rejects.toThrow(/Expected version 5/);
  });

  it("verifies events whose payload holds a Date (hashed as stored, not as the JS object)", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = chainedStore();
    const withDate = { ...ev(1), at: new Date("2026-01-02T03:04:05.000Z") } as unknown as E;
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "d1", expectedAggregateVersion: 0, events: [withDate] })
    );
    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "d1" }));
    expect(result).toMatchObject({ ok: true, eventsChecked: 1 });
  });

  it("verifyAggregate reports every stream of the aggregate", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction(async (tx) => {
      await store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1), ev(2)] });
      await store.append(tx, { aggregateName: "Audit", aggregateId: "a2", expectedAggregateVersion: 0, events: [ev(9)] });
    });

    const results = await uow.withTransaction((tx) => store.verifyAggregate(tx, { aggregateName: "Audit" }));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("enables chaining from a class's static tamperEvident via registerAggregate", async () => {
    // Store has the secret but no pre-listed aggregates; registration must turn it on.
    const store = new PgEventStore<E>({ hashChain: { secret: SECRET } });
    const factory = new SessionFactory<E>(pool, store);

    class AuditAgg extends AggregateRoot<{ count: number }, E> {
      static aggregateName = "Audit";
      static tamperEvident = true;
      protected handlers: HandlerMap<E, { count: number }> = { A: (s) => { s.count++; } };
      constructor(id: string) { super(id, { count: 0 }); }
    }

    factory.registerAggregate(AuditAgg, ["A"], "audit");

    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) =>
      store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1)] })
    );

    const rows = await pool.query(`SELECT event_hash FROM eventfabric.events WHERE aggregate_name='Audit'`);
    expect(rows.rows[0].event_hash).not.toBeNull();
    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(result.ok).toBe(true);
  });
});
