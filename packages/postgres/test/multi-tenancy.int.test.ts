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
  createAsyncProjectionRunner,
  migrate
} from "../src";
import type { PgTx } from "../src";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { AggregateRoot, type HandlerMap, type CatchUpProjection, type AsyncProjection, sleep } from "@eventfabric/core";

// ============================================================================
// Test domain
// ============================================================================

type AccountOpenedV1 = { type: "AccountOpened"; version: 1; accountId: string; owner: string; balance: number };
type AccountDepositedV1 = { type: "AccountDeposited"; version: 1; accountId: string; amount: number; balance: number };
type TestEvent = AccountOpenedV1 | AccountDepositedV1;
type AccountState = { owner?: string; balance: number };

class AccountAggregate extends AggregateRoot<AccountState, TestEvent> {
  static readonly aggregateName = "Account" as const;
  protected handlers = {
    AccountOpened: (s: AccountState, e: AccountOpenedV1) => { s.owner = e.owner; s.balance = e.balance; },
    AccountDeposited: (s: AccountState, e: AccountDepositedV1) => { s.balance = e.balance; }
  } satisfies HandlerMap<TestEvent, AccountState>;
  constructor(id: string, snapshot?: AccountState) { super(id, snapshot ?? { balance: 0 }); }
  deposit(amount: number) {
    this.raise({ type: "AccountDeposited", version: 1, accountId: this.id, amount, balance: this.state.balance + amount });
  }
}

// ============================================================================
// Setup
// ============================================================================

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;
let store: PgEventStore<TestEvent>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
  store = new PgEventStore<TestEvent>();
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

function createFactory(): SessionFactory<TestEvent> {
  const factory = new SessionFactory<TestEvent>(pool, store);
  factory.registerAggregate(AccountAggregate, [
    "AccountOpened", "AccountDeposited"
  ], "account", { snapshotStore: new PgSnapshotStore<AccountState>() });
  return factory;
}

// ============================================================================
// Event isolation (write side)
// ============================================================================

describe("multi-tenancy: event isolation", () => {
  it("events from different tenants are completely isolated", async () => {
    const factory = createFactory();

    const sessionA = factory.createSession("tenant-a");
    sessionA.startStream("acc-1", {
      type: "AccountOpened", version: 1, accountId: "acc-1", owner: "Alice", balance: 100
    } as TestEvent);
    await sessionA.saveChangesAsync();

    const sessionB = factory.createSession("tenant-b");
    sessionB.startStream("acc-1", {
      type: "AccountOpened", version: 1, accountId: "acc-1", owner: "Bob", balance: 200
    } as TestEvent);
    await sessionB.saveChangesAsync();

    const accA = await factory.createSession("tenant-a").loadAggregateAsync<AccountAggregate>("acc-1");
    expect(accA.state.owner).toBe("Alice");
    expect(accA.state.balance).toBe(100);

    const accB = await factory.createSession("tenant-b").loadAggregateAsync<AccountAggregate>("acc-1");
    expect(accB.state.owner).toBe("Bob");
    expect(accB.state.balance).toBe(200);
  });

  it("same aggregate ID in different tenants has independent version streams", async () => {
    const factory = createFactory();

    // Tenant A: create + deposit (2 events)
    const sA1 = factory.createSession("tenant-a");
    sA1.startStream("acc-shared", { type: "AccountOpened", version: 1, accountId: "acc-shared", owner: "A", balance: 0 } as TestEvent);
    await sA1.saveChangesAsync();
    const sA2 = factory.createSession("tenant-a");
    const accA = await sA2.loadAggregateAsync<AccountAggregate>("acc-shared");
    accA.deposit(50);
    await sA2.saveChangesAsync();

    // Tenant B: only create (1 event)
    const sB1 = factory.createSession("tenant-b");
    sB1.startStream("acc-shared", { type: "AccountOpened", version: 1, accountId: "acc-shared", owner: "B", balance: 0 } as TestEvent);
    await sB1.saveChangesAsync();

    const { rows: eventsA } = await pool.query(
      `SELECT * FROM eventfabric.events WHERE tenant_id = 'tenant-a' AND aggregate_id = 'acc-shared'`
    );
    const { rows: eventsB } = await pool.query(
      `SELECT * FROM eventfabric.events WHERE tenant_id = 'tenant-b' AND aggregate_id = 'acc-shared'`
    );
    expect(eventsA).toHaveLength(2);
    expect(eventsB).toHaveLength(1);
  });

  it("tenant cannot load another tenant's aggregate", async () => {
    const factory = createFactory();

    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-private", { type: "AccountOpened", version: 1, accountId: "acc-private", owner: "A", balance: 100 } as TestEvent);
    await sA.saveChangesAsync();

    const sB = factory.createSession("tenant-b");
    await expect(sB.loadAggregateAsync<AccountAggregate>("acc-private")).rejects.toThrow("aggregate class not found");
  });

  it("default tenant is isolated from named tenants", async () => {
    const factory = createFactory();

    const sDef = factory.createSession();
    sDef.startStream("acc-def", { type: "AccountOpened", version: 1, accountId: "acc-def", owner: "Default", balance: 50 } as TestEvent);
    await sDef.saveChangesAsync();

    const sNamed = factory.createSession("tenant-x");
    sNamed.startStream("acc-def", { type: "AccountOpened", version: 1, accountId: "acc-def", owner: "TenantX", balance: 999 } as TestEvent);
    await sNamed.saveChangesAsync();

    const def = await factory.createSession().loadAggregateAsync<AccountAggregate>("acc-def");
    expect(def.state.owner).toBe("Default");

    const named = await factory.createSession("tenant-x").loadAggregateAsync<AccountAggregate>("acc-def");
    expect(named.state.owner).toBe("TenantX");
  });
});

