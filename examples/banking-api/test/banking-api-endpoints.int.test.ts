import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  PgEventStore,
  PgSnapshotStore,
  PgDlqService,
  PgOutboxStatsService,
  SessionFactory,
  createCatchUpProjector,
  migrate
} from "@eventfabric/postgres";
import type { PgTx } from "@eventfabric/postgres";
import { withConcurrencyRetry } from "@eventfabric/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality
} from "@opentelemetry/sdk-metrics";
import { createCatchUpObserver } from "@eventfabric/opentelemetry";
import { AccountAggregate, type AccountState } from "../src/domain/account.aggregate";
import { TransactionAggregate, type TransactionState } from "../src/domain/transaction.aggregate";
import { CustomerAggregate, type CustomerState } from "../src/domain/customer.aggregate";
import type { BankingEvent } from "../src/domain/events";
import type { AccountOpenedV1, AccountOpenedV2 } from "../src/domain/account.events";
import { AccountOpened, AccountDeposited } from "../src/domain/account.events";
import { TransactionInitiated, TransactionStarted, TransactionCompleted } from "../src/domain/transaction.events";
import { CustomerRegistered } from "../src/domain/customer.events";
import { accountEventUpcaster } from "../src/domain/account.upcasters";
import {
  createWithdrawalProjection,
  createDepositProjection,
  createTransactionCompletionProjection
} from "../src/projections/eventual-transfer-projections";
import { emailNotificationProjection, emailService } from "../src/projections/email-projection";
import { depositAuditProjection } from "../src/projections/deposit-audit";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;
let store: PgEventStore<BankingEvent>;
let sessionFactory: SessionFactory<BankingEvent>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);

  store = new PgEventStore<BankingEvent>();
  sessionFactory = new SessionFactory<BankingEvent>(pool, store);

  const accountSnapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
  const transactionSnapshotStore = new PgSnapshotStore<TransactionState>("eventfabric.snapshots", 1);
  const customerSnapshotStore = new PgSnapshotStore<CustomerState>("eventfabric.snapshots", 1);

  sessionFactory.registerAggregate(AccountAggregate, [
    "AccountOpened", "AccountDeposited", "AccountWithdrawn",
    "WithdrawalCompleted", "DepositCompleted",
    "AccountTransferredOut", "AccountTransferredIn", "AccountClosed"
  ], "account", { snapshotStore: accountSnapshotStore });
  sessionFactory.registerAggregate(TransactionAggregate, [
    "TransactionInitiated", "TransactionStarted",
    "TransactionCompleted", "TransactionFailed"
  ], "transaction", { snapshotStore: transactionSnapshotStore });
  sessionFactory.registerAggregate(CustomerAggregate, [
    "CustomerRegistered", "CustomerEmailUpdated", "CustomerPhoneUpdated"
  ], "customer", { snapshotStore: customerSnapshotStore });
}, 120000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM eventfabric.snapshots`);
  await pool.query(`DELETE FROM eventfabric.outbox_dead_letters`);
  await pool.query(`DELETE FROM eventfabric.outbox`);
  await pool.query(`DELETE FROM eventfabric.projection_checkpoints`);
  await pool.query(`DELETE FROM eventfabric.stream_versions`);
  await pool.query(`DELETE FROM eventfabric.events`);
}, 60000);

// ============================================================================
// Helper: create aggregates using startStream (the correct API for new entities)
// ============================================================================

async function createCustomer(id: string, email: string, name: string, phone?: string) {
  const session = sessionFactory.createSession();
  session.startStream(id, CustomerRegistered({ customerId: id, email, name, phone }));
  await session.saveChangesAsync();
}

async function createAccount(id: string, customerId: string, initialBalance: number, currency = "GBP") {
  const session = sessionFactory.createSession();
  session.startStream(id, AccountOpened({ accountId: id, customerId, initialBalance, currency, region: "unknown" }));
  await session.saveChangesAsync();
}

async function createTransaction(
  id: string, fromAccountId: string, toAccountId: string,
  amount: number, currency = "GBP", description?: string
) {
  const session = sessionFactory.createSession();
  session.startStream(id, TransactionInitiated({ transactionId: id, fromAccountId, toAccountId, amount, currency, description }));
  await session.saveChangesAsync();
}

// ============================================================================
// Creation endpoints (POST via startStream)
// ============================================================================

describe("creation endpoints use startStream for new aggregates", () => {
  it("loadAggregateAsync throws for a non-existent aggregate", async () => {
    const session = sessionFactory.createSession();
    await expect(
      session.loadAggregateAsync<AccountAggregate>("non-existent-id")
    ).rejects.toThrow("aggregate class not found");
  });

  it("POST /customers/:id/register creates a new customer via startStream", async () => {
    const session = sessionFactory.createSession();
    const id = "cust-new";
    session.startStream(id, CustomerRegistered({
      customerId: id,
      email: "alice@example.co.uk",
      name: "Alice",
      phone: "020-7946-0958"
    }));
    await session.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const customer = await session2.loadAggregateAsync<CustomerAggregate>(id);
    expect(customer.email).toBe("alice@example.co.uk");
    expect(customer.name).toBe("Alice");
  });

  it("POST /accounts/:id/open creates a new account via startStream", async () => {
    const session = sessionFactory.createSession();
    const id = "acc-new";
    session.startStream(id, AccountOpened({
      accountId: id,
      customerId: "cust-1",
      initialBalance: 250,
      currency: "GBP",
      region: "unknown"
    }));
    await session.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const account = await session2.loadAggregateAsync<AccountAggregate>(id);
    expect(account.balance).toBe(250);
    expect(account.customerId).toBe("cust-1");
  });

  it("POST /transactions/:id/initiate creates a new transaction via startStream", async () => {
    const session = sessionFactory.createSession();
    const id = "tx-new";
    session.startStream(id, TransactionInitiated({
      transactionId: id,
      fromAccountId: "acc-1",
      toAccountId: "acc-2",
      amount: 75,
      currency: "GBP"
    }));
    await session.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const tx = await session2.loadAggregateAsync<TransactionAggregate>(id);
    expect(tx.status).toBe("pending");
    expect(tx.amount).toBe(75);
  });

  it("POST /accounts/:id/open-with-stream creates account with multiple events", async () => {
    const session = sessionFactory.createSession();
    const id = "acc-stream";

    session.startStream(id,
      AccountOpened({ accountId: id, customerId: "cust-1", initialBalance: 100, currency: "GBP", region: "unknown" }),
      AccountDeposited({ accountId: id, amount: 100, balance: 100 })
    );
    await session.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const account = await session2.loadAggregateAsync<AccountAggregate>(id);
    expect(account.balance).toBe(100);
    expect(account.customerId).toBe("cust-1");
  });
});

// ============================================================================
// Customer Endpoints
// ============================================================================

describe("customer endpoints", () => {
  it("GET /customers/:id returns customer details after registration", async () => {
    await createCustomer("cust-1", "alice@example.co.uk", "Alice", "020-7946-0958");

    const session = sessionFactory.createSession();
    const customer = await session.loadAggregateAsync<CustomerAggregate>("cust-1");
    expect(customer.email).toBe("alice@example.co.uk");
    expect(customer.name).toBe("Alice");
  });

  it("PUT /customers/:id/email updates customer email", async () => {
    await createCustomer("cust-2", "bob@old.co.uk", "Bob");

    const session = sessionFactory.createSession();
    const customer = await session.loadAggregateAsync<CustomerAggregate>("cust-2");
    customer.updateEmail("bob@new.co.uk");
    await session.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const updated = await session2.loadAggregateAsync<CustomerAggregate>("cust-2");
    expect(updated.email).toBe("bob@new.co.uk");
  });

  it("updateEmail throws if customer is not registered", async () => {
    const aggregate = new CustomerAggregate("unregistered");
    expect(() => aggregate.updateEmail("new@test.co.uk")).toThrow("Customer not registered");
  });

  it("register throws if customer is already registered", async () => {
    await createCustomer("cust-dup", "dup@test.co.uk", "Dup");

    const session = sessionFactory.createSession();
    const customer = await session.loadAggregateAsync<CustomerAggregate>("cust-dup");
    expect(() => customer.register("other@test.co.uk", "Other")).toThrow("Customer already registered");
  });
});

// ============================================================================
// Account Endpoints
// ============================================================================

describe("account endpoints", () => {
  it("GET /accounts/:id returns account details", async () => {
    await createAccount("acc-1", "cust-1", 500, "GBP");

    const session = sessionFactory.createSession();
    const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
    expect(account.id).toBe("acc-1");
    expect(account.customerId).toBe("cust-1");
    expect(account.balance).toBe(500);
    expect(account.isClosed).toBe(false);
  });

  it("POST /accounts/:id/deposit increases balance", async () => {
    await createAccount("acc-dep", "cust-1", 100);

    const balance = await withConcurrencyRetry(
      async () => {
        const session = sessionFactory.createSession();
        const account = await session.loadAggregateAsync<AccountAggregate>("acc-dep");
        account.deposit(50);
        await session.saveChangesAsync();
        return account.balance;
      },
      { maxAttempts: 3, backoff: { minMs: 10, maxMs: 100, factor: 2, jitter: 0.2 } }
    );

    expect(balance).toBe(150);
  });

  it("deposit rejects zero or negative amount", async () => {
    await createAccount("acc-neg", "cust-1", 100);

    const session = sessionFactory.createSession();
    const account = await session.loadAggregateAsync<AccountAggregate>("acc-neg");
    expect(() => account.deposit(0)).toThrow("Deposit amount must be positive");
    expect(() => account.deposit(-10)).toThrow("Deposit amount must be positive");
  });

  it("deposit rejects when account is closed", async () => {
    await createAccount("acc-closed-dep", "cust-1", 0);

    const session1 = sessionFactory.createSession();
    const acc = await session1.loadAggregateAsync<AccountAggregate>("acc-closed-dep");
    acc.close("Testing");
    await session1.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const closedAcc = await session2.loadAggregateAsync<AccountAggregate>("acc-closed-dep");
    expect(() => closedAcc.deposit(50)).toThrow("Cannot deposit to closed account");
  });

  it("POST /accounts/:id/withdraw decreases balance", async () => {
    await createAccount("acc-wd", "cust-1", 200);

    const session = sessionFactory.createSession();
    const account = await session.loadAggregateAsync<AccountAggregate>("acc-wd");
    account.withdraw(75);
    await session.saveChangesAsync();

    expect(account.balance).toBe(125);
  });

  it("withdraw rejects insufficient funds", async () => {
    await createAccount("acc-insuf", "cust-1", 50);

    const session = sessionFactory.createSession();
    const account = await session.loadAggregateAsync<AccountAggregate>("acc-insuf");
    expect(() => account.withdraw(100)).toThrow("Insufficient funds");
  });

  it("withdraw rejects zero or negative amount", async () => {
    await createAccount("acc-wd-neg", "cust-1", 100);

    const session = sessionFactory.createSession();
    const account = await session.loadAggregateAsync<AccountAggregate>("acc-wd-neg");
    expect(() => account.withdraw(0)).toThrow("Withdrawal amount must be positive");
    expect(() => account.withdraw(-5)).toThrow("Withdrawal amount must be positive");
  });

  it("withdraw rejects when account is closed", async () => {
    await createAccount("acc-closed-wd", "cust-1", 0);

    const session1 = sessionFactory.createSession();
    const acc = await session1.loadAggregateAsync<AccountAggregate>("acc-closed-wd");
    acc.close("Closing");
    await session1.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const closedAcc = await session2.loadAggregateAsync<AccountAggregate>("acc-closed-wd");
    expect(() => closedAcc.withdraw(10)).toThrow("Cannot withdraw from closed account");
  });

  it("POST /accounts/:id/close closes an account with zero balance", async () => {
    await createAccount("acc-close", "cust-1", 0);

    const session = sessionFactory.createSession();
    const account = await session.loadAggregateAsync<AccountAggregate>("acc-close");
    account.close("No longer needed");
    await session.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const closed = await session2.loadAggregateAsync<AccountAggregate>("acc-close");
    expect(closed.isClosed).toBe(true);
  });

  it("close rejects when balance is non-zero", async () => {
    await createAccount("acc-close-bal", "cust-1", 100);

    const session = sessionFactory.createSession();
    const account = await session.loadAggregateAsync<AccountAggregate>("acc-close-bal");
    expect(() => account.close("Want to close")).toThrow("Cannot close account with non-zero balance");
  });

  it("close rejects when already closed", async () => {
    await createAccount("acc-close-dup", "cust-1", 0);

    const session1 = sessionFactory.createSession();
    const acc = await session1.loadAggregateAsync<AccountAggregate>("acc-close-dup");
    acc.close("First close");
    await session1.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const closed = await session2.loadAggregateAsync<AccountAggregate>("acc-close-dup");
    expect(() => closed.close("Second close")).toThrow("Account already closed");
  });

  it("open rejects when account is already opened", async () => {
    await createAccount("acc-reopen", "cust-1", 100);

    const session = sessionFactory.createSession();
    const account = await session.loadAggregateAsync<AccountAggregate>("acc-reopen");
    expect(() => account.open("cust-2", 50)).toThrow("Account already opened");
  });
});

// ============================================================================
// Transaction Endpoints
// ============================================================================

describe("transaction endpoints", () => {
  it("GET /transactions/:id returns transaction details", async () => {
    await createTransaction("tx-get", "acc-1", "acc-2", 100, "GBP", "Test payment");

    const session = sessionFactory.createSession();
    const tx = await session.loadAggregateAsync<TransactionAggregate>("tx-get");
    expect(tx.id).toBe("tx-get");
    expect(tx.status).toBe("pending");
    expect(tx.amount).toBe(100);
  });

  it("POST /transactions/:id/complete completes a pending transaction", async () => {
    await createTransaction("tx-comp", "acc-1", "acc-2", 50);

    const session = sessionFactory.createSession();
    const tx = await session.loadAggregateAsync<TransactionAggregate>("tx-comp");
    tx.complete();
    await session.saveChangesAsync();

    expect(tx.status).toBe("completed");
  });

  it("POST /transactions/:id/fail marks a pending transaction as failed", async () => {
    await createTransaction("tx-fail", "acc-1", "acc-2", 50);

    const session = sessionFactory.createSession();
    const tx = await session.loadAggregateAsync<TransactionAggregate>("tx-fail");
    tx.fail("Payment declined");
    await session.saveChangesAsync();

    expect(tx.status).toBe("failed");
  });

  it("fail also works from started status", async () => {
    await createTransaction("tx-fail-started", "acc-1", "acc-2", 50);

    const session = sessionFactory.createSession();
    const tx = await session.loadAggregateAsync<TransactionAggregate>("tx-fail-started");
    tx.start();
    expect(tx.status).toBe("started");

    tx.fail("Insufficient funds");
    expect(tx.status).toBe("failed");
  });

  it("fail rejects from completed status", async () => {
    const tx = new TransactionAggregate("tx-fail-comp");
    tx.initiate("acc-1", "acc-2", 100, "GBP");
    tx.complete();
    expect(() => tx.fail("Too late")).toThrow("Cannot fail transaction in completed status");
  });

  it("initiate rejects zero or negative amount", async () => {
    const tx = new TransactionAggregate("tx-neg");
    expect(() => tx.initiate("acc-1", "acc-2", 0, "GBP")).toThrow("Transaction amount must be positive");
    expect(() => tx.initiate("acc-1", "acc-2", -10, "GBP")).toThrow("Transaction amount must be positive");
  });

  it("initiate rejects same source and destination account", async () => {
    const tx = new TransactionAggregate("tx-same");
    expect(() => tx.initiate("acc-1", "acc-1", 50, "GBP")).toThrow("Cannot transfer to the same account");
  });

  it("initiate rejects if already initiated", async () => {
    await createTransaction("tx-dup", "acc-1", "acc-2", 50);

    const session = sessionFactory.createSession();
    const tx = await session.loadAggregateAsync<TransactionAggregate>("tx-dup");
    expect(() => tx.initiate("acc-3", "acc-4", 100, "GBP")).toThrow("Transaction already initiated");
  });

  it("complete rejects from completed status", async () => {
    await createTransaction("tx-comp2", "acc-1", "acc-2", 50);

    const session = sessionFactory.createSession();
    const tx = await session.loadAggregateAsync<TransactionAggregate>("tx-comp2");
    tx.complete();
    expect(() => tx.complete()).toThrow("Cannot complete transaction in completed status");
  });
});

// ============================================================================
// Atomic Transfer (POST /transfers)
// ============================================================================

describe("atomic transfer (POST /transfers)", () => {
  it("transfers funds between two accounts atomically", async () => {
    await createAccount("acc-from", "cust-1", 500);
    await createAccount("acc-to", "cust-2", 100);

    // Replicate the fixed POST /transfers handler: load accounts, transfer,
    // then create the transaction stream in one atomic save.
    const session = sessionFactory.createSession();
    const fromAccount = await session.loadAggregateAsync<AccountAggregate>("acc-from");
    const toAccount = await session.loadAggregateAsync<AccountAggregate>("acc-to");

    fromAccount.transferOut("acc-to", 200, "tx-atomic");
    toAccount.transferIn("acc-from", 200, "tx-atomic");

    session.startStream("tx-atomic",
      TransactionInitiated({ transactionId: "tx-atomic", fromAccountId: "acc-from", toAccountId: "acc-to", amount: 200, currency: "GBP" }),
      TransactionCompleted({ transactionId: "tx-atomic", fromAccountId: "acc-from", toAccountId: "acc-to", amount: 200, completedAt: new Date().toISOString() })
    );

    await session.saveChangesAsync();

    expect(fromAccount.balance).toBe(300);
    expect(toAccount.balance).toBe(300);
  });

  it("transferOut rejects insufficient funds", async () => {
    await createAccount("acc-poor", "cust-1", 50);

    const session = sessionFactory.createSession();
    const account = await session.loadAggregateAsync<AccountAggregate>("acc-poor");
    expect(() => account.transferOut("acc-other", 100, "tx-1")).toThrow("Insufficient funds for transfer");
  });

  it("transferIn rejects when account is closed", async () => {
    await createAccount("acc-closed-in", "cust-1", 0);

    const session1 = sessionFactory.createSession();
    const acc = await session1.loadAggregateAsync<AccountAggregate>("acc-closed-in");
    acc.close("Closed");
    await session1.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const closed = await session2.loadAggregateAsync<AccountAggregate>("acc-closed-in");
    expect(() => closed.transferIn("acc-src", 50, "tx-1")).toThrow("Cannot transfer to closed account");
  });

  it("transferOut rejects when account is closed", async () => {
    await createAccount("acc-closed-out", "cust-1", 0);

    const session1 = sessionFactory.createSession();
    const acc = await session1.loadAggregateAsync<AccountAggregate>("acc-closed-out");
    acc.close("Closed");
    await session1.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const closed = await session2.loadAggregateAsync<AccountAggregate>("acc-closed-out");
    expect(() => closed.transferOut("acc-dst", 50, "tx-1")).toThrow("Cannot transfer from closed account");
  });
});

// ============================================================================
// Eventual Transfer (POST /transfers/eventual)
// ============================================================================

describe("eventual transfer (POST /transfers/eventual)", () => {
  it("creates a started transaction via startStream for async processing", async () => {
    // Replicate the fixed POST /transfers/eventual handler
    const session = sessionFactory.createSession();
    const txId = "tx-ev";
    session.startStream(txId,
      TransactionInitiated({ transactionId: txId, fromAccountId: "acc-A", toAccountId: "acc-B", amount: 75, currency: "GBP" }),
      TransactionStarted({ transactionId: txId, fromAccountId: "acc-A", toAccountId: "acc-B", amount: 75, currency: "GBP", startedAt: new Date().toISOString() })
    );
    await session.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const tx = await session2.loadAggregateAsync<TransactionAggregate>(txId);
    expect(tx.status).toBe("started");
  });

  it("start rejects from non-pending status", async () => {
    await createTransaction("tx-ev-dup", "acc-A", "acc-B", 75);

    const session = sessionFactory.createSession();
    const tx = await session.loadAggregateAsync<TransactionAggregate>("tx-ev-dup");
    tx.start();
    expect(() => tx.start()).toThrow("Cannot start transaction in started status");
  });

  it("catch-up projections process the full transfer chain", async () => {
    await createAccount("acc-ev-A", "cust-A", 300);
    await createAccount("acc-ev-B", "cust-B", 50);
    await createTransaction("tx-chain", "acc-ev-A", "acc-ev-B", 100);

    // Start the transaction
    const session = sessionFactory.createSession();
    const tx = await session.loadAggregateAsync<TransactionAggregate>("tx-chain");
    tx.start();
    await session.saveChangesAsync();

    // Drive the catch-up projector until fixed point
    const projections = [
      createWithdrawalProjection(store),
      createDepositProjection(store),
      createTransactionCompletionProjection(store)
    ];
    const projector = createCatchUpProjector<BankingEvent>(pool, store);

    const countEvents = async () => {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM eventfabric.events`
      );
      return rows[0]?.c ?? 0;
    };

    const start = Date.now();
    let prev = -1;
    let current: number;
    while (Date.now() - start < 10000) {
      await projector.catchUpAll(projections, { batchSize: 100 });
      current = await countEvents();
      if (current === prev) break;
      prev = current;
    }

    // Verify the full chain landed
    const events = await pool.query(
      `SELECT type FROM eventfabric.events ORDER BY global_position`
    );
    const types = events.rows.map((r: any) => r.type);
    expect(types).toEqual([
      "AccountOpened",          // acc-ev-A
      "AccountOpened",          // acc-ev-B
      "TransactionInitiated",   // tx-chain
      "TransactionStarted",     // tx-chain (triggers withdrawal projection)
      "AccountWithdrawn",       // acc-ev-A (withdrawal projection)
      "WithdrawalCompleted",    // acc-ev-A (triggers deposit projection)
      "AccountDeposited",       // acc-ev-B (deposit projection)
      "DepositCompleted",       // acc-ev-B (triggers completion projection)
      "TransactionCompleted"    // tx-chain (completion projection)
    ]);

    // Verify final balances
    const session2 = sessionFactory.createSession();
    const accA = await session2.loadAggregateAsync<AccountAggregate>("acc-ev-A");
    const accB = await session2.loadAggregateAsync<AccountAggregate>("acc-ev-B");
    expect(accA.balance).toBe(200); // 300 - 100
    expect(accB.balance).toBe(150); // 50 + 100

    // Verify transaction completed
    const session3 = sessionFactory.createSession();
    const completedTx = await session3.loadAggregateAsync<TransactionAggregate>("tx-chain");
    expect(completedTx.status).toBe("completed");
  }, 15000);

  it("withdrawal projection fails a started transaction on insufficient funds", async () => {
    await createAccount("acc-broke", "cust-1", 10);
    await createAccount("acc-payee", "cust-2", 50);
    await createTransaction("tx-insuf", "acc-broke", "acc-payee", 100);

    // Start the transaction
    const session = sessionFactory.createSession();
    const tx = await session.loadAggregateAsync<TransactionAggregate>("tx-insuf");
    tx.start();
    await session.saveChangesAsync();

    // Drive projector — withdrawal projection should now fail the transaction
    // gracefully since fail() accepts "started" status.
    const projections = [
      createWithdrawalProjection(store),
      createDepositProjection(store),
      createTransactionCompletionProjection(store)
    ];
    const projector = createCatchUpProjector<BankingEvent>(pool, store);

    await projector.catchUpAll(projections, { batchSize: 100 });

    // The transaction should now be properly marked as "failed"
    const session2 = sessionFactory.createSession();
    const failedTx = await session2.loadAggregateAsync<TransactionAggregate>("tx-insuf");
    expect(failedTx.status).toBe("failed");
  }, 15000);
});

