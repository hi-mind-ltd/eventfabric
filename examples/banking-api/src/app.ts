import express from "express";
import { Pool } from "pg";
import {
  PgEventStore,
  PgSnapshotStore,
  PgDlqService,
  PgOutboxStatsService,
  createAsyncProjectionRunner,
  createCatchUpProjector,
  SessionFactory,
  query,
  migrate
} from "@eventfabric/postgres";
import { sleep, withConcurrencyRetry } from "@eventfabric/core";
import { AccountAggregate, type AccountState } from "./domain/account.aggregate";
import { TransactionAggregate, type TransactionState } from "./domain/transaction.aggregate";
import { CustomerAggregate, type CustomerState } from "./domain/customer.aggregate";
import type { BankingEvent } from "./domain/events";
import { AccountOpened, AccountDeposited } from "./domain/account.events";
import { TransactionInitiated, TransactionStarted, TransactionCompleted } from "./domain/transaction.events";
import { CustomerRegistered } from "./domain/customer.events";
import { accountEventUpcaster } from "./domain/account.upcasters";
import { emailNotificationProjection } from "./projections/email-projection";
import {
  createWithdrawalProjection,
  createDepositProjection,
  createTransactionCompletionProjection
} from "./projections/eventual-transfer-projections";
import { depositAuditProjection } from "./projections/deposit-audit";
import { createDlqRouter } from "./ops/dlq-router";
import { createOutboxOpsRouter } from "./ops/outbox-ops-router";
import { createPartitionOpsRouter } from "./ops/partition-ops-router";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// The upcaster is applied to every loaded event payload. Historical
// AccountOpenedV1 events are migrated to V2 (with region="unknown") before
// they reach handlers, projections, or read models.
const store = new PgEventStore<BankingEvent>({ upcaster: accountEventUpcaster });

// Snapshots for each aggregate type (optional, for performance)
const accountSnapshotStore = new PgSnapshotStore<AccountState>();
const transactionSnapshotStore = new PgSnapshotStore<TransactionState>();
const customerSnapshotStore = new PgSnapshotStore<CustomerState>();

// Session factory - configured once, creates sessions per request
const sessionFactory = new SessionFactory<BankingEvent>(pool, store);

// Register aggregates with their event types and snapshot stores (done once)
sessionFactory.registerAggregate(AccountAggregate, [
  "AccountOpened",
  "AccountDeposited",
  "AccountWithdrawn",
  "WithdrawalCompleted",
  "DepositCompleted",
  "AccountTransferredOut",
  "AccountTransferredIn",
  "AccountClosed"
], "account", { snapshotStore: accountSnapshotStore });
sessionFactory.registerAggregate(TransactionAggregate, [
  "TransactionInitiated",
  "TransactionStarted",
  "TransactionCompleted",
  "TransactionFailed"
], "transaction", { snapshotStore: transactionSnapshotStore });
sessionFactory.registerAggregate(CustomerAggregate, [
  "CustomerRegistered",
  "CustomerEmailUpdated",
  "CustomerPhoneUpdated"
], "customer", { snapshotStore: customerSnapshotStore });

// ===== Projection wiring =====
//
// Two async tiers, each picked for what it actually needs:
//
//   1. Outbox-based async runner for the *email notification* projection.
//      Email is external delivery — it calls a third-party service — and
//      that's the textbook reason to use the outbox pattern: at-least-once
//      delivery with per-message retry/DLQ.
//
//   2. Catch-up projector for the *transfer chain* (withdrawal → deposit →
//      completion). The chain is a process manager producing internal state
//      transitions. Each projection tracks its own checkpoint in
//      eventfabric.projection_checkpoints and reads straight from the events table.
//      No outbox rows, no topic routing, no dead-chain footgun.
//
// Both tiers run in background workers. Both are eventually consistent.
// The only difference is how each finds its next event: the outbox runner
// claims rows from eventfabric.outbox; the catch-up projector reads forward from
// its checkpoint.

// Observability via OpenTelemetry. The OTel adapter wraps handler execution
// in an active span (so pg/http child spans attach automatically) and emits
// counters + a duration histogram per projection.
import { trace, metrics } from "@opentelemetry/api";
import { createAsyncRunnerObserver, createCatchUpObserver } from "@eventfabric/opentelemetry";