// ============================================================================
// Concurrency isolation
// ============================================================================

describe("multi-tenancy: concurrency isolation", () => {
  it("same ID in different tenants does not cause concurrency conflict", async () => {
    const factory = createFactory();

    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-conc", { type: "AccountOpened", version: 1, accountId: "acc-conc", owner: "A", balance: 0 } as TestEvent);
    await sA.saveChangesAsync();

    const sB = factory.createSession("tenant-b");
    sB.startStream("acc-conc", { type: "AccountOpened", version: 1, accountId: "acc-conc", owner: "B", balance: 0 } as TestEvent);
    await sB.saveChangesAsync();

    // Both can deposit independently without ConcurrencyError
    const sA2 = factory.createSession("tenant-a");
    (await sA2.loadAggregateAsync<AccountAggregate>("acc-conc")).deposit(10);
    await sA2.saveChangesAsync();

    const sB2 = factory.createSession("tenant-b");
    (await sB2.loadAggregateAsync<AccountAggregate>("acc-conc")).deposit(20);
    await sB2.saveChangesAsync();

    const finalA = await factory.createSession("tenant-a").loadAggregateAsync<AccountAggregate>("acc-conc");
    const finalB = await factory.createSession("tenant-b").loadAggregateAsync<AccountAggregate>("acc-conc");
    expect(finalA.state.balance).toBe(10);
    expect(finalB.state.balance).toBe(20);
  });
});

// ============================================================================
// Outbox isolation (write side tags tenant, read side is global)
// ============================================================================

describe("multi-tenancy: outbox", () => {
  it("outbox rows carry the correct tenant_id", async () => {
    const factory = createFactory();

    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-ob-a", { type: "AccountOpened", version: 1, accountId: "acc-ob-a", owner: "A", balance: 10 } as TestEvent);
    await sA.saveChangesAsync();

    const sB = factory.createSession("tenant-b");
    sB.startStream("acc-ob-b", { type: "AccountOpened", version: 1, accountId: "acc-ob-b", owner: "B", balance: 20 } as TestEvent);
    await sB.saveChangesAsync();

    const { rows } = await pool.query(`SELECT tenant_id, topic FROM eventfabric.outbox ORDER BY id`);
    expect(rows).toHaveLength(2);
    expect(rows[0].tenant_id).toBe("tenant-a");
    expect(rows[1].tenant_id).toBe("tenant-b");
  });

  it("outbox stats are tenant-scoped", async () => {
    const factory = createFactory();

    // Tenant A: 2 events
    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-st-a", { type: "AccountOpened", version: 1, accountId: "acc-st-a", owner: "A", balance: 0 } as TestEvent);
    await sA.saveChangesAsync();
    const sA2 = factory.createSession("tenant-a");
    (await sA2.loadAggregateAsync<AccountAggregate>("acc-st-a")).deposit(10);
    await sA2.saveChangesAsync();

    // Tenant B: 1 event
    const sB = factory.createSession("tenant-b");
    sB.startStream("acc-st-b", { type: "AccountOpened", version: 1, accountId: "acc-st-b", owner: "B", balance: 0 } as TestEvent);
    await sB.saveChangesAsync();

    const statsA = new PgOutboxStatsService(pool, undefined, "tenant-a");
    expect((await statsA.getBacklogStats()).totalPending).toBe(2);

    const statsB = new PgOutboxStatsService(pool, undefined, "tenant-b");
    expect((await statsB.getBacklogStats()).totalPending).toBe(1);
  });
});

