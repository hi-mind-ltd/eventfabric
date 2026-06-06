import express from "express";
import { Pool } from "pg";
import {
  PgEventStore,
  PgSnapshotStore,
  PgDlqService,
  PgOutboxStatsService,
  PgUnitOfWork,
  createAsyncProjectionRunner,
  createCatchUpProjector,
  SessionFactory,
  query,
  migrate
} from "@eventfabric/postgres";
import type { PgTx } from "@eventfabric/postgres";
import { sleep, withConcurrencyRetry } from "@eventfabric/core";
import { CommandBus, createLoggingMiddleware } from "@eventfabric/mediator";
import { PgIdempotencyStore, commandsMigrations } from "@eventfabric/mediator-postgres";
import {
  createCommandBusObserver,
  createCommandIdempotencyGauges,
} from "@eventfabric/mediator-opentelemetry";
import {
  SagaCommandDispatcher,
  SagaTimerScheduler,
  sagaAsAsyncProjection,
  type Saga,
  type SagaTimerHandler,
} from "@eventfabric/sagas";
import {
  PgSagaStateStore,
  PgSagaCommandQueue,
  PgSagaTimerStore,
  sagasMigrations,
} from "@eventfabric/sagas-postgres";
import {
  createSagaObserver,
  createSagaQueueGauges,
} from "@eventfabric/sagas-opentelemetry";
import { AccountAggregate, type AccountState } from "./domain/account.aggregate";
import { TransactionAggregate, type TransactionState } from "./domain/transaction.aggregate";
import { CustomerAggregate, type CustomerState } from "./domain/customer.aggregate";
import type { BankingEvent } from "./domain/events";
import { AccountOpened, AccountDeposited } from "./domain/account.events";
import { TransactionInitiated, TransactionStarted } from "./domain/transaction.events";
import { CustomerRegistered } from "./domain/customer.events";
import { accountEventUpcaster } from "./domain/account.upcasters";
import { emailNotificationProjection } from "./projections/email-projection";
import { depositAuditProjection } from "./projections/deposit-audit";
import { fundsTransferSaga, type TransferState } from "./sagas/funds-transfer.saga";
import { registerFundsTransferHandlers } from "./sagas/funds-transfer.handlers";
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

// ===== Saga-based transfer pipeline =====
//
// In this variant of the example, the eventual transfer chain
// (TransactionStarted → WithdrawalCompleted → DepositCompleted →
// TransactionCompleted) is driven by a single FundsTransfer saga instead
// of three coordinated catch-up projections. The shape:
//
//   1. POST /transfers emits TransactionStarted.
//   2. The saga (as an async projection on the outbox) sees the event,
//      starts an instance, emits a WithdrawFromAccount command, and
//      schedules a 30s withdraw-timeout timer.
//   3. SagaCommandDispatcher drains the command queue and sends each
//      command through CommandBus → handlers do the domain work +
//      emit follow-up events (WithdrawalCompleted, then DepositCompleted).
//   4. The saga reacts to each follow-up, emits the next command, and
//      finally CompleteTransaction. If the withdraw timer fires first,
//      it emits FailTransaction instead.
//
// Idempotency: every dispatched command's idempotency key is rewritten
// by the dispatcher to `saga:FundsTransfer:<instance>:<rowId>`, so a
// worker crash mid-dispatch never produces duplicate effects.

const uow = new PgUnitOfWork(pool);

// Observability via OpenTelemetry. The OTel adapter wraps handler execution
// in an active span (so pg/http child spans attach automatically) and emits
// counters + a duration histogram per projection.
import { trace, metrics } from "@opentelemetry/api";
import { createAsyncRunnerObserver, createCatchUpObserver } from "@eventfabric/opentelemetry";

const tracer = trace.getTracer("banking-api-saga");
const meter = metrics.getMeter("banking-api-saga");

const asyncObserver = createAsyncRunnerObserver({ tracer, meter });
const catchUpObserver = createCatchUpObserver({ tracer, meter });
const sagaObserver = createSagaObserver({ tracer, meter });