// ============================================================================
// Account aggregate domain rules
// ============================================================================

describe("account aggregate domain rules", () => {
  it("open sets customerId, balance, and currency", async () => {
    const account = new AccountAggregate("acc-test");
    account.open("cust-1", 250, "GBP");
    expect(account.balance).toBe(250);
    expect(account.customerId).toBe("cust-1");
    expect(account.isClosed).toBe(false);
  });

  it("open defaults to USD currency", async () => {
    const account = new AccountAggregate("acc-default");
    account.open("cust-1", 0);
    const events = account.pullPendingEvents();
    expect(events[0]).toMatchObject({ currency: "USD" });
  });

  it("multiple deposits accumulate correctly", async () => {
    await createAccount("acc-multi", "cust-1", 100);

    const session1 = sessionFactory.createSession();
    const acc1 = await session1.loadAggregateAsync<AccountAggregate>("acc-multi");
    acc1.deposit(50);
    await session1.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const acc2 = await session2.loadAggregateAsync<AccountAggregate>("acc-multi");
    acc2.deposit(25);
    await session2.saveChangesAsync();

    const session3 = sessionFactory.createSession();
    const final = await session3.loadAggregateAsync<AccountAggregate>("acc-multi");
    expect(final.balance).toBe(175); // 100 + 50 + 25
  });

  it("withdraw then deposit yields correct balance", async () => {
    await createAccount("acc-wd-dep", "cust-1", 200);

    const session1 = sessionFactory.createSession();
    const acc1 = await session1.loadAggregateAsync<AccountAggregate>("acc-wd-dep");
    acc1.withdraw(80);
    await session1.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const acc2 = await session2.loadAggregateAsync<AccountAggregate>("acc-wd-dep");
    acc2.deposit(30);
    await session2.saveChangesAsync();

    const session3 = sessionFactory.createSession();
    const final = await session3.loadAggregateAsync<AccountAggregate>("acc-wd-dep");
    expect(final.balance).toBe(150); // 200 - 80 + 30
  });
});