// ============================================================================
// Snapshot isolation (write side)
// ============================================================================

describe("multi-tenancy: snapshot isolation", () => {
  it("snapshots are isolated per tenant", async () => {
    const factory = new SessionFactory<TestEvent>(pool, store);
    factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited"], "account", {
      snapshotStore: new PgSnapshotStore<AccountState>(),
      snapshotPolicy: { everyNEvents: 1 },
      snapshotSchemaVersion: 1
    });

    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-snap", { type: "AccountOpened", version: 1, accountId: "acc-snap", owner: "A", balance: 100 } as TestEvent);
    await sA.saveChangesAsync();

    const sB = factory.createSession("tenant-b");
    sB.startStream("acc-snap", { type: "AccountOpened", version: 1, accountId: "acc-snap", owner: "B", balance: 999 } as TestEvent);
    await sB.saveChangesAsync();

    const { rows } = await pool.query(
      `SELECT tenant_id, (state->>'balance')::int AS balance FROM eventfabric.snapshots WHERE aggregate_id = 'acc-snap' ORDER BY tenant_id`
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].tenant_id).toBe("tenant-a");
    expect(rows[0].balance).toBe(100);
    expect(rows[1].tenant_id).toBe("tenant-b");
    expect(rows[1].balance).toBe(999);
  });
});

// ============================================================================
// Catch-up projection — sees ALL tenants, envelope carries tenantId
// ============================================================================