// Command bus — the SAME bus serves saga-emitted commands. Any handler
// registered here is reachable from the dispatcher.
const bus = new CommandBus<PgTx>({
  uow,
  idempotencyStore: new PgIdempotencyStore(),
});
// Logging is registered FIRST so the log line covers the full pipeline
// (idempotency claim + tracing + handler). Drop the `prefix` if you only
// run one bus per service.
bus.use(createLoggingMiddleware({ prefix: "[bank] " }));
// Tracing + metrics for every command going through the bus (saga-
// emitted or otherwise). Registered after logging so spans wrap the
// inner middleware chain including idempotency claims.
bus.use(createCommandBusObserver({ tracer, meter }));
registerFundsTransferHandlers(bus, store);

// Saga storage — three tables (saga_instances, saga_pending_commands,
// saga_scheduled_messages) created by sagasMigrations.
const sagaStateStore = new PgSagaStateStore<TransferState>();
const sagaCommandQueue = new PgSagaCommandQueue();
const sagaTimerStore = new PgSagaTimerStore();
const sagaStores = {
  stateStore: sagaStateStore,
  commandQueue: sagaCommandQueue,
  timerStore: sagaTimerStore,
};

// Command idempotency gauges — `in_flight` count + oldest-`in_flight`
// age. Sustained growth in `oldest_in_flight_seconds` past your slowest
// legitimate handler runtime means the `resetStaleInFlight` watchdog
// needs to fire.
createCommandIdempotencyGauges({
  meter,
  inFlightCount: async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM eventfabric.command_idempotency
        WHERE status = 'in_flight'`
    );
    return r.rows[0]?.n ?? 0;
  },
  oldestInFlightSeconds: async () => {
    const r = await pool.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::float8 AS v
         FROM eventfabric.command_idempotency
        WHERE status = 'in_flight'`
    );
    return r.rows[0]?.v ?? 0;
  },
});

// Saga queue gauges — observable metrics polled from the DB at each
// metric export. `scheduled_messages_overdue_count` is the alert metric.
createSagaQueueGauges({
  meter,
  pendingCommandsLagSeconds: async () => {
    const r = await pool.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(enqueued_at))), 0)::float8 AS v
         FROM eventfabric.saga_pending_commands
        WHERE status = 'pending'`
    );
    return r.rows[0]?.v ?? 0;
  },
  overdueScheduledMessagesCount: async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM eventfabric.saga_scheduled_messages
        WHERE status = 'pending' AND fire_at <= NOW()`
    );
    return r.rows[0]?.n ?? 0;
  },
});

// ===== Projection wiring =====
//
// Two async tiers, each picked for what it actually needs:
//
//   1. Outbox-based async runner for:
//      - email notifications (external delivery — at-least-once + DLQ
//        is what outbox exists for),
//      - the FundsTransfer saga, wrapped via sagaAsAsyncProjection so it
//        joins the same runner without new infrastructure.
//
//   2. Catch-up projector for deposit-audit only (single-event-type
//      read-model derivation — no external side effects, so catch-up is
//      cheaper than outbox).

const sagaProjection = sagaAsAsyncProjection(fundsTransferSaga, sagaStores, {
  observer: sagaObserver,
});

// Outbox runner: email + saga react both flow through here.
const asyncRunner = createAsyncProjectionRunner(
  pool,
  store,
  [emailNotificationProjection, sagaProjection],
  {
    workerId: "async-worker-1",
    batchSize: 10,
    idleSleepMs: 1000,
    maxAttempts: 5,
    transactionMode: "batch",
    backoff: { minMs: 100, maxMs: 5000, factor: 2, jitter: 0.1 },
    observer: asyncObserver,
  }
);

// Catch-up projector: deposit-audit only. The transfer chain is now
// driven by the saga + command pipeline above.
const catchUpProjections = [depositAuditProjection];
const catchUpProjector = createCatchUpProjector<BankingEvent>(pool, store);

// Saga workers — long-lived loops that drain the command queue and fire
// due timers. Both are safe to run with multiple replicas (FOR UPDATE
// SKIP LOCKED).
const sagaTimerHandlers = new Map<string, SagaTimerHandler<PgTx>>([
  [
    "FundsTransfer",
    {
      saga: fundsTransferSaga as Saga<any, any>,
      stores: sagaStores,
    },
  ],
]);
const sagaDispatcher = new SagaCommandDispatcher(uow, sagaCommandQueue, bus, {
  observer: sagaObserver,
});
const sagaScheduler = new SagaTimerScheduler(uow, sagaTimerStore, sagaTimerHandlers, {
  observer: sagaObserver,
});