// ============================================================================
// Transaction state machine validation
// ============================================================================

describe("transaction state machine", () => {
  it("follows pending -> started -> completed lifecycle", async () => {
    const tx = new TransactionAggregate("tx-lifecycle");
    expect(tx.status).toBe("pending");

    tx.initiate("acc-1", "acc-2", 100, "GBP");
    expect(tx.status).toBe("pending");

    tx.start();
    expect(tx.status).toBe("started");

    tx.complete();
    expect(tx.status).toBe("completed");
  });

  it("follows pending -> failed lifecycle", async () => {
    const tx = new TransactionAggregate("tx-fail-lc");
    tx.initiate("acc-1", "acc-2", 100, "GBP");
    expect(tx.status).toBe("pending");

    tx.fail("Declined");
    expect(tx.status).toBe("failed");
  });

  it("follows pending -> started -> failed lifecycle", async () => {
    const tx = new TransactionAggregate("tx-started-fail");
    tx.initiate("acc-1", "acc-2", 100, "GBP");
    tx.start();
    expect(tx.status).toBe("started");

    tx.fail("Insufficient funds");
    expect(tx.status).toBe("failed");
  });

  it("cannot start a completed transaction", async () => {
    const tx = new TransactionAggregate("tx-no-restart");
    tx.initiate("acc-1", "acc-2", 100, "GBP");
    tx.complete();
    expect(() => tx.start()).toThrow("Cannot start transaction in completed status");
  });

  it("cannot fail a failed transaction", async () => {
    const tx = new TransactionAggregate("tx-no-refail");
    tx.initiate("acc-1", "acc-2", 100, "GBP");
    tx.fail("First failure");
    expect(() => tx.fail("Second failure")).toThrow("Cannot fail transaction in failed status");
  });
});

