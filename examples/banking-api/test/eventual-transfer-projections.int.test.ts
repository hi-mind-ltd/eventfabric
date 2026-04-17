import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgEventStore, createCatchUpProjector, migrate } from "@eventfabric/postgres";
import type { PgTx } from "@eventfabric/postgres";
import { AccountAggregate } from "../src/domain/account.aggregate";
import { TransactionAggregate } from "../src/domain/transaction.aggregate";
import type { BankingEvent } from "../src/domain/events";
import {
  createWithdrawalProjection,
  createDepositProjection,
  createTransactionCompletionProjection
} from "../src/projections/eventual-transfer-projections";

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

describe("eventual transfer projections (integration)", () => {
  const eventStore = new PgEventStore<BankingEvent>();

  const projections = [
    createWithdrawalProjection(eventStore),
    createDepositProjection(eventStore),
    createTransactionCompletionProjection(eventStore)
  ];

  beforeEach(async () => {
    await pool.query(`DELETE FROM eventfabric.outbox_dead_letters`);
    await pool.query(`DELETE FROM eventfabric.outbox`);
    await pool.query(`DELETE FROM eventfabric.projection_checkpoints`);
    await pool.query(`DELETE FROM eventfabric.stream_versions`);
    await pool.query(`DELETE FROM eventfabric.events`);
  }, 60000);

  it("processes transfer start -> withdrawal -> deposit -> completion via catch-up", async () => {
    // Seed accounts and the initial TransactionStarted event
    const uowTx: PgTx = { client: await pool.connect(), tenantId: "default" } as any;
    try {
      await uowTx.client.query("BEGIN");
      await eventStore.append(uowTx, {
        aggregateName: AccountAggregate.aggregateName,
        aggregateId: "acc-A",
        expectedAggregateVersion: 0,
        events: [{
          type: "AccountOpened",
          version: 2,
          accountId: "acc-A",
          customerId: "cust-A",
          initialBalance: 200,
          currency: "USD",
          region: "unknown"
        } as BankingEvent]
      });
      await eventStore.append(uowTx, {
        aggregateName: AccountAggregate.aggregateName,
        aggregateId: "acc-B",
        expectedAggregateVersion: 0,
        events: [{
          type: "AccountOpened",
          version: 2,
          accountId: "acc-B",
          customerId: "cust-B",
          initialBalance: 50,
          currency: "USD",
          region: "unknown"
        } as BankingEvent]
      });
      // The transaction aggregate needs TransactionInitiated first (sets
      // from/to/amount on state) then TransactionStarted (flips status).
      await eventStore.append(uowTx, {
        aggregateName: TransactionAggregate.aggregateName,
        aggregateId: "tx-1",
        expectedAggregateVersion: 0,
        events: [
          {
            type: "TransactionInitiated",
            version: 1,
            transactionId: "tx-1",
            fromAccountId: "acc-A",
            toAccountId: "acc-B",
            amount: 40,
            currency: "USD"
          },
          {
            type: "TransactionStarted",
            version: 1,
            transactionId: "tx-1",
            fromAccountId: "acc-A",
            toAccountId: "acc-B",
            amount: 40,
            currency: "USD",
            startedAt: new Date().toISOString()
          }
        ] as BankingEvent[]
      });
      await uowTx.client.query("COMMIT");
    } finally {
      uowTx.client.release();
    }

    // Drive the catch-up projector until the chain reaches a fixed point.
    // Each catchUpAll call runs withdrawal → deposit → completion in order;
    // a new event emitted by one stage is picked up by the next stage on
    // the following iteration, so we loop until event count stops growing.
    const projector = createCatchUpProjector<BankingEvent>(pool, eventStore);

    const countEvents = async () => {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM eventfabric.events WHERE aggregate_id IN ('acc-A','acc-B','tx-1')`
      );
      return rows[0]?.c ?? 0;
    };

    const start = Date.now();
    let prev = -1;
    let current = await countEvents();
    while (Date.now() - start < 10000) {
      await projector.catchUpAll(projections, { batchSize: 100 });
      current = await countEvents();
      if (current === prev) break; // reached fixed point
      prev = current;
    }

    // Assert the full chain landed in order
    const events = await pool.query(
      `SELECT type, aggregate_id, aggregate_version FROM eventfabric.events WHERE aggregate_id IN ('acc-A','acc-B','tx-1') ORDER BY global_position`
    );
    const types = events.rows.map((r: any) => r.type);
    expect(types).toEqual([
      "AccountOpened",          // acc-A
      "AccountOpened",          // acc-B
      "TransactionInitiated",   // tx-1 (sets from/to/amount)
      "TransactionStarted",     // tx-1 (flips status)
      "AccountWithdrawn",       // acc-A domain event from withdraw()
      "WithdrawalCompleted",    // acc-A
      "AccountDeposited",       // acc-B domain event from deposit()
      "DepositCompleted",       // acc-B
      "TransactionCompleted"    // tx-1
    ]);

    // Verify versions advanced past the seed event
    const accAEvents = events.rows.filter((r: any) => r.aggregate_id === "acc-A");
    expect(accAEvents[accAEvents.length - 1].aggregate_version).toBeGreaterThan(0);
  }, 15000);
});
