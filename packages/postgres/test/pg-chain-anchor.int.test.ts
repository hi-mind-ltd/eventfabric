import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { PgChainAnchorSealer, PgChainAnchorRunner } from "../src/chain-anchor-sealer";
import { migrate } from "../src/pg-migrator";

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

const store = () => new PgEventStore<E>({ hashChain: { secret: SECRET, enabledAggregates: ["Audit"] } });
const sealer = () => new PgChainAnchorSealer({ secret: SECRET });
const ev = (n: number): E => ({ type: "A", version: 1, n });

async function append(s: PgEventStore<E>, id: string, expected: number, events: E[]) {
  const uow = new PgUnitOfWork(pool);
  await uow.withTransaction((tx) => s.append(tx, { aggregateName: "Audit", aggregateId: id, expectedAggregateVersion: expected, events }));
}

describe("PgChainAnchorSealer", () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM eventfabric.event_chain_anchor_members`);
    await pool.query(`DELETE FROM eventfabric.event_chain_anchors`);
    await pool.query(`DELETE FROM eventfabric.outbox`);
    await pool.query(`DELETE FROM eventfabric.stream_versions`);
    await pool.query(`DELETE FROM eventfabric.events`);
  }, 60000);

  it("seals chained stream heads and verifies intact", async () => {
    const s = store();
    await append(s, "a1", 0, [ev(1), ev(2)]);
    await append(s, "a2", 0, [ev(9)]);

    const uow = new PgUnitOfWork(pool);
    const sealRes = await uow.withTransaction((tx) => sealer().seal(tx));
    expect(sealRes.sealed).toBe(true);
    expect(sealRes.memberCount).toBe(2);
    expect(sealRes.anchorSeq).toBe(1);

    const v = await uow.withTransaction((tx) => sealer().verifyAnchors(tx));
    expect(v.ok).toBe(true);
    expect(v.anchorsChecked).toBe(1);
    expect(v.streamsChecked).toBe(2);
  });

  it("only anchors chained streams (NULL head_hash excluded)", async () => {
    const s = store();
    await append(s, "a1", 0, [ev(1)]);
    // Unchained aggregate writes through the same store but is not enabled.
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) => s.append(tx, { aggregateName: "User", aggregateId: "u1", expectedAggregateVersion: 0, events: [ev(1)] }));

    const sealRes = await uow.withTransaction((tx) => sealer().seal(tx));
    expect(sealRes.memberCount).toBe(1);
  });

  it("is idempotent — a second seal with no changes is a no-op", async () => {
    const s = store();
    await append(s, "a1", 0, [ev(1)]);
    const uow = new PgUnitOfWork(pool);

    const first = await uow.withTransaction((tx) => sealer().seal(tx));
    expect(first.sealed).toBe(true);
    const second = await uow.withTransaction((tx) => sealer().seal(tx));
    expect(second.sealed).toBe(false);
    expect(second.memberCount).toBe(0);

    const count = await pool.query(`SELECT count(*)::int AS c FROM eventfabric.event_chain_anchors`);
    expect(count.rows[0].c).toBe(1);
  });

  it("seals deltas as streams advance across multiple anchors", async () => {
    const s = store();
    await append(s, "a1", 0, [ev(1), ev(2)]);
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) => sealer().seal(tx));   // seq 1: a1@v2

    await append(s, "a1", 2, [ev(3)]);
    const second = await uow.withTransaction((tx) => sealer().seal(tx)); // seq 2: a1@v3
    expect(second.sealed).toBe(true);
    expect(second.anchorSeq).toBe(2);

    const v = await uow.withTransaction((tx) => sealer().verifyAnchors(tx));
    expect(v.ok).toBe(true);
    expect(v.anchorsChecked).toBe(2);
    expect(v.streamsChecked).toBe(1); // latest sealed state for the single stream
  });

  it("detects whole-stream deletion", async () => {
    const s = store();
    await append(s, "a1", 0, [ev(1), ev(2)]);
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) => sealer().seal(tx));

    await pool.query(`DELETE FROM eventfabric.events WHERE aggregate_name='Audit' AND aggregate_id='a1'`);
    await pool.query(`DELETE FROM eventfabric.stream_versions WHERE aggregate_name='Audit' AND aggregate_id='a1'`);

    const v = await uow.withTransaction((tx) => sealer().verifyAnchors(tx));
    expect(v.ok).toBe(false);
    expect(v.failure?.kind).toBe("sealed-event-missing");
    expect(v.failure?.aggregateId).toBe("a1");
  });

  it("detects a clean stream rollback that per-stream verify alone cannot", async () => {
    const s = store();
    await append(s, "a1", 0, [ev(1), ev(2), ev(3), ev(4), ev(5)]);
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) => sealer().seal(tx)); // seals a1@v5

    // Attacker truncates the stream to v3 and fixes stream_versions to a VALID
    // earlier state (head_hash = the real event_hash of v3). This requires no
    // secret — it only removes data.
    const h3 = (await pool.query(
      `SELECT event_hash FROM eventfabric.events WHERE aggregate_name='Audit' AND aggregate_id='a1' AND aggregate_version=3`
    )).rows[0].event_hash;
    await pool.query(`DELETE FROM eventfabric.events WHERE aggregate_name='Audit' AND aggregate_id='a1' AND aggregate_version > 3`);
    await pool.query(
      `UPDATE eventfabric.stream_versions SET current_version=3, head_hash=$1 WHERE aggregate_name='Audit' AND aggregate_id='a1'`,
      [h3]
    );

    // Per-stream verify is fooled: v1..v3 is a valid chain matching head_hash.
    const perStream = await uow.withTransaction((tx) => s.verifyStream(tx, { aggregateName: "Audit", aggregateId: "a1" }));
    expect(perStream.ok).toBe(true);

    // The anchor catches it: it sealed a1@v5, and there is no event at v5 anymore.
    const v = await uow.withTransaction((tx) => sealer().verifyAnchors(tx));
    expect(v.ok).toBe(false);
    expect(v.failure?.kind).toBe("sealed-event-missing");
  });

  it("detects tampering with the anchor records themselves", async () => {
    const s = store();
    await append(s, "a1", 0, [ev(1)]);
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx) => sealer().seal(tx));

    // Mutate a sealed member's head without the secret — anchor_hash can't be
    // recomputed to match, so the chain re-derivation fails.
    await pool.query(
      `UPDATE eventfabric.event_chain_anchor_members SET sealed_head_hash = decode(repeat('00', 32), 'hex')
       WHERE aggregate_id='a1'`
    );

    const v = await uow.withTransaction((tx) => sealer().verifyAnchors(tx));
    expect(v.ok).toBe(false);
    expect(v.failure?.kind).toBe("anchor-hash-mismatch");
  });

  it("PgChainAnchorRunner.runOnce seals every tenant with chained streams", async () => {
    const s = store();
    await append(s, "a1", 0, [ev(1)]); // tenant "default"
    await new PgUnitOfWork(pool, "acme").withTransaction((tx) =>
      s.append(tx, { aggregateName: "Audit", aggregateId: "a1", expectedAggregateVersion: 0, events: [ev(1)] })
    );

    const sealedTenants: string[] = [];
    const runner = new PgChainAnchorRunner(pool, sealer(), {
      onSealed: (r) => { if (r.sealed) sealedTenants.push(r.tenantId); },
    });
    const results = await runner.runOnce();

    expect(results.filter((r) => r.sealed)).toHaveLength(2);
    expect(sealedTenants.sort()).toEqual(["acme", "default"]);

    for (const t of ["default", "acme"]) {
      const v = await new PgUnitOfWork(pool, t).withTransaction((tx) => sealer().verifyAnchors(tx, t));
      expect(v.ok).toBe(true);
    }
  });
});