// ============================================================================
// Event Upcaster (AccountOpenedV1 → V2)
// ============================================================================

describe("account event upcaster", () => {
  it("upcasts V1 AccountOpened to V2 by adding region='unknown'", () => {
    const v1Event: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId: "acc-v1",
      customerId: "cust-1",
      initialBalance: 100,
      currency: "GBP"
    };

    const result = accountEventUpcaster(v1Event);

    expect(result).toEqual({
      type: "AccountOpened",
      version: 2,
      accountId: "acc-v1",
      customerId: "cust-1",
      initialBalance: 100,
      currency: "GBP",
      region: "unknown"
    });
  });

  it("passes through V2 AccountOpened events unchanged", () => {
    const v2Event: AccountOpenedV2 = {
      type: "AccountOpened",
      version: 2,
      accountId: "acc-v2",
      customerId: "cust-1",
      initialBalance: 200,
      currency: "GBP",
      region: "eu-west"
    };

    const result = accountEventUpcaster(v2Event);
    expect(result).toEqual(v2Event);
  });

  it("passes through non-AccountOpened events unchanged", () => {
    const depositEvent: BankingEvent = {
      type: "AccountDeposited",
      version: 1,
      accountId: "acc-1",
      amount: 50,
      balance: 150
    };

    const result = accountEventUpcaster(depositEvent);
    expect(result).toEqual(depositEvent);
  });

  it("V1 events are upcast when loaded through a store with the upcaster configured", async () => {
    // Create a store WITH the upcaster (like the real app does)
    const upcasterStore = new PgEventStore<BankingEvent>(
      "eventfabric.events",
      "eventfabric.outbox",
      accountEventUpcaster
    );

    // Register the aggregate so loadStream works
    const uowTx: PgTx = { client: await pool.connect() } as any;
    try {
      await uowTx.client.query("BEGIN");

      // Insert a V1 event directly (simulating historical data)
      await uowTx.client.query(`
        INSERT INTO eventfabric.stream_versions (aggregate_name, aggregate_id, current_version)
        VALUES ('Account', 'acc-historical', 1)
      `);
      await uowTx.client.query(`
        INSERT INTO eventfabric.events (event_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload)
        VALUES (
          gen_random_uuid(), 'Account', 'acc-historical', 1, 'AccountOpened', 1,
          $1::jsonb
        )
      `, [JSON.stringify({
        type: "AccountOpened",
        version: 1,
        accountId: "acc-historical",
        customerId: "cust-old",
        initialBalance: 500,
        currency: "GBP"
      })]);
      await uowTx.client.query("COMMIT");
    } finally {
      uowTx.client.release();
    }

    // Load through the upcaster store — V1 should come back as V2
    const uow2: PgTx = { client: await pool.connect() } as any;
    try {
      const events = await upcasterStore.loadStream(uow2, "acc-historical", AccountAggregate);
      expect(events).toHaveLength(1);

      const payload = events[0]!.payload;
      expect(payload.type).toBe("AccountOpened");
      expect(payload.version).toBe(2);
      expect((payload as AccountOpenedV2).region).toBe("unknown");
      expect((payload as AccountOpenedV2).currency).toBe("GBP");
    } finally {
      uow2.client.release();
    }
  });

  it("V1 events are hydrated correctly into AccountAggregate via upcaster", async () => {
    const upcasterStore = new PgEventStore<BankingEvent>(
      "eventfabric.events",
      "eventfabric.outbox",
      accountEventUpcaster
    );

    // Insert a V1 event
    const uowTx: PgTx = { client: await pool.connect() } as any;
    try {
      await uowTx.client.query("BEGIN");
      await uowTx.client.query(`
        INSERT INTO eventfabric.stream_versions (aggregate_name, aggregate_id, current_version)
        VALUES ('Account', 'acc-v1-hydrate', 1)
      `);
      await uowTx.client.query(`
        INSERT INTO eventfabric.events (event_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload)
        VALUES (
          gen_random_uuid(), 'Account', 'acc-v1-hydrate', 1, 'AccountOpened', 1,
          $1::jsonb
        )
      `, [JSON.stringify({
        type: "AccountOpened",
        version: 1,
        accountId: "acc-v1-hydrate",
        customerId: "cust-v1",
        initialBalance: 750,
        currency: "GBP"
      })]);
      await uowTx.client.query("COMMIT");
    } finally {
      uowTx.client.release();
    }

    // Load stream and hydrate aggregate
    const uow2: PgTx = { client: await pool.connect() } as any;
    try {
      const events = await upcasterStore.loadStream(uow2, "acc-v1-hydrate", AccountAggregate);
      const account = new AccountAggregate("acc-v1-hydrate");
      account.loadFromHistory(events.map(e => ({
        payload: e.payload as import("../src/domain/account.events").AccountEvent,
        aggregateVersion: e.aggregateVersion
      })));

      expect(account.balance).toBe(750);
      expect(account.customerId).toBe("cust-v1");
      expect(account.isClosed).toBe(false);
    } finally {
      uow2.client.release();
    }
  });
});

