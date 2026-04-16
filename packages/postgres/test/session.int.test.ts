import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgEventStore } from "../src/pg-event-store";
import { PgSnapshotStore } from "../src/snapshots/pg-snapshot-store";
import { SessionFactory } from "../src/session";
import type { PgTx } from "../src/unitofwork/pg-transaction";
import { AggregateRoot, InlineProjector } from "@eventfabric/core";

// Test Events
type AccountOpenedV1 = {
  type: "AccountOpened";
  version: 1;
  accountId: string;
  customerId: string;
  initialBalance: number;
  currency: string;
};

type AccountDepositedV1 = {
  type: "AccountDeposited";
  version: 1;
  accountId: string;
  amount: number;
  balance: number;
};

type TransactionStartedV1 = {
  type: "TransactionStarted";
  version: 1;
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
};

type AccountEvent = AccountOpenedV1 | AccountDepositedV1;
type TransactionEvent = TransactionStartedV1;
type TestEvent = AccountEvent | TransactionEvent;

// Test State
type AccountState = {
  customerId?: string;
  balance: number;
  currency?: string;
};

type TransactionState = {
  fromAccountId?: string;
  toAccountId?: string;
  amount?: number;
  status: "pending" | "started" | "completed" | "failed";
};

// Test Aggregates
class AccountAggregate extends AggregateRoot<AccountState, AccountEvent> {
  static readonly aggregateName = "Account" as const;

  constructor(id: string, snapshot?: AccountState) {
    super(id, snapshot || { balance: 0 });
  }

  protected handlers = {
    AccountOpened: (s: AccountState, e: AccountOpenedV1) => {
      s.customerId = e.customerId;
      s.balance = e.initialBalance;
      s.currency = e.currency;
    },
    AccountDeposited: (s: AccountState, e: AccountDepositedV1) => {
      s.balance = e.balance;
    }
  };

  deposit(amount: number) {
    const newBalance = (this.state.balance || 0) + amount;
    this.raise({
      type: "AccountDeposited",
      version: 1,
      accountId: this.id,
      amount,
      balance: newBalance
    });
  }
}

class TransactionAggregate extends AggregateRoot<TransactionState, TransactionEvent> {
  static readonly aggregateName = "Transaction" as const;

  constructor(id: string, snapshot?: TransactionState) {
    super(id, snapshot || { status: "pending" });
  }