const asyncObserver = createAsyncRunnerObserver({
  tracer: trace.getTracer("banking-api"),
  meter: metrics.getMeter("banking-api")
});

const catchUpObserver = createCatchUpObserver({
  tracer: trace.getTracer("banking-api"),
  meter: metrics.getMeter("banking-api")
});

// Outbox runner: email notifications (external delivery)
const emailRunner = createAsyncProjectionRunner(pool, store, [emailNotificationProjection], {
  workerId: "email-worker-1",
  batchSize: 10,
  idleSleepMs: 1000,
  maxAttempts: 5,
  transactionMode: "batch",
  backoff: {
    minMs: 100,
    maxMs: 5000,
    factor: 2,
    jitter: 0.1
  },
  observer: asyncObserver
});

// Catch-up projector: transfer chain (internal state transitions) plus a
// single-event-type audit projection built with the `forEventType` helper.
// All projections share the same CatchUpProjector — each tracks its own
// checkpoint independently, so they compose without any coordination.
const catchUpProjections = [
  createWithdrawalProjection(store),
  createDepositProjection(store),
  createTransactionCompletionProjection(store),
  depositAuditProjection
];
const catchUpProjector = createCatchUpProjector<BankingEvent>(pool, store);

// Start async projection runners
const abortController = new AbortController();
emailRunner.start(abortController.signal).catch((err) => {
  console.error("Email projection runner error:", err);
});

// Catch-up polling loop. catchUpAll runs the three projections sequentially;
// each one advances its own checkpoint independently. When there's nothing
// new to process, sleep for idleMs and try again.
(async () => {
  const idleMs = 500;
  while (!abortController.signal.aborted) {
    try {
      await catchUpProjector.catchUpAll(catchUpProjections, { batchSize: 100, observer: catchUpObserver });
    } catch (err) {
      console.error("Transfer catch-up projector error:", err);
    }
    try {
      await sleep(idleMs, abortController.signal);
    } catch {
      // AbortError on shutdown — fall through and exit the loop
      break;
    }
  }
})();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  abortController.abort();
  pool.end();
  process.exit(0);
});

// DLQ and Outbox stats services
const dlq = new PgDlqService(pool);
const outboxStats = new PgOutboxStatsService(pool);

const app = express();
app.use(express.json());