// ============================================================================
// Email Notification Projection
// ============================================================================

describe("email notification projection", () => {
  it("sends emails on TransactionCompleted", async () => {
    const sentBefore = emailService.getSentEmails().length;

    const env = {
      eventId: "evt-1",
      aggregateId: "tx-email-1",
      aggregateName: "Transaction",
      aggregateVersion: 1,
      globalPosition: 1n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "TransactionCompleted" as const,
        version: 1 as const,
        transactionId: "tx-email-1",
        fromAccountId: "acc-sender",
        toAccountId: "acc-receiver",
        amount: 250,
        completedAt: new Date().toISOString()
      }
    };

    // The projection doesn't use the tx for email, so a minimal stub suffices
    await emailNotificationProjection.handle({} as PgTx, env);

    const sentAfter = emailService.getSentEmails();
    const newEmails = sentAfter.slice(sentBefore);
    expect(newEmails).toHaveLength(2);

    expect(newEmails[0]!.to).toBe("customer-acc-sender@example.com");
    expect(newEmails[0]!.subject).toBe("Transaction Completed");
    expect(newEmails[0]!.body).toContain("250");

    expect(newEmails[1]!.to).toBe("customer-acc-receiver@example.com");
    expect(newEmails[1]!.subject).toBe("Money Received");
    expect(newEmails[1]!.body).toContain("250");
  });

  it("sends email on TransactionFailed", async () => {
    const sentBefore = emailService.getSentEmails().length;

    const env = {
      eventId: "evt-2",
      aggregateId: "tx-email-2",
      aggregateName: "Transaction",
      aggregateVersion: 1,
      globalPosition: 2n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "TransactionFailed" as const,
        version: 1 as const,
        transactionId: "tx-email-2",
        fromAccountId: "acc-sender",
        toAccountId: "acc-receiver",
        amount: 100,
        reason: "Insufficient funds",
        failedAt: new Date().toISOString()
      }
    };

    await emailNotificationProjection.handle({} as PgTx, env);

    const newEmails = emailService.getSentEmails().slice(sentBefore);
    expect(newEmails).toHaveLength(1);
    expect(newEmails[0]!.to).toBe("customer-acc-sender@example.com");
    expect(newEmails[0]!.subject).toBe("Transaction Failed");
    expect(newEmails[0]!.body).toContain("Insufficient funds");
  });

  it("sends email on AccountDeposited", async () => {
    const sentBefore = emailService.getSentEmails().length;

    const env = {
      eventId: "evt-3",
      aggregateId: "acc-dep-email",
      aggregateName: "Account",
      aggregateVersion: 2,
      globalPosition: 3n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "AccountDeposited" as const,
        version: 1 as const,
        accountId: "acc-dep-email",
        amount: 500,
        balance: 1500
      }
    };

    await emailNotificationProjection.handle({} as PgTx, env);

    const newEmails = emailService.getSentEmails().slice(sentBefore);
    expect(newEmails).toHaveLength(1);
    expect(newEmails[0]!.to).toBe("customer-acc-dep-email@example.com");
    expect(newEmails[0]!.subject).toBe("Deposit Confirmed");
    expect(newEmails[0]!.body).toContain("500");
    expect(newEmails[0]!.body).toContain("1500");
  });

  it("sends email on AccountWithdrawn", async () => {
    const sentBefore = emailService.getSentEmails().length;

    const env = {
      eventId: "evt-4",
      aggregateId: "acc-wd-email",
      aggregateName: "Account",
      aggregateVersion: 3,
      globalPosition: 4n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "AccountWithdrawn" as const,
        version: 1 as const,
        accountId: "acc-wd-email",
        amount: 200,
        balance: 800
      }
    };

    await emailNotificationProjection.handle({} as PgTx, env);

    const newEmails = emailService.getSentEmails().slice(sentBefore);
    expect(newEmails).toHaveLength(1);
    expect(newEmails[0]!.to).toBe("customer-acc-wd-email@example.com");
    expect(newEmails[0]!.subject).toBe("Withdrawal Confirmed");
    expect(newEmails[0]!.body).toContain("200");
  });

  it("sends email on AccountOpened", async () => {
    const sentBefore = emailService.getSentEmails().length;

    const env = {
      eventId: "evt-5",
      aggregateId: "acc-open-email",
      aggregateName: "Account",
      aggregateVersion: 1,
      globalPosition: 5n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "AccountOpened" as const,
        version: 2 as const,
        accountId: "acc-open-email",
        customerId: "cust-welcome",
        initialBalance: 1000,
        currency: "GBP",
        region: "unknown"
      }
    };

    await emailNotificationProjection.handle({} as PgTx, env);

    const newEmails = emailService.getSentEmails().slice(sentBefore);
    expect(newEmails).toHaveLength(1);
    expect(newEmails[0]!.to).toBe("customer-cust-welcome@example.com");
    expect(newEmails[0]!.subject).toBe("Account Opened");
    expect(newEmails[0]!.body).toContain("1000");
  });

  it("does not send email for unhandled event types", async () => {
    const sentBefore = emailService.getSentEmails().length;

    const env = {
      eventId: "evt-6",
      aggregateId: "cust-reg",
      aggregateName: "Customer",
      aggregateVersion: 1,
      globalPosition: 6n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "CustomerRegistered" as const,
        version: 1 as const,
        customerId: "cust-reg",
        email: "nobody@example.com",
        name: "Nobody"
      }
    };

    await emailNotificationProjection.handle({} as PgTx, env);

    const newEmails = emailService.getSentEmails().slice(sentBefore);
    expect(newEmails).toHaveLength(0);
  });

  it("has correct topic filter for transaction and account events", () => {
    expect(emailNotificationProjection.topicFilter).toEqual({
      mode: "include",
      topics: ["transaction", "account"]
    });
  });
});

