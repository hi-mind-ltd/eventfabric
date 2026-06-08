import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { SessionFactory } from "../src/session";
import { migrate } from "../src/pg-migrator";
import { AggregateRoot, type HandlerMap } from "@eventfabric/core";

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
  if (pool) await pool.end();
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

    // Nothing protected -> verify is vacuously ok.
    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "User", aggregateId: "u1" }));
    expect(result.ok).toBe(true);
    expect(result.eventsChecked).toBe(0);
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

  it("stays valid after a soft dismiss (dismiss does not break the chain)", async () => {
    const store = chainedStore();
    const uow = new PgUnitOfWork(pool);
    let ids: string[] = [];
    await uow.withTransaction(async (tx) => {
      const r = await store.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1), ev(2), ev(3)] });
      ids = r.appended.map((e) => e.eventId);
    });

    await uow.withTransaction((tx) => store.dismiss(tx, ids[1]!, { reason: "noise", by: "admin" }));

    const result = await uow.withTransaction((tx) => store.verifyStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(result.ok).toBe(true);
    expect(result.eventsChecked).toBe(3);
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