// ========== Customer Endpoints ==========
app.post("/customers/:id/register", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { email, name, phone } = req.body;
    session.startStream(id, CustomerRegistered({ customerId: id, email, name, phone }));
    await session.saveChangesAsync();
    res.json({ ok: true, customerId: id });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/customers/:id/email", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { email } = req.body;
    const customer = await session.loadAggregateAsync<CustomerAggregate>(id);
    customer.updateEmail(email);
    await session.saveChangesAsync();
    res.json({ ok: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/customers/:id", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const customer = await session.loadAggregateAsync<CustomerAggregate>(id);

    res.json({
      id: customer.id,
      email: customer.email,
      name: customer.name
    });
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
});

// ========== Account Endpoints ==========
app.post("/accounts/:id/open", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { customerId, initialBalance, currency, region } = req.body;
    const bal = initialBalance || 0;
    const cur = currency || "USD";
    session.startStream(id, AccountOpened({ accountId: id, customerId, initialBalance: bal, currency: cur, region: region ?? "unknown" }));
    await session.saveChangesAsync();
    res.json({ ok: true, accountId: id, balance: bal });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Example endpoint using Marten-style startStream API
app.post("/accounts/:id/open-with-stream", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { customerId, initialBalance, currency } = req.body;
    
    // Marten-style API: Start a new stream with typed events
    // TypeScript infers the aggregate from the event types!
    // Similar to: session.Events.StartStream(questId, started, joined1)
    const bal = initialBalance || 0;

    // Start stream - operations are queued until saveChangesAsync is called
    session.startStream(id,
      AccountOpened({ accountId: id, customerId, initialBalance: bal, currency: currency || "USD", region: req.body.region ?? "unknown" }),
      AccountDeposited({ accountId: id, amount: bal, balance: bal })
    );
    await session.saveChangesAsync();
    
    // Load the account to return its state
    const account = await session.loadAggregateAsync<AccountAggregate>(id);
    res.json({ ok: true, accountId: id, balance: account.balance });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/accounts/:id/deposit", async (req, res) => {
  try {
    const id = req.params.id;
    const { amount, transactionId } = req.body;

    // Deposits to the same account race under concurrent requests. The event
    // store surfaces conflicts as ConcurrencyError; withConcurrencyRetry
    // re-runs the full load → decide → save cycle on a fresh session so the
    // handler re-reads the latest balance before deciding. Safe here because
    // deposit is an in-memory domain operation with no external side effects.
    const balance = await withConcurrencyRetry(
      async () => {
        const session = sessionFactory.createSession();
        const account = await session.loadAggregateAsync<AccountAggregate>(id);
        account.deposit(amount, transactionId);
        await session.saveChangesAsync();
        return account.balance;
      },
      {
        maxAttempts: 3,
        backoff: { minMs: 10, maxMs: 100, factor: 2, jitter: 0.2 }
      }
    );

    res.json({ ok: true, accountId: id, balance });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/accounts/:id/withdraw", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { amount, transactionId } = req.body;
    const account = await session.loadAggregateAsync<AccountAggregate>(id);
    account.withdraw(amount, transactionId);
    await session.saveChangesAsync();
    res.json({ ok: true, accountId: id, balance: account.balance });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/accounts/:id", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const account = await session.loadAggregateAsync<AccountAggregate>(id);
    res.json({
      id: account.id,
      customerId: account.customerId,
      balance: account.balance,
      isClosed: account.isClosed
    });
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
});

app.post("/accounts/:id/close", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { reason } = req.body;
    const account = await session.loadAggregateAsync<AccountAggregate>(id);
    account.close(reason || "Customer request");
    await session.saveChangesAsync();
    res.json({ ok: true });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// ========== Transaction Endpoints ==========
app.post("/transactions/:id/initiate", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { fromAccountId, toAccountId, amount, currency, description } = req.body;
    if (amount <= 0) {
      res.status(400).json({ error: "Transaction amount must be positive" });
      return;
    }
    if (fromAccountId === toAccountId) {
      res.status(400).json({ error: "Cannot transfer to the same account" });
      return;
    }
    session.startStream(id, TransactionInitiated({ transactionId: id, fromAccountId, toAccountId, amount, currency: currency || "USD", description }));
    await session.saveChangesAsync();
    res.json({ ok: true, transactionId: id, status: "pending" });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/transactions/:id/complete", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const transaction = await session.loadAggregateAsync<TransactionAggregate>(id);
    transaction.complete();
    await session.saveChangesAsync();
    res.json({ ok: true, transactionId: id, status: transaction.status });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/transactions/:id/fail", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { reason } = req.body;
    const transaction = await session.loadAggregateAsync<TransactionAggregate>(id);
    transaction.fail(reason || "Unknown error");
    await session.saveChangesAsync();
    res.json({ ok: true, transactionId: id, status: transaction.status });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/transactions/:id", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const transaction = await session.loadAggregateAsync<TransactionAggregate>(id);
    res.json({
      id: transaction.id,
      status: transaction.status,
      amount: transaction.amount
    });
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
});

// ========== Eventual Transfer Endpoint (eventual consistency pattern) ==========
app.post("/transfers/eventual", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const { transactionId, fromAccountId, toAccountId, amount, description } = req.body;

    if (amount <= 0) {
      res.status(400).json({ error: "Transaction amount must be positive" });
      return;
    }
    if (fromAccountId === toAccountId) {
      res.status(400).json({ error: "Cannot transfer to the same account" });
      return;
    }

    // Start a new transaction stream with both initiate and start events.
    // The async projections will handle the rest:
    // 1. WithdrawalProjection processes TransactionStarted → performs withdrawal → raises WithdrawalCompleted
    // 2. DepositProjection processes WithdrawalCompleted → performs deposit → raises DepositCompleted
    // 3. CompletionProjection processes DepositCompleted → completes transaction → raises TransactionCompleted
    session.startStream(transactionId,
      TransactionInitiated({ transactionId, fromAccountId, toAccountId, amount, currency: "USD", description }),
      TransactionStarted({ transactionId, fromAccountId, toAccountId, amount, currency: "USD", description, startedAt: new Date().toISOString() })
    );
    await session.saveChangesAsync();

    res.json({
      ok: true,
      transactionId,
      message: "Transfer initiated. Processing will complete asynchronously.",
      status: "started"
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// ========== Transfer Endpoint (atomic - immediate consistency) ==========
app.post("/transfers", async (req, res) => {
  try {
    const { transactionId, fromAccountId, toAccountId, amount, description } = req.body;

    // Load existing accounts and create the transaction + transfer in one session
    const session = sessionFactory.createSession();
    const fromAccount = await session.loadAggregateAsync<AccountAggregate>(fromAccountId);
    const toAccount = await session.loadAggregateAsync<AccountAggregate>(toAccountId);

    // Validate transfer before creating the transaction stream
    fromAccount.transferOut(toAccountId, amount, transactionId);
    toAccount.transferIn(fromAccountId, amount, transactionId);

    // Create the transaction stream as initiated + completed atomically
    session.startStream(transactionId,
      TransactionInitiated({ transactionId, fromAccountId, toAccountId, amount, currency: "USD", description }),
      TransactionCompleted({ transactionId, fromAccountId, toAccountId, amount, completedAt: new Date().toISOString() })
    );

    // Save all aggregates atomically in a single transaction
    await session.saveChangesAsync();

    res.json({
      ok: true,
      transactionId,
      fromAccount: { id: fromAccountId, balance: fromAccount.balance },
      toAccount: { id: toAccountId, balance: toAccount.balance }
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// ========== Query Endpoints (read-model queries via @eventfabric/postgres query builder) ==========

// Type matching the account_read table written by the inline projection
type AccountReadModel = {
  account_id: string;
  customer_id: string;
  balance: number;
  currency: string;
  updated_at: string;
};

// Fluent builder: single-table query with type-safe keys and operators
app.get("/accounts/search", async (req, res) => {
  try {
    const minBalance = Number(req.query.min_balance ?? 0);
    const currency = req.query.currency as string | undefined;
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Number(req.query.offset ?? 0);

    let qb = query<AccountReadModel>(pool, "account_read")
      .where("balance", ">=", minBalance);

    if (currency) {
      qb = qb.where("currency", "=", currency);
    }

    const accounts = await qb
      .orderBy("balance", "desc")
      .limit(limit)
      .offset(offset)
      .toList();

    const total = await query<AccountReadModel>(pool, "account_read")
      .where("balance", ">=", minBalance)
      .count();

    res.json({ accounts, total, limit, offset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Raw SQL: complex join query — full SQL expressiveness, parameterized via tagged template
app.get("/accounts/with-customers", async (req, res) => {
  try {
    const minBalance = Number(req.query.min_balance ?? 0);

    type AccountWithCustomer = {
      account_id: string;
      balance: number;
      currency: string;
      customer_id: string;
      customer_name: string;
    };

    const accounts = await query<AccountWithCustomer>(pool)
      .sql`
        SELECT a.account_id, a.balance, a.currency,
               a.customer_id, c.name AS customer_name
        FROM account_read a
        LEFT JOIN customer_read c ON c.id = a.customer_id
        WHERE a.balance >= ${minBalance}
        ORDER BY a.balance DESC
      `
      .toList();

    res.json({ accounts });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Operations Endpoints ==========
app.use("/ops/dlq", createDlqRouter(dlq));
app.use("/ops/outbox", createOutboxOpsRouter(outboxStats));
app.use("/ops/partitions", createPartitionOpsRouter(pool));

const PORT = process.env.PORT || 3001;

async function start() {
  const result = await migrate(pool);
  if (result.applied.length > 0) {
    console.log(`Applied migrations: ${result.applied.join(", ")}`);
  }
  if (result.partitioned) {
    console.log("Events table is partitioned");
  }

  app.listen(PORT, () => {
    console.log(`Banking API listening on :${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