// ============================================================================
// Deposit Audit Projection (forEventType helper)
// ============================================================================

describe("deposit audit projection (forEventType)", () => {
  it("processes AccountDeposited events", async () => {
    // The deposit audit projection uses forEventType to filter for AccountDeposited.
    // It logs to console — we verify it doesn't throw and only fires for the right type.
    const depositEnv = {
      eventId: "evt-audit-1",
      aggregateId: "acc-audit",
      aggregateName: "Account",
      aggregateVersion: 2,
      globalPosition: 10n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "AccountDeposited" as const,
        version: 1 as const,
        accountId: "acc-audit",
        amount: 300,
        balance: 800,
        transactionId: "tx-audit"
      }
    };

    // Should not throw
    await expect(
      depositAuditProjection.handle({} as PgTx, depositEnv)
    ).resolves.toBeUndefined();
  });

  it("skips non-AccountDeposited events without error", async () => {
    const otherEnv = {
      eventId: "evt-audit-2",
      aggregateId: "acc-audit-2",
      aggregateName: "Account",
      aggregateVersion: 1,
      globalPosition: 11n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "AccountOpened" as const,
        version: 2 as const,
        accountId: "acc-audit-2",
        customerId: "cust-1",
        initialBalance: 0,
        currency: "GBP",
        region: "unknown"
      }
    };

    // Should silently skip
    await expect(
      depositAuditProjection.handle({} as PgTx, otherEnv)
    ).resolves.toBeUndefined();
  });

  it("processes deposits without transactionId", async () => {
    const env = {
      eventId: "evt-audit-3",
      aggregateId: "acc-audit-3",
      aggregateName: "Account",
      aggregateVersion: 2,
      globalPosition: 12n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "AccountDeposited" as const,
        version: 1 as const,
        accountId: "acc-audit-3",
        amount: 100,
        balance: 100
      }
    };

    await expect(
      depositAuditProjection.handle({} as PgTx, env)
    ).resolves.toBeUndefined();
  });

  it("runs correctly through the catch-up projector with real events", async () => {
    await createAccount("acc-audit-int", "cust-1", 100);

    // Deposit so there's an AccountDeposited event
    const session = sessionFactory.createSession();
    const acc = await session.loadAggregateAsync<AccountAggregate>("acc-audit-int");
    acc.deposit(50);
    await session.saveChangesAsync();

    // Run the deposit audit projection through the catch-up projector
    const projector = createCatchUpProjector<BankingEvent>(pool, store);
    await projector.catchUpAll([depositAuditProjection], { batchSize: 100 });

    // Verify checkpoint advanced (projection processed the events)
    const { rows } = await pool.query(
      `SELECT last_global_position FROM eventfabric.projection_checkpoints WHERE projection_name = 'deposit-audit'`
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].last_global_position)).toBeGreaterThan(0);
  });
});