  protected handlers = {
    TransactionStarted: (s: TransactionState, e: TransactionStartedV1) => {
      s.fromAccountId = e.fromAccountId;
      s.toAccountId = e.toAccountId;
      s.amount = e.amount;
      s.status = "started";
    }
  };
}

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS eventfabric;
    CREATE TABLE IF NOT EXISTS eventfabric.stream_versions (
      aggregate_name TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      current_version INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (aggregate_name, aggregate_id)
    );
    CREATE TABLE IF NOT EXISTS eventfabric.events (
      global_position BIGSERIAL PRIMARY KEY,
      event_id UUID NOT NULL UNIQUE,
      aggregate_name TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INT NOT NULL,
      type TEXT NOT NULL,
      version INT NOT NULL,
      payload JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dismissed_at TIMESTAMPTZ NULL,
      dismissed_reason TEXT NULL,
      dismissed_by TEXT NULL,
      correlation_id TEXT NULL,
      causation_id TEXT NULL,
      UNIQUE (aggregate_name, aggregate_id, aggregate_version)
    );
    CREATE INDEX IF NOT EXISTS events_global_idx ON eventfabric.events (global_position);

    CREATE TABLE IF NOT EXISTS eventfabric.outbox (
      id BIGSERIAL PRIMARY KEY,
      global_position BIGINT NOT NULL UNIQUE,
      topic TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_at TIMESTAMPTZ NULL,
      locked_by TEXT NULL,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      dead_lettered_at TIMESTAMPTZ NULL,
      dead_letter_reason TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS eventfabric.snapshots (
      aggregate_name TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INT NOT NULL,
      snapshot_schema_version INT NOT NULL,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (aggregate_name, aggregate_id)
    );

    -- Simple read model table for inline projection verification
    CREATE TABLE IF NOT EXISTS account_read (
      account_id TEXT PRIMARY KEY,
      customer_id TEXT,
      balance INT,
      currency TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate();
}, 120000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

describe("Session", () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM eventfabric.outbox`);
    await pool.query(`DELETE FROM eventfabric.stream_versions`);
    await pool.query(`DELETE FROM eventfabric.events`);
    await pool.query(`DELETE FROM eventfabric.snapshots`);
    await pool.query(`DELETE FROM account_read`);
  }, 60000);

  it("should register aggregates with event types", () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    expect(() => {
      factory.registerAggregate(AccountAggregate, [
        "AccountOpened",
        "AccountDeposited"
      ]);
      factory.registerAggregate(TransactionAggregate, ["TransactionStarted"]);
    }).not.toThrow();
  });

  it("registerAggregate rejects incomplete event type tuples at compile time", () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    // AccountEvent = AccountOpenedV1 | AccountDepositedV1. The complete tuple
    // compiles cleanly; incomplete tuples and unknown types are caught by the
    // expect-error markers below. If any of those stops being an error, the
    // unused-directive check fails and CI signals the regression.

    // Exhaustive: compiles and passes exhaustiveness check
    factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited"]);

    // Missing "AccountDeposited"
    // @ts-expect-error — tuple is missing AccountDeposited
    factory.registerAggregate(AccountAggregate, ["AccountOpened"]);

    // Wrong event type for this aggregate (belongs to TransactionAggregate)
    // @ts-expect-error — "TransactionStarted" is not in AccountEvent["type"]
    factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited", "TransactionStarted"]);

    // Typo in event type
    // @ts-expect-error — "AccountOpend" is not in AccountEvent["type"]
    factory.registerAggregate(AccountAggregate, ["AccountOpend", "AccountDeposited"]);
  });

  it("should throw error when registering aggregate without aggregateName", () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    class InvalidAggregate extends AggregateRoot<AccountState, TestEvent> {
      // Missing static aggregateName
      protected handlers = {};
    }

    expect(() => {
      (factory.registerAggregate as any)(InvalidAggregate, ["SomeEvent"]);
    }).toThrow("AggregateClass must have a static aggregateName property");
  });

  it("should start a stream with typed events and save with saveChangesAsync", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ]);

    const session = factory.createSession();

    const accountId = "acc-1";
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };

    const accountDeposited: AccountDepositedV1 = {
      type: "AccountDeposited",
      version: 1,
      accountId,
      amount: 50,
      balance: 150
    };

    // Queue operations
    session.startStream(accountId, accountOpened, accountDeposited);
    
    // Commit all operations
    await session.saveChangesAsync();

    // Verify events were persisted
    const events = await pool.query(
      `SELECT * FROM eventfabric.events WHERE aggregate_id = $1 ORDER BY aggregate_version`,
      [accountId]
    );
    expect(events.rowCount).toBe(2);
    expect(events.rows[0].type).toBe("AccountOpened");
    expect(events.rows[1].type).toBe("AccountDeposited");
    expect(events.rows[0].aggregate_name).toBe("Account");
    expect(events.rows[1].aggregate_name).toBe("Account");
  });

  it("should load aggregate, modify, and auto-save with saveChangesAsync", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ]);

    const accountId = "acc-1";
    
    // Start stream first
    const session1 = factory.createSession();
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };
    session1.startStream(accountId, accountOpened);
    await session1.saveChangesAsync();

    // Load aggregate, modify, and save (new session)
    const session2 = factory.createSession();
    const account = await session2.loadAggregateAsync<AccountAggregate>(accountId);
    account.deposit(50);
    await session2.saveChangesAsync(); // Automatically saves pending events

    // Verify events
    const events = await pool.query(
      `SELECT * FROM eventfabric.events WHERE aggregate_id = $1 ORDER BY aggregate_version`,
      [accountId]
    );
    expect(events.rowCount).toBe(2);
    expect(events.rows[0].type).toBe("AccountOpened");
    expect(events.rows[1].type).toBe("AccountDeposited");
  });

  // Bug: loadAggregateAsync has no identity map. A second load of the same
  // aggregate id in the same session creates a fresh instance and OVERWRITES
  // the first instance in loadedAggregates. Any pending events on the first
  // instance become unreachable and are silently dropped by saveChangesAsync.
  it("double-loading the same aggregate returns the same instance and preserves pending events", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited"]);

    const accountId = "acc-double-load";

    // Seed: open the account at v1
    const seed = factory.createSession();
    seed.startStream(accountId, {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-1",
      initialBalance: 0,
      currency: "USD"
    } as AccountOpenedV1);
    await seed.saveChangesAsync();

    // In one session, load the aggregate twice with mutations on each instance
    const session = factory.createSession();

    const first = await session.loadAggregateAsync<AccountAggregate>(accountId);
    first.deposit(100); // pending on `first`: AccountDeposited(100)

    const second = await session.loadAggregateAsync<AccountAggregate>(accountId);
    second.deposit(50); // pending on `second`: AccountDeposited(50)

    // Identity map: second load must return the SAME instance as the first.
    expect(second).toBe(first);

    await session.saveChangesAsync();

    // Both deposits must land — no silent loss.
    const events = await pool.query(
      `SELECT type, aggregate_version, payload FROM eventfabric.events
       WHERE aggregate_id = $1 ORDER BY aggregate_version`,
      [accountId]
    );
    expect(events.rowCount).toBe(3); // Opened + 2 Deposited
    expect(events.rows[0].type).toBe("AccountOpened");
    expect(events.rows[1].type).toBe("AccountDeposited");
    expect(events.rows[2].type).toBe("AccountDeposited");

    // The surviving instance's state reflects both deposits
    const balance = (first as any).state.balance;
    expect(balance).toBe(150);
  });

  it("should throw error when starting stream with unregistered event type", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);
    const session = factory.createSession();

    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId: "acc-1",
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };

    expect(() => {
      session.startStream("acc-1", accountOpened);
    }).toThrow("Cannot infer aggregate class from event type");
  });

  it("should throw error when starting stream with mixed aggregate events", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited"]);
    factory.registerAggregate(TransactionAggregate, ["TransactionStarted"]);

    const session = factory.createSession();

    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId: "acc-1",
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };

    const transactionStarted: TransactionStartedV1 = {
      type: "TransactionStarted",
      version: 1,
      transactionId: "tx-1",
      fromAccountId: "acc-1",
      toAccountId: "acc-2",
      amount: 50
    };

    expect(() => {
      session.startStream("acc-1", accountOpened, transactionStarted);
    }).toThrow("does not belong to aggregate");
  });

  it("should append events to existing stream and save with saveChangesAsync", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ]);

    const session = factory.createSession();

    const accountId = "acc-1";

    // Start stream
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };

    session.startStream(accountId, accountOpened);
    await session.saveChangesAsync();

    // Append to stream
    const accountDeposited: AccountDepositedV1 = {
      type: "AccountDeposited",
      version: 1,
      accountId,
      amount: 50,
      balance: 150
    };

    session.append(accountId, 1, accountDeposited);
    await session.saveChangesAsync();

    // Verify all events
    const events = await pool.query(
      `SELECT * FROM eventfabric.events WHERE aggregate_id = $1 ORDER BY aggregate_version`,
      [accountId]
    );
    expect(events.rowCount).toBe(2);
  });

  it("should throw error when appending with unregistered event type", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);
    const session = factory.createSession();

    const accountDeposited: AccountDepositedV1 = {
      type: "AccountDeposited",
      version: 1,
      accountId: "acc-1",
      amount: 50,
      balance: 150
    };

    expect(() => {
      session.append("acc-1", 0, accountDeposited);
    }).toThrow("Cannot infer aggregate class from event type");
  });

  it("should throw error when starting stream with no events", () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);
    const session = factory.createSession();

    expect(() => {
      session.startStream("acc-1");
    }).toThrow("At least one event is required to start a stream");
  });

  it("should throw error when appending with no events", () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);
    const session = factory.createSession();

    expect(() => {
      session.append("acc-1", 0);
    }).toThrow("At least one event is required");
  });

  it("should batch multiple operations and commit in single transaction", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ]);

    const session = factory.createSession();

    const accountId1 = "acc-1";
    const accountId2 = "acc-2";

    const accountOpened1: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId: accountId1,
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };

    const accountOpened2: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId: accountId2,
      customerId: "cust-2",
      initialBalance: 200,
      currency: "USD"
    };

    // Queue multiple operations
    session.startStream(accountId1, accountOpened1);
    session.startStream(accountId2, accountOpened2);
    
    // Commit all in single transaction
    await session.saveChangesAsync();

    // Verify both streams were created
    const events1 = await pool.query(
      `SELECT * FROM eventfabric.events WHERE aggregate_id = $1 ORDER BY aggregate_version`,
      [accountId1]
    );
    const events2 = await pool.query(
      `SELECT * FROM eventfabric.events WHERE aggregate_id = $1 ORDER BY aggregate_version`,
      [accountId2]
    );
    
    expect(events1.rowCount).toBe(1);
    expect(events2.rowCount).toBe(1);
  });

  it("should automatically enqueue to outbox when starting stream", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ]);

    const session = factory.createSession();

    const accountId = "acc-1";
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };

    session.startStream(accountId, accountOpened);
    await session.saveChangesAsync();

    // Verify events were persisted
    const events = await pool.query(
      `SELECT * FROM eventfabric.events WHERE aggregate_id = $1 ORDER BY aggregate_version`,
      [accountId]
    );
    expect(events.rowCount).toBe(1);

    // Verify events were automatically enqueued to outbox (topic is null)
    const outbox = await pool.query(
      `SELECT * FROM eventfabric.outbox ORDER BY global_position`
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].topic).toBeNull();
  });

  it("should automatically enqueue to outbox when appending to stream", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ]);

    const session = factory.createSession();

    const accountId = "acc-1";

    // Start stream
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };

    session.startStream(accountId, accountOpened);
    await session.saveChangesAsync();

    // Append to stream
    const accountDeposited: AccountDepositedV1 = {
      type: "AccountDeposited",
      version: 1,
      accountId,
      amount: 50,
      balance: 150
    };

    session.append(accountId, 1, accountDeposited);
    await session.saveChangesAsync();

    // Verify events were automatically enqueued to outbox (topic is null)
    const outbox = await pool.query(
      `SELECT * FROM eventfabric.outbox ORDER BY global_position`
    );
    expect(outbox.rowCount).toBe(2); // Both events should be in outbox
    expect(outbox.rows[0].topic).toBeNull();
    expect(outbox.rows[1].topic).toBeNull();
  });

  it("should use snapshot store when registered and loading aggregate", async () => {
    const store = new PgEventStore<TestEvent>();
    const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ], snapshotStore);

    const accountId = "acc-1";
    
    // Create account with multiple events
    const session1 = factory.createSession();
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };
    session1.startStream(accountId, accountOpened);
    await session1.saveChangesAsync();

    // Add more events to trigger snapshot creation
    const session2 = factory.createSession();
    const account = await session2.loadAggregateAsync<AccountAggregate>(accountId);
    account.deposit(50);
    await session2.saveChangesAsync();

    // Manually create a snapshot (simulating snapshot policy)
    const { PgUnitOfWork } = await import("../src/unitofwork/pg-unit-of-work");
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction(async (tx) => {
      await snapshotStore.save(tx, {
        aggregateName: "Account",
        aggregateId: accountId,
        aggregateVersion: 2,
        snapshotSchemaVersion: 1,
        createdAt: new Date().toISOString(),
        state: { customerId: "cust-1", balance: 150, currency: "USD" }
      });
    });

    // Add another event after snapshot
    const session3 = factory.createSession();
    const account2 = await session3.loadAggregateAsync<AccountAggregate>(accountId);
    account2.deposit(25);
    await session3.saveChangesAsync();

    // Load again - should use snapshot and replay only events after version 2
    const session4 = factory.createSession();
    const account3 = await session4.loadAggregateAsync<AccountAggregate>(accountId);
    expect(account3.version).toBe(3);
    expect(account3.state.balance).toBe(175); // 150 (from snapshot) + 25 (from event)
    expect(account3.state.customerId).toBe("cust-1");
  });

  it("should throw error when loading aggregate that doesn't exist and isn't registered", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);
    const session = factory.createSession();

    // Don't register the aggregate
    const accountId = "acc-1";

    await expect(
      session.loadAggregateAsync<AccountAggregate>(accountId)
    ).rejects.toThrow("Cannot load aggregate");
  });

  it("should register aggregate with snapshot store via registerAggregate", () => {
    const store = new PgEventStore<TestEvent>();
    const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
    const factory = new SessionFactory(pool, store);

    expect(() => {
      factory.registerAggregate(AccountAggregate, [
        "AccountOpened",
        "AccountDeposited"
      ], snapshotStore);
    }).not.toThrow();
  });

  it("should register aggregate without snapshot store (optional parameter)", () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    expect(() => {
      factory.registerAggregate(AccountAggregate, [
        "AccountOpened",
        "AccountDeposited"
      ]); // No snapshot store provided
    }).not.toThrow();
  });

  it("should use snapshot store when registered via registerAggregate", async () => {
    const store = new PgEventStore<TestEvent>();
    const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
    const factory = new SessionFactory(pool, store);

    // Register with snapshot store via registerAggregate
    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ], snapshotStore);

    const accountId = "acc-1";
    
    // Create account
    const session1 = factory.createSession();
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };
    session1.startStream(accountId, accountOpened);
    await session1.saveChangesAsync();

    // Add event
    const session2 = factory.createSession();
    const account = await session2.loadAggregateAsync<AccountAggregate>(accountId);
    account.deposit(50);
    await session2.saveChangesAsync();

    // Create snapshot manually
    const { PgUnitOfWork } = await import("../src/unitofwork/pg-unit-of-work");
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction(async (tx) => {
      await snapshotStore.save(tx, {
        aggregateName: "Account",
        aggregateId: accountId,
        aggregateVersion: 2,
        snapshotSchemaVersion: 1,
        createdAt: new Date().toISOString(),
        state: { customerId: "cust-1", balance: 150, currency: "USD" }
      });
    });

    // Load again - should use snapshot
    const session3 = factory.createSession();
    const account2 = await session3.loadAggregateAsync<AccountAggregate>(accountId);
    expect(account2.version).toBe(2);
    expect(account2.state.balance).toBe(150);
    expect(account2.state.customerId).toBe("cust-1");
  });

  it("should work when snapshot store is not provided (loads from events only)", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    // Register without snapshot store
    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ]); // No snapshot store

    const accountId = "acc-1";
    
    // Create account
    const session1 = factory.createSession();
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };
    session1.startStream(accountId, accountOpened);
    await session1.saveChangesAsync();

    // Load aggregate - should work without snapshot store
    const session2 = factory.createSession();
    const account = await session2.loadAggregateAsync<AccountAggregate>(accountId);
    expect(account.version).toBe(1);
    expect(account.state.balance).toBe(100);
    expect(account.state.customerId).toBe("cust-1");
  });

  it("should register multiple aggregates with different snapshot stores", async () => {
    const store = new PgEventStore<TestEvent>();
    const accountSnapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
    const transactionSnapshotStore = new PgSnapshotStore<TransactionState>("eventfabric.snapshots", 1);
    const factory = new SessionFactory(pool, store);

    // Register Account with snapshot store
    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ], accountSnapshotStore);

    // Register Transaction with different snapshot store
    factory.registerAggregate(TransactionAggregate, [
      "TransactionStarted"
    ], transactionSnapshotStore);

    const accountId = "acc-1";
    const transactionId = "tx-1";

    // Create account
    const session1 = factory.createSession();
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-1",
      initialBalance: 100,
      currency: "USD"
    };
    session1.startStream(accountId, accountOpened);
    await session1.saveChangesAsync();

    // Create transaction
    const session2 = factory.createSession();
    const transactionStarted: TransactionStartedV1 = {
      type: "TransactionStarted",
      version: 1,
      transactionId,
      fromAccountId: accountId,
      toAccountId: "acc-2",
      amount: 50
    };
    session2.startStream(transactionId, transactionStarted);
    await session2.saveChangesAsync();

    // Verify both aggregates can be loaded
    const session3 = factory.createSession();
    const account = await session3.loadAggregateAsync<AccountAggregate>(accountId);
    const transaction = await session3.loadAggregateAsync<TransactionAggregate>(transactionId);

    expect(account.version).toBe(1);
    expect(account.state.balance).toBe(100);
    expect(transaction.version).toBe(1);
    expect(transaction.state.status).toBe("started");
  });

  it("runs inline projections within saveChangesAsync", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ]);

    const inlineProjector = new InlineProjector<TestEvent, PgTx>([
      {
        name: "account-read-model",
        async handle(tx, env) {
          if (env.payload.type === "AccountOpened") {
            await tx.client.query(
              `INSERT INTO account_read (account_id, customer_id, balance, currency, updated_at)
               VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (account_id) DO UPDATE SET
                 customer_id = EXCLUDED.customer_id,
                 balance = EXCLUDED.balance,
                 currency = EXCLUDED.currency,
                 updated_at = now()`,
              [env.aggregateId, env.payload.customerId, env.payload.initialBalance, env.payload.currency]
            );
          } else if (env.payload.type === "AccountDeposited") {
            await tx.client.query(
              `UPDATE account_read SET balance = $1, updated_at = now() WHERE account_id = $2`,
              [env.payload.balance, env.aggregateId]
            );
          }
        }
      }
    ]);

    factory.registerInlineProjector(inlineProjector);

    const accountId = "acc-inline";

    // Create account
    const session1 = factory.createSession();
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-inline",
      initialBalance: 100,
      currency: "USD"
    };
    session1.startStream(accountId, accountOpened);
    await session1.saveChangesAsync();

    // Verify inline projection wrote read model
    const row1 = await pool.query(`SELECT * FROM account_read WHERE account_id = 'acc-inline'`);
    expect(row1.rowCount).toBe(1);
    expect(row1.rows[0].balance).toBe(100);

    // Deposit and ensure projection updates read model
    const session2 = factory.createSession();
    const account = await session2.loadAggregateAsync<AccountAggregate>(accountId);
    account.deposit(50);
    await session2.saveChangesAsync();

    const row2 = await pool.query(`SELECT * FROM account_read WHERE account_id = 'acc-inline'`);
    expect(row2.rowCount).toBe(1);
    expect(row2.rows[0].balance).toBe(150);
  }, 15000);

  it("creates snapshots automatically based on snapshot policy", async () => {
    const store = new PgEventStore<TestEvent>();
    const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ], snapshotStore, { everyNEvents: 1 }, 1);

    const accountId = "acc-snap-policy";

    // First event should trigger snapshot at version 1
    const session1 = factory.createSession();
    const accountOpened: AccountOpenedV1 = {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-snap",
      initialBalance: 100,
      currency: "USD"
    };
    session1.startStream(accountId, accountOpened);
    await session1.saveChangesAsync();

    const snap1 = await pool.query(
      `SELECT aggregate_version FROM eventfabric.snapshots WHERE aggregate_name = 'Account' AND aggregate_id = $1`,
      [accountId]
    );
    expect(snap1.rowCount).toBe(1);
    expect(snap1.rows[0].aggregate_version).toBe(1);

    // Second event should update snapshot to version 2
    const session2 = factory.createSession();
    const account = await session2.loadAggregateAsync<AccountAggregate>(accountId);
    account.deposit(25);
    await session2.saveChangesAsync();

    const snap2 = await pool.query(
      `SELECT aggregate_version, state FROM eventfabric.snapshots WHERE aggregate_name = 'Account' AND aggregate_id = $1`,
      [accountId]
    );
    expect(snap2.rowCount).toBe(1);
    expect(snap2.rows[0].aggregate_version).toBe(2);
    const state = snap2.rows[0].state as any;
    expect(state.balance).toBe(125);
  }, 15000);

  it("loadAggregateAsync replays full history (ignores snapshot)", async () => {
    const store = new PgEventStore<TestEvent>();
    const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
    const factory = new SessionFactory(pool, store);

    // snapshot every event so snapshots exist, but loadAggregateAsync should still replay all
    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ], snapshotStore, { everyNEvents: 1 }, 1);

    const accountId = "acc-live";

    // create and append
    const session1 = factory.createSession();
    session1.startStream(accountId, {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-live",
      initialBalance: 100,
      currency: "USD"
    });
    await session1.saveChangesAsync();

    const session2 = factory.createSession();
    const account2 = await session2.loadAggregateAsync<AccountAggregate>(accountId);
    account2.deposit(50);
    await session2.saveChangesAsync();

    // snapshot should exist at version 2, but loadAggregateAsync must return live balance 150
    const session3 = factory.createSession();
    const liveAccount = await session3.loadAggregateAsync<AccountAggregate>(accountId);
    expect(liveAccount.version).toBe(2);
    expect(liveAccount.state.balance).toBe(150);
  }, 15000);

  it("loadSnapshotAsync returns latest snapshot without replay", async () => {
    const store = new PgEventStore<TestEvent>();
    const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ], snapshotStore, { everyNEvents: 1 }, 1);

    const accountId = "acc-snapshot";

    const session1 = factory.createSession();
    session1.startStream(accountId, {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-snap2",
      initialBalance: 200,
      currency: "USD"
    });
    await session1.saveChangesAsync();

    const session2 = factory.createSession();
    const account2 = await session2.loadAggregateAsync<AccountAggregate>(accountId);
    account2.deposit(25); // balance 225
    await session2.saveChangesAsync();

    // Should have snapshot at version 2 with balance 225
    const session3 = factory.createSession();
    const snapAgg = await session3.loadSnapshotAsync<AccountAggregate>(accountId);
    expect(snapAgg.version).toBe(2);
    expect(snapAgg.state.balance).toBe(225);
  }, 15000);

  it("appendUnsafe appends using current stream version (no expectedVersion)", async () => {
    const store = new PgEventStore<TestEvent>();
    const factory = new SessionFactory(pool, store);

    factory.registerAggregate(AccountAggregate, [
      "AccountOpened",
      "AccountDeposited"
    ]);

    const accountId = "acc-append-unsafe";

    // Seed stream
    const session1 = factory.createSession();
    session1.startStream(accountId, {
      type: "AccountOpened",
      version: 1,
      accountId,
      customerId: "cust-unsafe",
      initialBalance: 10,
      currency: "USD"
    });
    await session1.saveChangesAsync();

    // Append without specifying expected version
    const session2 = factory.createSession();
    session2.appendUnsafe(accountId, {
      type: "AccountDeposited",
      version: 1,
      accountId,
      amount: 5,
      balance: 15
    });
    await session2.saveChangesAsync();

    // Verify two events persisted and version advanced
    const rows = await pool.query(
      `SELECT aggregate_version, type FROM eventfabric.events WHERE aggregate_id = $1 ORDER BY aggregate_version`,
      [accountId]
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows[0].aggregate_version).toBe(1);
    expect(rows.rows[1].aggregate_version).toBe(2);
    expect(rows.rows[1].type).toBe("AccountDeposited");
  }, 15000);
});
