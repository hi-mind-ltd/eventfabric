import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgEventStore, SessionFactory, PgUnitOfWork, PgChainAnchorSealer, migrate } from "@eventfabric/postgres";
import { AccountAggregate } from "../src/domain/account.aggregate";
import type { BankingEvent } from "../src/domain/events";
import { AccountOpened } from "../src/domain/account.events";

const SECRET = "test-chain-secret";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;
let store: PgEventStore<BankingEvent>;
let factory: SessionFactory<BankingEvent>;
let sealer: PgChainAnchorSealer;

const ACCOUNT_EVENTS = [
  "AccountOpened", "AccountDeposited", "AccountWithdrawn",
  "WithdrawalCompleted", "DepositCompleted",
  "AccountTransferredOut", "AccountTransferredIn", "AccountClosed"
] as const;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
  // Same wiring as the app: a hash-chained store with the account ledger opted in.
  store = new PgEventStore<BankingEvent>({ hashChain: { secret: SECRET } });
  factory = new SessionFactory<BankingEvent>(pool, store);
  factory.registerAggregate(AccountAggregate, ACCOUNT_EVENTS, "account", { tamperEvident: true });
  sealer = new PgChainAnchorSealer({ secret: SECRET });
}, 120000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

const verifyAccount = (id: string) =>
  new PgUnitOfWork(pool).withTransaction((tx) =>
    store.verifyStream(tx, { aggregateName: AccountAggregate.aggregateName, aggregateId: id })
  );

async function openAndDeposit(id: string, deposits: number[]): Promise<void> {
  const s = factory.createSession();
  s.startStream(id, AccountOpened({ accountId: id, customerId: "c1", initialBalance: 0, currency: "USD", region: "us" }));
  await s.saveChangesAsync();
  if (deposits.length) {
    const s2 = factory.createSession();
    const acc = await s2.loadAggregateAsync<AccountAggregate>(id);
    for (const d of deposits) acc.deposit(d);
    await s2.saveChangesAsync();
  }
}

describe("banking-api: tamper-evident account ledger", () => {
  it("verifies an intact ledger (matches GET /accounts/:id/verify)", async () => {
    const id = "acc-ok";
    await openAndDeposit(id, [100, 50]);
    const r = await verifyAccount(id);
    expect(r.ok).toBe(true);
    expect(r.eventsChecked).toBe(3);
  });

  it("detects a forged ledger entry", async () => {
    const id = "acc-tampered";
    await openAndDeposit(id, [100, 50]);
    // Forge the first deposit's balance directly in the events table.
    await pool.query(
      `UPDATE eventfabric.events SET payload = jsonb_set(payload, '{balance}', '999999')
       WHERE aggregate_name=$1 AND aggregate_id=$2 AND aggregate_version=2`,
      [AccountAggregate.aggregateName, id]
    );
    const r = await verifyAccount(id);
    expect(r.ok).toBe(false);
    expect(r.firstBrokenAt).toBe(2);
    expect(r.reason).toMatch(/event_hash mismatch/);
  });

  it("anchor catches deletion of an entire account stream", async () => {
    const id = "acc-anchored";
    await openAndDeposit(id, [100]);

    await new PgUnitOfWork(pool).withTransaction((tx) => sealer.seal(tx));
    const ok = await new PgUnitOfWork(pool).withTransaction((tx) => sealer.verifyAnchors(tx));
    expect(ok.ok).toBe(true);

    // Erase the whole account — per-stream verify can't catch this; the anchor does.
    await pool.query(`DELETE FROM eventfabric.events WHERE aggregate_name=$1 AND aggregate_id=$2`, [AccountAggregate.aggregateName, id]);
    await pool.query(`DELETE FROM eventfabric.stream_versions WHERE aggregate_name=$1 AND aggregate_id=$2`, [AccountAggregate.aggregateName, id]);

    const bad = await new PgUnitOfWork(pool).withTransaction((tx) => sealer.verifyAnchors(tx));
    expect(bad.ok).toBe(false);
    expect(bad.failure?.kind).toBe("sealed-event-missing");
  });
});