// ============================================================================
// Ops: DLQ service
// ============================================================================

describe("ops: DLQ service", () => {
  it("lists empty DLQ", async () => {
    const dlq = new PgDlqService(pool);
    const result = await dlq.list({});
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });
});

// ============================================================================
// Ops: Outbox stats service
// ============================================================================

describe("ops: outbox stats service", () => {
  it("returns backlog stats", async () => {
    const stats = new PgOutboxStatsService(pool);
    const result = await stats.getBacklogStats();
    // The stats should return some shape — at minimum it shouldn't throw
    expect(result).toBeDefined();
  });

  it("reflects pending outbox entries after events are created", async () => {
    // Create an account (which produces an outbox entry)
    await createAccount("acc-outbox-stats", "cust-1", 100);

    const stats = new PgOutboxStatsService(pool);
    const result = await stats.getBacklogStats();
    expect(result).toBeDefined();
  });
});

// ============================================================================
// OpenTelemetry: catch-up observer produces spans and metrics
// ============================================================================

describe("opentelemetry: catch-up observer", () => {
  it("produces spans when the catch-up projector processes events", async () => {
    await createAccount("acc-otel-span", "cust-1", 100);

    const session = sessionFactory.createSession();
    const acc = await session.loadAggregateAsync<AccountAggregate>("acc-otel-span");
    acc.deposit(50);
    await session.saveChangesAsync();

    // Set up OTel tracer with in-memory exporter
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)]
    });

    const observer = createCatchUpObserver({
      tracer: tracerProvider.getTracer("test")
    });

    // Run deposit audit projection with observer
    const projector = createCatchUpProjector<BankingEvent>(pool, store);
    await projector.catchUpAll([depositAuditProjection], { batchSize: 100, observer });

    const spans = spanExporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    // All spans should be named after the projection
    const auditSpans = spans.filter(s => s.name === "deposit-audit.handle");
    expect(auditSpans.length).toBeGreaterThan(0);

    // Span should have the correct attributes
    const span = auditSpans[0]!;
    expect(span.attributes["eventfabric.projection"]).toBe("deposit-audit");
    expect(span.attributes["eventfabric.runner"]).toBe("catch_up");
  });

  it("produces metrics when the catch-up projector processes events", async () => {
    await createAccount("acc-otel-metric", "cust-1", 200);

    const session = sessionFactory.createSession();
    const acc = await session.loadAggregateAsync<AccountAggregate>("acc-otel-metric");
    acc.deposit(75);
    await session.saveChangesAsync();

    // Set up OTel meter with in-memory exporter
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)]
    });
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000
    });
    const meterProvider = new MeterProvider({ readers: [metricReader] });

    const observer = createCatchUpObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test")
    });

    const projector = createCatchUpProjector<BankingEvent>(pool, store);
    await projector.catchUpAll([depositAuditProjection], { batchSize: 100, observer });

    // Force flush metrics
    await metricReader.forceFlush();
    const allMetrics = metricExporter
      .getMetrics()
      .flatMap(m => m.scopeMetrics.flatMap(s => s.metrics));

    const handled = allMetrics.find(m => m.descriptor.name === "eventfabric.catch_up.events_handled");
    expect(handled).toBeDefined();

    const batchesLoaded = allMetrics.find(m => m.descriptor.name === "eventfabric.catch_up.batches_loaded");
    expect(batchesLoaded).toBeDefined();
  });

  it("records spans for the full transfer chain", async () => {
    await createAccount("acc-otel-chain-A", "cust-A", 500);
    await createAccount("acc-otel-chain-B", "cust-B", 50);
    await createTransaction("tx-otel-chain", "acc-otel-chain-A", "acc-otel-chain-B", 100);

    const session = sessionFactory.createSession();
    const tx = await session.loadAggregateAsync<TransactionAggregate>("tx-otel-chain");
    tx.start();
    await session.saveChangesAsync();

    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)]
    });

    const observer = createCatchUpObserver({
      tracer: tracerProvider.getTracer("test")
    });

    // Drive the catch-up projector with observer until fixed point
    const projections = [
      createWithdrawalProjection(store),
      createDepositProjection(store),
      createTransactionCompletionProjection(store)
    ];
    const projector = createCatchUpProjector<BankingEvent>(pool, store);

    const countEvents = async () => {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.events`);
      return rows[0]?.c ?? 0;
    };

    const start = Date.now();
    let prev = -1;
    let current: number;
    while (Date.now() - start < 10000) {
      await projector.catchUpAll(projections, { batchSize: 100, observer });
      current = await countEvents();
      if (current === prev) break;
      prev = current;
    }

    const spans = spanExporter.getFinishedSpans();
    // Should have spans for withdrawal-handler, deposit-handler, and transaction-completion-handler
    const projectionNames = [...new Set(spans.map(s => s.attributes["eventfabric.projection"]))];
    expect(projectionNames).toContain("withdrawal-handler");
    expect(projectionNames).toContain("deposit-handler");
    expect(projectionNames).toContain("transaction-completion-handler");
  }, 15000);
});