// Start async projection runners
const abortController = new AbortController();
asyncRunner.start(abortController.signal).catch((err) => {
  console.error("Async projection runner error:", err);
});

// Saga dispatcher + timer scheduler — these own their own loops.
sagaDispatcher.start().catch((err) => {
  console.error("SagaCommandDispatcher error:", err);
});
sagaScheduler.start().catch((err) => {
  console.error("SagaTimerScheduler error:", err);
});

// Catch-up polling loop. catchUpAll runs all registered projections
// sequentially; each tracks its own checkpoint. Sleep idleMs between
// rounds when nothing's left to process.
(async () => {
  const idleMs = 500;
  while (!abortController.signal.aborted) {
    try {
      await catchUpProjector.catchUpAll(catchUpProjections, { batchSize: 100, observer: catchUpObserver });
    } catch (err) {
      console.error("Catch-up projector error:", err);
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
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  abortController.abort();
  await Promise.all([sagaDispatcher.stop(), sagaScheduler.stop()]);
  await pool.end();
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

app.post("/accounts/:id/open-with-stream", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { customerId, initialBalance, currency } = req.body;
    const bal = initialBalance || 0;

    session.startStream(id,
      AccountOpened({ accountId: id, customerId, initialBalance: bal, currency: currency || "USD", region: req.body.region ?? "unknown" }),
      AccountDeposited({ accountId: id, amount: bal, balance: bal })
    );
    await session.saveChangesAsync();

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

// ========== Transfer Endpoint (saga-driven) ==========
//
// This is the only way a transfer enters the system in this variant.
// There is no atomic /transfers and no manual /transactions/:id/...
// lifecycle endpoint — every transition through pending → started →
// withdrawn → deposited → completed (or failed) is driven by the
// FundsTransfer saga reacting to the events emitted here.
app.post("/transfers", async (req, res) => {
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

    // Seed the transaction stream with Initiated + Started. The saga's
    // correlate() routes TransactionStarted to a fresh FundsTransfer
    // instance and the rest of the chain unfolds:
    //   1. WithdrawFromAccount → handler raises WithdrawalCompleted
    //   2. DepositToAccount    → handler raises DepositCompleted
    //   3. CompleteTransaction → handler raises TransactionCompleted
    // If WithdrawalCompleted doesn't arrive in 30s, the withdraw-timeout
    // timer fires and the saga emits FailTransaction instead.
    session.startStream(transactionId,
      TransactionInitiated({ transactionId, fromAccountId, toAccountId, amount, currency: "USD", description }),
      TransactionStarted({ transactionId, fromAccountId, toAccountId, amount, currency: "USD", description, startedAt: new Date().toISOString() })
    );
    await session.saveChangesAsync();

    res.json({
      ok: true,
      transactionId,
      message: "Transfer initiated. The FundsTransfer saga will drive the chain to completion.",
      status: "started"
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Read-only — observe the terminal state of a saga-driven transaction.
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

// ========== Saga Inspection ==========
//
// Read-only ops endpoint — list all active saga instances. Useful for
// dashboards and stuck-instance investigations.
app.get("/ops/sagas/active", async (_req, res) => {
  try {
    const instances = await uow.withTransaction((tx) =>
      sagaStateStore.listActive(tx, { sagaName: "FundsTransfer", tenantId: "default" })
    );
    res.json({
      sagaName: "FundsTransfer",
      activeCount: instances.length,
      instances: instances.map((i) => ({
        instanceId: i.instanceId,
        tenantId: i.tenantId,
        stateVersion: i.stateVersion,
        lastEventPos: i.lastEventPos === null ? null : i.lastEventPos.toString(),
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        state: i.state,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Query Endpoints (read-model queries via @eventfabric/postgres query builder) ==========

type AccountReadModel = {
  account_id: string;
  customer_id: string;
  balance: number;
  currency: string;
  updated_at: string;
};

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
  // Apply core migrations plus the commands + sagas extensions.
  const result = await migrate(pool, {
    extensions: [commandsMigrations, sagasMigrations],
  });
  if (result.applied.length > 0) {
    console.log(`Applied migrations: ${result.applied.join(", ")}`);
  }
  if (result.partitioned) {
    console.log("Events table is partitioned");
  }

  app.listen(PORT, () => {
    console.log(`Banking API (saga variant) listening on :${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