describe("multi-tenancy: catch-up projection (cross-tenant)", () => {
  it("single projector sees events from all tenants with tenantId on envelope", async () => {
    const factory = createFactory();

    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-cp-a", { type: "AccountOpened", version: 1, accountId: "acc-cp-a", owner: "A", balance: 100 } as TestEvent);
    await sA.saveChangesAsync();

    const sB = factory.createSession("tenant-b");
    sB.startStream("acc-cp-b", { type: "AccountOpened", version: 1, accountId: "acc-cp-b", owner: "B", balance: 200 } as TestEvent);
    await sB.saveChangesAsync();

    const seen: Array<{ tenantId: string; aggregateId: string }> = [];
    const projection: CatchUpProjection<TestEvent, PgTx> = {
      name: "cross-tenant-audit",
      async handle(_tx, env) {
        seen.push({ tenantId: env.tenantId, aggregateId: env.aggregateId });
      }
    };

    // One projector, no tenant param — sees everything
    const projector = createCatchUpProjector(pool, store);
    await projector.catchUpAll([projection], { batchSize: 100 });

    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual({ tenantId: "tenant-a", aggregateId: "acc-cp-a" });
    expect(seen).toContainEqual({ tenantId: "tenant-b", aggregateId: "acc-cp-b" });
  });

  it("projection handler can filter by tenantId if needed", async () => {
    const factory = createFactory();

    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-filt-a", { type: "AccountOpened", version: 1, accountId: "acc-filt-a", owner: "A", balance: 0 } as TestEvent);
    await sA.saveChangesAsync();

    const sB = factory.createSession("tenant-b");
    sB.startStream("acc-filt-b", { type: "AccountOpened", version: 1, accountId: "acc-filt-b", owner: "B", balance: 0 } as TestEvent);
    await sB.saveChangesAsync();

    const tenantAOnly: string[] = [];
    const projection: CatchUpProjection<TestEvent, PgTx> = {
      name: "tenant-a-filter",
      async handle(_tx, env) {
        if (env.tenantId === "tenant-a") {
          tenantAOnly.push(env.aggregateId);
        }
      }
    };

    const projector = createCatchUpProjector(pool, store);
    await projector.catchUpAll([projection], { batchSize: 100 });

    expect(tenantAOnly).toEqual(["acc-filt-a"]);
  });

  it("checkpoints are per-tenant so one tenant's progress cannot shadow another's", async () => {
    const factory = createFactory();

    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-ckpt-a", { type: "AccountOpened", version: 1, accountId: "acc-ckpt-a", owner: "A", balance: 0 } as TestEvent);
    await sA.saveChangesAsync();

    const sB = factory.createSession("tenant-b");
    sB.startStream("acc-ckpt-b", { type: "AccountOpened", version: 1, accountId: "acc-ckpt-b", owner: "B", balance: 0 } as TestEvent);
    await sB.saveChangesAsync();

    const projection: CatchUpProjection<TestEvent, PgTx> = {
      name: "per-tenant-checkpoint",
      async handle() {}
    };

    const projector = createCatchUpProjector(pool, store);
    await projector.catchUpAll([projection], { batchSize: 100 });

    const { rows } = await pool.query(
      `SELECT tenant_id, last_global_position FROM eventfabric.projection_checkpoints
       WHERE projection_name = 'per-tenant-checkpoint'
       ORDER BY tenant_id`
    );
    // One row per active tenant
    expect(rows).toHaveLength(2);
    expect(rows[0].tenant_id).toBe("tenant-a");
    expect(rows[1].tenant_id).toBe("tenant-b");
    // Each tenant's checkpoint must be past its own events
    expect(Number(rows[0].last_global_position)).toBeGreaterThanOrEqual(1);
    expect(Number(rows[1].last_global_position)).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Async projection runner — cross-tenant
// ============================================================================

describe("multi-tenancy: async projection runner (cross-tenant)", () => {
  it("single runner processes outbox rows from all tenants", async () => {
    const factory = createFactory();

    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-async-a", { type: "AccountOpened", version: 1, accountId: "acc-async-a", owner: "A", balance: 100 } as TestEvent);
    await sA.saveChangesAsync();

    const sB = factory.createSession("tenant-b");
    sB.startStream("acc-async-b", { type: "AccountOpened", version: 1, accountId: "acc-async-b", owner: "B", balance: 200 } as TestEvent);
    await sB.saveChangesAsync();

    const processed: Array<{ tenantId: string; aggregateId: string }> = [];
    const projection: AsyncProjection<TestEvent, PgTx> = {
      name: "cross-tenant-async",
      topicFilter: { mode: "include", topics: ["account"] },
      async handle(_tx, env) {
        processed.push({ tenantId: env.tenantId, aggregateId: env.aggregateId });
      }
    };

    const abort = new AbortController();
    const runner = createAsyncProjectionRunner(pool, store, [projection], {
      workerId: "worker-all",
      batchSize: 10,
      idleSleepMs: 100,
      maxAttempts: 3
    });

    const p = runner.start(abort.signal);
    await sleep(500);
    abort.abort();
    await p.catch(() => {});

    expect(processed).toHaveLength(2);
    expect(processed).toContainEqual({ tenantId: "tenant-a", aggregateId: "acc-async-a" });
    expect(processed).toContainEqual({ tenantId: "tenant-b", aggregateId: "acc-async-b" });
  });
});

// ============================================================================
// DLQ — tenant_id preserved for inspection
// ============================================================================

describe("multi-tenancy: DLQ", () => {
  it("DLQ listing is tenant-scoped for ops", async () => {
    const dlqA = new PgDlqService(pool, undefined, undefined, "tenant-a");
    const dlqB = new PgDlqService(pool, undefined, undefined, "tenant-b");

    const resultA = await dlqA.list({});
    const resultB = await dlqB.list({});
    expect(resultA.total).toBe(0);
    expect(resultB.total).toBe(0);
  });
});

// ============================================================================
// EventEnvelope carries tenantId
// ============================================================================

describe("multi-tenancy: EventEnvelope tenantId", () => {
  it("events appended through session carry tenantId in the envelope", async () => {
    const factory = createFactory();

    const session = factory.createSession("tenant-xyz");
    session.startStream("acc-env", { type: "AccountOpened", version: 1, accountId: "acc-env", owner: "XYZ", balance: 42 } as TestEvent);
    await session.saveChangesAsync();

    // loadStream filters by tx.tenantId — using default tenant should NOT find tenant-xyz events
    const uow = new PgUnitOfWork(pool);
    const wrongTenantEvents = await uow.withTransaction(tx =>
      store.loadStream(tx, { aggregateName: "Account", aggregateId: "acc-env" })
    );
    expect(wrongTenantEvents).toHaveLength(0);

    // loadGlobal is cross-tenant — should find the event with tenantId on the envelope
    const allEvents = await uow.withTransaction(tx =>
      store.loadGlobal(tx, { fromGlobalPositionExclusive: 0n, limit: 100 })
    );

    const env = allEvents.find(e => e.aggregateId === "acc-env");
    expect(env).toBeDefined();
    expect(env!.tenantId).toBe("tenant-xyz");
  });
});

// ============================================================================
// Snapshot cross-pollination guard
// ============================================================================

describe("multi-tenancy: snapshot cross-pollination", () => {
  it("tenant without snapshot replays from events, does not use another tenant's snapshot", async () => {
    const snapshotStore = new PgSnapshotStore<AccountState>();
    const factory = new SessionFactory<TestEvent>(pool, store);
    factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited"], "account", {
      snapshotStore,
      snapshotPolicy: { everyNEvents: 1 },
      snapshotSchemaVersion: 1
    });

    // Tenant-A: create account (triggers snapshot at v1 with balance 100)
    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-xpoll", { type: "AccountOpened", version: 1, accountId: "acc-xpoll", owner: "A", balance: 100 } as TestEvent);
    await sA.saveChangesAsync();

    // Tenant-B: create same ID with balance 0, then deposit 25
    const sB1 = factory.createSession("tenant-b");
    sB1.startStream("acc-xpoll", { type: "AccountOpened", version: 1, accountId: "acc-xpoll", owner: "B", balance: 0 } as TestEvent);
    await sB1.saveChangesAsync();

    const sB2 = factory.createSession("tenant-b");
    const accB = await sB2.loadAggregateAsync<AccountAggregate>("acc-xpoll");
    accB.deposit(25);
    await sB2.saveChangesAsync();

    // Tenant-B should have balance 25 (0 + 25), NOT 100 from tenant-A's snapshot
    const sB3 = factory.createSession("tenant-b");
    const finalB = await sB3.loadAggregateAsync<AccountAggregate>("acc-xpoll");
    expect(finalB.state.balance).toBe(25);
    expect(finalB.state.owner).toBe("B");
  });
});

// ============================================================================
// Same-tenant duplicate stream guard
// ============================================================================

describe("multi-tenancy: duplicate stream within same tenant", () => {
  it("creating same stream ID twice in the same tenant throws ConcurrencyError", async () => {
    const factory = createFactory();

    const s1 = factory.createSession("tenant-a");
    s1.startStream("acc-dup", { type: "AccountOpened", version: 1, accountId: "acc-dup", owner: "A", balance: 0 } as TestEvent);
    await s1.saveChangesAsync();

    const s2 = factory.createSession("tenant-a");
    s2.startStream("acc-dup", { type: "AccountOpened", version: 1, accountId: "acc-dup", owner: "A2", balance: 0 } as TestEvent);
    await expect(s2.saveChangesAsync()).rejects.toThrow("already exists");
  });

  it("same stream ID in different tenant succeeds", async () => {
    const factory = createFactory();

    const s1 = factory.createSession("tenant-a");
    s1.startStream("acc-dup2", { type: "AccountOpened", version: 1, accountId: "acc-dup2", owner: "A", balance: 0 } as TestEvent);
    await s1.saveChangesAsync();

    const s2 = factory.createSession("tenant-b");
    s2.startStream("acc-dup2", { type: "AccountOpened", version: 1, accountId: "acc-dup2", owner: "B", balance: 0 } as TestEvent);
    await expect(s2.saveChangesAsync()).resolves.not.toThrow();
  });
});

// ============================================================================
// Dismiss isolation
// ============================================================================

describe("multi-tenancy: dismiss isolation", () => {
  it("dismissing an event in one tenant does not affect another tenant", async () => {
    const factory = createFactory();

    // Both tenants create events
    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-dismiss", { type: "AccountOpened", version: 1, accountId: "acc-dismiss", owner: "A", balance: 100 } as TestEvent);
    await sA.saveChangesAsync();

    const sB = factory.createSession("tenant-b");
    sB.startStream("acc-dismiss", { type: "AccountOpened", version: 1, accountId: "acc-dismiss", owner: "B", balance: 200 } as TestEvent);
    await sB.saveChangesAsync();

    // Get tenant-A's event ID
    const { rows: evA } = await pool.query(
      `SELECT event_id FROM eventfabric.events WHERE tenant_id = 'tenant-a' AND aggregate_id = 'acc-dismiss'`
    );
    const eventIdA = evA[0].event_id;

    // Dismiss tenant-A's event
    const uowA = new PgUnitOfWork(pool, "tenant-a");
    await uowA.withTransaction(tx => store.dismiss(tx, eventIdA, { reason: "test" }));

    // Tenant-A's event is dismissed
    const { rows: afterA } = await pool.query(
      `SELECT dismissed_at FROM eventfabric.events WHERE tenant_id = 'tenant-a' AND aggregate_id = 'acc-dismiss'`
    );
    expect(afterA[0].dismissed_at).not.toBeNull();

    // Tenant-B's event is NOT dismissed
    const { rows: afterB } = await pool.query(
      `SELECT dismissed_at FROM eventfabric.events WHERE tenant_id = 'tenant-b' AND aggregate_id = 'acc-dismiss'`
    );
    expect(afterB[0].dismissed_at).toBeNull();
  });

  it("dismiss with wrong tenant is a no-op", async () => {
    const factory = createFactory();

    const sA = factory.createSession("tenant-a");
    sA.startStream("acc-dismiss2", { type: "AccountOpened", version: 1, accountId: "acc-dismiss2", owner: "A", balance: 50 } as TestEvent);
    await sA.saveChangesAsync();

    // Get tenant-A's event_id
    const { rows } = await pool.query(
      `SELECT event_id FROM eventfabric.events WHERE tenant_id = 'tenant-a' AND aggregate_id = 'acc-dismiss2'`
    );
    const eventId = rows[0].event_id;

    // Try to dismiss from tenant-b's context — should be a no-op
    const uowB = new PgUnitOfWork(pool, "tenant-b");
    await uowB.withTransaction(tx => store.dismiss(tx, eventId, { reason: "wrong tenant" }));

    // Event is still NOT dismissed
    const { rows: after } = await pool.query(
      `SELECT dismissed_at FROM eventfabric.events WHERE event_id = $1`, [eventId]
    );
    expect(after[0].dismissed_at).toBeNull();
  });
});

// ============================================================================
// Global position ordering across tenants
// ============================================================================

describe("multi-tenancy: global position ordering", () => {
  it("catch-up projection processes each tenant's events in global_position order", async () => {
    const factory = createFactory();

    // Interleave writes: A1, B1, A2, B2 in the events table
    const sA1 = factory.createSession("tenant-a");
    sA1.startStream("acc-ord-a1", { type: "AccountOpened", version: 1, accountId: "acc-ord-a1", owner: "A1", balance: 0 } as TestEvent);
    await sA1.saveChangesAsync();

    const sB1 = factory.createSession("tenant-b");
    sB1.startStream("acc-ord-b1", { type: "AccountOpened", version: 1, accountId: "acc-ord-b1", owner: "B1", balance: 0 } as TestEvent);
    await sB1.saveChangesAsync();

    const sA2 = factory.createSession("tenant-a");
    sA2.startStream("acc-ord-a2", { type: "AccountOpened", version: 1, accountId: "acc-ord-a2", owner: "A2", balance: 0 } as TestEvent);
    await sA2.saveChangesAsync();

    const sB2 = factory.createSession("tenant-b");
    sB2.startStream("acc-ord-b2", { type: "AccountOpened", version: 1, accountId: "acc-ord-b2", owner: "B2", balance: 0 } as TestEvent);
    await sB2.saveChangesAsync();

    const order: Array<{ tenant: string; id: string }> = [];
    const projection: CatchUpProjection<TestEvent, PgTx> = {
      name: "ordering-test",
      async handle(_tx, env) {
        order.push({ tenant: env.tenantId, id: env.aggregateId });
      }
    };

    const projector = createCatchUpProjector(pool, store);
    await projector.catchUpAll([projection], { batchSize: 100 });

    // Contract: within a tenant, events are delivered in global_position order.
    // Across tenants, rounds are fanned out independently (no cross-tenant
    // global ordering guarantee) so one tenant's slow handler can't block
    // another tenant's progress.
    const tenantAOrder = order.filter((o) => o.tenant === "tenant-a").map((o) => o.id);
    const tenantBOrder = order.filter((o) => o.tenant === "tenant-b").map((o) => o.id);
    expect(tenantAOrder).toEqual(["acc-ord-a1", "acc-ord-a2"]);
    expect(tenantBOrder).toEqual(["acc-ord-b1", "acc-ord-b2"]);
    expect(order).toHaveLength(4);
  });
});

// ============================================================================
// Batch-mode async runner: mixed-tenant failure behaviour
// ============================================================================

describe("multi-tenancy: batch-mode failure rollback", () => {
  it("in batch mode, tenant-2 failure rolls back the entire batch including tenant-1", async () => {
    const factory = createFactory();

    // Tenant-1 and tenant-2 both raise events
    const s1 = factory.createSession("tenant-1");
    s1.startStream("acc-batch-t1", { type: "AccountOpened", version: 1, accountId: "acc-batch-t1", owner: "T1", balance: 100 } as TestEvent);
    await s1.saveChangesAsync();

    const s2 = factory.createSession("tenant-2");
    s2.startStream("acc-batch-t2", { type: "AccountOpened", version: 1, accountId: "acc-batch-t2", owner: "T2", balance: 200 } as TestEvent);
    await s2.saveChangesAsync();

    let attempts = 0;
    const projection: AsyncProjection<TestEvent, PgTx> = {
      name: "batch-fail-proj",
      topicFilter: { mode: "include", topics: ["account"] },
      async handle(_tx, env) {
        attempts++;
        if (env.tenantId === "tenant-2") {
          throw new Error("tenant-2 batch fail");
        }
      }
    };

    // batch mode — all events in one tx
    const abort = new AbortController();
    const runner = createAsyncProjectionRunner(pool, store, [projection], {
      workerId: "worker-batch",
      batchSize: 10,
      idleSleepMs: 100,
      maxAttempts: 2,
      transactionMode: "batch"
    });

    const p = runner.start(abort.signal);
    await sleep(1500);
    abort.abort();
    await p.catch(() => {});

    // In batch mode, tenant-1 was re-processed because the batch rolled back.
    // This is the expected trade-off of batch mode.
    expect(attempts).toBeGreaterThan(2); // tenant-1 was retried at least once
  }, 10000);
});

// ============================================================================
// TenantResolver implementations
// ============================================================================

describe("multi-tenancy: TenantResolver", () => {
  it("ConjoinedTenantResolver returns the same pool for any tenant", async () => {
    const { ConjoinedTenantResolver } = await import("../src/tenancy/tenant-resolver");
    const resolver = new ConjoinedTenantResolver(pool);

    // getPool() takes no args — always returns the shared pool
    expect(resolver.getPool()).toBe(pool);
  });

  it("PerDatabaseTenantResolver returns the correct pool per tenant", async () => {
    const { PerDatabaseTenantResolver } = await import("../src/tenancy/tenant-resolver");

    const poolA = {} as Pool;
    const poolB = {} as Pool;
    const resolver = new PerDatabaseTenantResolver({ "tenant-a": poolA, "tenant-b": poolB });

    expect(resolver.getPool("tenant-a")).toBe(poolA);
    expect(resolver.getPool("tenant-b")).toBe(poolB);
  });

  it("PerDatabaseTenantResolver throws for unknown tenant", async () => {
    const { PerDatabaseTenantResolver } = await import("../src/tenancy/tenant-resolver");
    const resolver = new PerDatabaseTenantResolver({ "known": {} as Pool });

    expect(() => resolver.getPool("unknown")).toThrow('No pool configured for tenant "unknown"');
  });

  it("PerDatabaseTenantResolver.addTenant adds a new tenant at runtime", async () => {
    const { PerDatabaseTenantResolver } = await import("../src/tenancy/tenant-resolver");
    const resolver = new PerDatabaseTenantResolver({});
    const newPool = {} as Pool;

    resolver.addTenant("new-tenant", newPool);
    expect(resolver.getPool("new-tenant")).toBe(newPool);
  });

  it("PerDatabaseTenantResolver.addTenant rejects duplicate tenant", async () => {
    const { PerDatabaseTenantResolver } = await import("../src/tenancy/tenant-resolver");
    const resolver = new PerDatabaseTenantResolver({ existing: {} as Pool });

    expect(() => resolver.addTenant("existing", {} as Pool)).toThrow('already registered');
  });
});

// ============================================================================
// Scenario tests: projection side-effects + failure isolation
// ============================================================================

describe("multi-tenancy: projection side-effect scenarios", () => {
  it("scenario 1: projection handler receives tenantId from the event that triggered it", async () => {
    const factory = createFactory();

    // Tenant-1 raises an event
    const s1 = factory.createSession("tenant-1");
    s1.startStream("acc-sc1", { type: "AccountOpened", version: 1, accountId: "acc-sc1", owner: "T1", balance: 100 } as TestEvent);
    await s1.saveChangesAsync();

    // Global catch-up projection processes it
    const received: Array<{ tenantId: string; type: string; aggregateId: string }> = [];
    const projection: CatchUpProjection<TestEvent, PgTx> = {
      name: "scenario-1-proj",
      async handle(_tx, env) {
        received.push({
          tenantId: env.tenantId,
          type: env.payload.type,
          aggregateId: env.aggregateId
        });
      }
    };

    const projector = createCatchUpProjector(pool, store);
    await projector.catchUpAll([projection], { batchSize: 100 });

    expect(received).toHaveLength(1);
    expect(received[0]!.tenantId).toBe("tenant-1");
    expect(received[0]!.type).toBe("AccountOpened");
    expect(received[0]!.aggregateId).toBe("acc-sc1");
  });

  it("scenario 2 (catch-up): failure on tenant-2 does not block tenant-1 or re-process its events", async () => {
    const factory = createFactory();

    // Both tenants raise events
    const s1 = factory.createSession("tenant-1");
    s1.startStream("acc-sc2-t1", { type: "AccountOpened", version: 1, accountId: "acc-sc2-t1", owner: "T1", balance: 100 } as TestEvent);
    await s1.saveChangesAsync();

    const s2 = factory.createSession("tenant-2");
    s2.startStream("acc-sc2-t2", { type: "AccountOpened", version: 1, accountId: "acc-sc2-t2", owner: "T2", balance: 200 } as TestEvent);
    await s2.saveChangesAsync();

    let processCount = 0;
    const processedByTenant: string[] = [];
    const projection: CatchUpProjection<TestEvent, PgTx> = {
      name: "scenario-2-proj",
      async handle(_tx, env) {
        processCount++;
        processedByTenant.push(env.tenantId);
        if (env.tenantId === "tenant-2") {
          throw new Error("Simulated tenant-2 failure");
        }
      }
    };

    // Run 1: both tenants attempted. tenant-1 succeeds and its checkpoint
    // advances. tenant-2 throws — the projector isolates the error,
    // reports it via the observer, and rolls back tenant-2's tx so its
    // checkpoint stays at 0.
    let reportedErrors: string[] = [];
    const observer = {
      onProjectorError: ({ error }: { error: Error }) => reportedErrors.push(error.message)
    };
    const projector = createCatchUpProjector(pool, store);
    await projector.catchUpAll([projection], { batchSize: 100, observer });
    expect(processedByTenant).toContain("tenant-1");
    expect(processedByTenant).toContain("tenant-2");
    expect(reportedErrors).toContain("Simulated tenant-2 failure");

    // Run 2: tenant-1's checkpoint is already past its event, so it's not
    // re-processed. tenant-2's checkpoint is still 0, so its event is
    // re-attempted.
    processCount = 0;
    processedByTenant.length = 0;
    reportedErrors = [];
    await projector.catchUpAll([projection], { batchSize: 100, observer });
    expect(processedByTenant).toEqual(["tenant-2"]);
    expect(reportedErrors).toContain("Simulated tenant-2 failure");
  });

  it("scenario 2 (async/perRow): failure on tenant-2 does not affect tenant-1", async () => {
    const factory = createFactory();

    // Both tenants raise events
    const s1 = factory.createSession("tenant-1");
    s1.startStream("acc-sc2a-t1", { type: "AccountOpened", version: 1, accountId: "acc-sc2a-t1", owner: "T1", balance: 100 } as TestEvent);
    await s1.saveChangesAsync();

    const s2 = factory.createSession("tenant-2");
    s2.startStream("acc-sc2a-t2", { type: "AccountOpened", version: 1, accountId: "acc-sc2a-t2", owner: "T2", balance: 200 } as TestEvent);
    await s2.saveChangesAsync();

    const succeeded: string[] = [];
    const projection: AsyncProjection<TestEvent, PgTx> = {
      name: "scenario-2a-proj",
      topicFilter: { mode: "include", topics: ["account"] },
      async handle(_tx, env) {
        if (env.tenantId === "tenant-2") {
          throw new Error("Simulated tenant-2 failure");
        }
        succeeded.push(env.tenantId);
      }
    };

    // Use perRow mode so each event is its own transaction
    const abort = new AbortController();
    const runner = createAsyncProjectionRunner(pool, store, [projection], {
      workerId: "worker-sc2a",
      batchSize: 10,
      idleSleepMs: 100,
      maxAttempts: 1, // fail fast, DLQ immediately
      transactionMode: "perRow"
    });

    const p = runner.start(abort.signal);
    await sleep(1000);
    abort.abort();
    await p.catch(() => {});

    // Tenant-1's event was processed successfully despite tenant-2's failure
    expect(succeeded).toContain("tenant-1");
    expect(succeeded).not.toContain("tenant-2");

    // Tenant-1's outbox entry should be acked (deleted)
    const { rows: outboxRows } = await pool.query(
      `SELECT tenant_id FROM eventfabric.outbox WHERE dead_lettered_at IS NULL`
    );
    const tenant1InOutbox = outboxRows.filter((r: any) => r.tenant_id === "tenant-1");
    expect(tenant1InOutbox).toHaveLength(0);

    // Tenant-2's event should be in DLQ with its tenant_id preserved
    const { rows: dlqRows } = await pool.query(
      `SELECT tenant_id FROM eventfabric.outbox_dead_letters`
    );
    expect(dlqRows.length).toBeGreaterThanOrEqual(1);
    expect(dlqRows.some((r: any) => r.tenant_id === "tenant-2")).toBe(true);

    // DLQ service scoped to tenant-2 should see the item
    const dlq2 = new PgDlqService(pool, undefined, undefined, "tenant-2");
    const dlqResult = await dlq2.list({});
    expect(dlqResult.total).toBeGreaterThanOrEqual(1);

    // DLQ service scoped to tenant-1 should see nothing
    const dlq1 = new PgDlqService(pool, undefined, undefined, "tenant-1");
    const dlqResult1 = await dlq1.list({});
    expect(dlqResult1.total).toBe(0);
  }, 10000);
});
