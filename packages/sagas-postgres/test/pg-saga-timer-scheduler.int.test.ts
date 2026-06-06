import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  InMemorySagaCommandQueue,
  SagaTimerScheduler,
  type Saga,
  type SagaReaction,
  type SagaTimerHandler,
  type TimerMessage,
} from "@eventfabric/sagas";
import {
  PgSagaStateStore,
  PgSagaTimerStore,
  sagasMigrations,
} from "../src";
import { PgUnitOfWork, migrate, type PgTx } from "@eventfabric/postgres";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool, { extensions: [sagasMigrations] });
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM eventfabric.saga_scheduled_messages`);
  await pool.query(`DELETE FROM eventfabric.saga_instances`);
});

type CounterState = { fired: number };
type CounterEvent = { type: "Tick"; version: 1; counterId: string };

const counterSaga: Saga<CounterState, CounterEvent> = {
  name: "Counter",
  version: 1,
  correlate: (env) => env.payload.counterId,
  startsNewInstance: () => true,
  initialState: () => ({ fired: 0 }),
  reactToEvent: (state) => ({ newState: state }),
  reactToTimer(state, timer: TimerMessage): SagaReaction<CounterState> {
    if (timer.id === "end") {
      return { newState: { fired: state.fired + 1 }, end: true };
    }
    return { newState: { fired: state.fired + 1 } };
  },
};

const seedInstance = async (instanceId: string, tenantId = "default") => {
  const stateStore = new PgSagaStateStore<CounterState>();
  const uow = new PgUnitOfWork(pool, tenantId);
  const now = new Date().toISOString();
  await uow.withTransaction((tx: PgTx) =>
    stateStore.insert(tx, {
      sagaName: "Counter",
      instanceId,
      tenantId,
      state: { fired: 0 },
      stateVersion: 0,
      status: "active",
      schemaVersion: 1,
      lastEventPos: null,
      createdAt: now,
      updatedAt: now,
    })
  );
};

describe("PgSagaTimerStore + SagaTimerScheduler (integration)", () => {
  it("schedule + claimDue + markFired round-trip via scheduler", async () => {
    await seedInstance("i-1");

    const stateStore = new PgSagaStateStore<CounterState>();
    const timerStore = new PgSagaTimerStore();
    const commandQueue = new InMemorySagaCommandQueue();

    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx: PgTx) =>
      timerStore.schedule(tx, {
        tenantId: "default",
        sagaName: "Counter",
        instanceId: "i-1",
        id: "tick",
        fireAt: new Date(Date.now() - 1000),
        message: { type: "$timer", id: "tick", payload: null },
      })
    );

    const handlers = new Map<string, SagaTimerHandler<PgTx>>([
      [
        "Counter",
        {
          saga: counterSaga as Saga<any, any>,
          stores: { stateStore, commandQueue, timerStore },
        },
      ],
    ]);

    const scheduler = new SagaTimerScheduler(uow, timerStore, handlers);
    const round = await scheduler.runOnce();
    expect(round).toMatchObject({ claimed: 1, fired: 1 });

    const inst = await uow.withTransaction((tx: PgTx) =>
      stateStore.load(tx, { sagaName: "Counter", instanceId: "i-1", tenantId: "default" })
    );
    expect(inst!.state.fired).toBe(1);

    const row = await pool.query(
      `SELECT status FROM eventfabric.saga_scheduled_messages WHERE id = 'tick'`
    );
    expect(row.rows[0]!.status).toBe("fired");
  });

  it("does not claim future timers", async () => {
    await seedInstance("i-1");

    const stateStore = new PgSagaStateStore<CounterState>();
    const timerStore = new PgSagaTimerStore();
    const commandQueue = new InMemorySagaCommandQueue();
    const uow = new PgUnitOfWork(pool);

    await uow.withTransaction((tx: PgTx) =>
      timerStore.schedule(tx, {
        tenantId: "default",
        sagaName: "Counter",
        instanceId: "i-1",
        id: "future",
        fireAt: new Date(Date.now() + 60_000),
        message: { type: "$timer", id: "future", payload: null },
      })
    );

    const handlers = new Map<string, SagaTimerHandler<PgTx>>([
      [
        "Counter",
        {
          saga: counterSaga as Saga<any, any>,
          stores: { stateStore, commandQueue, timerStore },
        },
      ],
    ]);

    const scheduler = new SagaTimerScheduler(uow, timerStore, handlers);
    const round = await scheduler.runOnce();
    expect(round.claimed).toBe(0);
  });

  it("schedule with the same id (tenant, saga, instance) replaces the prior pending row", async () => {
    const timerStore = new PgSagaTimerStore();
    const uow = new PgUnitOfWork(pool);

    const t1 = new Date(Date.now() + 60_000);
    await uow.withTransaction((tx: PgTx) =>
      timerStore.schedule(tx, {
        tenantId: "default",
        sagaName: "Counter",
        instanceId: "i-1",
        id: "t",
        fireAt: t1,
        message: { type: "$timer", id: "t", payload: { v: 1 } },
      })
    );

    const t2 = new Date(Date.now() + 120_000);
    await uow.withTransaction((tx: PgTx) =>
      timerStore.schedule(tx, {
        tenantId: "default",
        sagaName: "Counter",
        instanceId: "i-1",
        id: "t",
        fireAt: t2,
        message: { type: "$timer", id: "t", payload: { v: 2 } },
      })
    );

    const rows = await pool.query(
      `SELECT fire_at, message FROM eventfabric.saga_scheduled_messages WHERE id = 't'`
    );
    expect(rows.rowCount).toBe(1);
    expect(new Date(rows.rows[0]!.fire_at).getTime()).toBe(t2.getTime());
    expect(rows.rows[0]!.message).toEqual({ type: "$timer", id: "t", payload: { v: 2 } });
  });

  it("cancel marks the matching ids as cancelled and returns the count", async () => {
    const timerStore = new PgSagaTimerStore();
    const uow = new PgUnitOfWork(pool);

    for (const id of ["t1", "t2", "t3"]) {
      await uow.withTransaction((tx: PgTx) =>
        timerStore.schedule(tx, {
          tenantId: "default",
          sagaName: "Counter",
          instanceId: "i-1",
          id,
          fireAt: new Date(Date.now() + 60_000),
          message: { type: "$timer", id, payload: null },
        })
      );
    }

    const cancelled = await uow.withTransaction((tx: PgTx) =>
      timerStore.cancel(tx, {
        tenantId: "default",
        sagaName: "Counter",
        instanceId: "i-1",
        ids: ["t1", "t3", "t-missing"],
      })
    );
    expect(cancelled).toBe(2);

    const rows = await pool.query(
      `SELECT id, status FROM eventfabric.saga_scheduled_messages WHERE instance_id = 'i-1' ORDER BY id`
    );
    const map = Object.fromEntries(rows.rows.map((r: any) => [r.id, r.status]));
    expect(map).toEqual({ t1: "cancelled", t2: "pending", t3: "cancelled" });
  });

  it("supports concurrent scheduler workers via FOR UPDATE SKIP LOCKED", async () => {
    for (let i = 0; i < 20; i++) await seedInstance(`i-${i}`);

    const stateStore = new PgSagaStateStore<CounterState>();
    const timerStore = new PgSagaTimerStore();
    const commandQueue = new InMemorySagaCommandQueue();
    const uow = new PgUnitOfWork(pool);

    for (let i = 0; i < 20; i++) {
      await uow.withTransaction((tx: PgTx) =>
        timerStore.schedule(tx, {
          tenantId: "default",
          sagaName: "Counter",
          instanceId: `i-${i}`,
          id: "tick",
          fireAt: new Date(Date.now() - 1000),
          message: { type: "$timer", id: "tick", payload: null },
        })
      );
    }

    const handlers = new Map<string, SagaTimerHandler<PgTx>>([
      [
        "Counter",
        {
          saga: counterSaga as Saga<any, any>,
          stores: { stateStore, commandQueue, timerStore },
        },
      ],
    ]);

    const a = new SagaTimerScheduler(uow, timerStore, handlers, { batchSize: 50 });
    const b = new SagaTimerScheduler(uow, timerStore, handlers, { batchSize: 50 });

    const [r1, r2] = await Promise.all([a.runOnce(), b.runOnce()]);
    expect(r1.fired + r2.fired).toBe(20);
    expect(r1.claimed + r2.claimed).toBe(20);

    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS n FROM eventfabric.saga_scheduled_messages WHERE status = 'pending'`
    );
    expect(remaining.rows[0]!.n).toBe(0);
  }, 30000);

  it("resetStaleClaimed() returns leaked claimed timers to pending so the next round fires them", async () => {
    await seedInstance("i-stuck");

    const timerStore = new PgSagaTimerStore();
    const uow = new PgUnitOfWork(pool);

    await uow.withTransaction((tx: PgTx) =>
      timerStore.schedule(tx, {
        tenantId: "default",
        sagaName: "Counter",
        instanceId: "i-stuck",
        id: "end",
        fireAt: new Date(Date.now() - 1000),
        message: { type: "$timer", id: "end", payload: null },
      })
    );

    // Simulate a scheduler that crashed mid-delivery: claim the row,
    // then backdate claimed_at past the watchdog window.
    await uow.withTransaction((tx: PgTx) =>
      timerStore.claimDue(tx, { now: new Date(), batchSize: 10 })
    );
    await pool.query(
      `UPDATE eventfabric.saga_scheduled_messages
          SET claimed_at = NOW() - INTERVAL '10 minutes'
        WHERE status = 'claimed'`
    );

    const reset = await uow.withTransaction((tx: PgTx) =>
      timerStore.resetStaleClaimed(tx, {
        olderThan: new Date(Date.now() - 5 * 60 * 1000),
      })
    );
    expect(reset).toBe(1);

    const after = await pool.query(
      `SELECT status, claimed_at FROM eventfabric.saga_scheduled_messages
        WHERE instance_id = 'i-stuck' AND id = 'end'`
    );
    expect(after.rows[0]!.status).toBe("pending");
    expect(after.rows[0]!.claimed_at).toBeNull();

    // Next scheduler round delivers the timer normally.
    const stateStore = new PgSagaStateStore<CounterState>();
    const commandQueue = new InMemorySagaCommandQueue();
    const handlers = new Map<string, SagaTimerHandler<PgTx>>([
      [
        "Counter",
        {
          saga: counterSaga as Saga<any, any>,
          stores: { stateStore, commandQueue, timerStore },
        },
      ],
    ]);
    const scheduler = new SagaTimerScheduler(uow, timerStore, handlers);
    const round = await scheduler.runOnce();
    expect(round.fired).toBe(1);

    const final = await pool.query(
      `SELECT status FROM eventfabric.saga_scheduled_messages
        WHERE instance_id = 'i-stuck' AND id = 'end'`
    );
    expect(final.rows[0]!.status).toBe("fired");
  });

  it("resetStaleClaimed() leaves fresh claimed timers alone", async () => {
    await seedInstance("i-fresh");

    const timerStore = new PgSagaTimerStore();
    const uow = new PgUnitOfWork(pool);

    await uow.withTransaction((tx: PgTx) =>
      timerStore.schedule(tx, {
        tenantId: "default",
        sagaName: "Counter",
        instanceId: "i-fresh",
        id: "tick",
        fireAt: new Date(Date.now() - 1000),
        message: { type: "$timer", id: "tick", payload: null },
      })
    );

    await uow.withTransaction((tx: PgTx) =>
      timerStore.claimDue(tx, { now: new Date(), batchSize: 10 })
    );
    // claimed_at is "just now" — well within the watchdog window.

    const reset = await uow.withTransaction((tx: PgTx) =>
      timerStore.resetStaleClaimed(tx, {
        olderThan: new Date(Date.now() - 5 * 60 * 1000),
      })
    );
    expect(reset).toBe(0);

    const after = await pool.query(
      `SELECT status FROM eventfabric.saga_scheduled_messages
        WHERE instance_id = 'i-fresh' AND id = 'tick'`
    );
    expect(after.rows[0]!.status).toBe("claimed");
  });

  it("delivers each tenant's timer under its own tenant context — instances do not cross-pollinate", async () => {
    // Seed the SAME instanceId under two tenants. The scheduler must route
    // each fire to the right tenant's saga instance.
    await seedInstance("i-1", "acme");
    await seedInstance("i-1", "contoso");

    const stateStore = new PgSagaStateStore<CounterState>();
    const timerStore = new PgSagaTimerStore();
    const commandQueue = new InMemorySagaCommandQueue();

    const acmeUow = new PgUnitOfWork(pool, "acme");
    await acmeUow.withTransaction((tx: PgTx) =>
      timerStore.schedule(tx, {
        tenantId: "acme",
        sagaName: "Counter",
        instanceId: "i-1",
        id: "tick",
        fireAt: new Date(Date.now() - 1000),
        message: { type: "$timer", id: "tick", payload: null },
      })
    );

    const contosoUow = new PgUnitOfWork(pool, "contoso");
    await contosoUow.withTransaction((tx: PgTx) =>
      timerStore.schedule(tx, {
        tenantId: "contoso",
        sagaName: "Counter",
        instanceId: "i-1",
        id: "tick",
        fireAt: new Date(Date.now() - 1000),
        message: { type: "$timer", id: "tick", payload: null },
      })
    );

    const handlers = new Map<string, SagaTimerHandler<PgTx>>([
      [
        "Counter",
        {
          saga: counterSaga as Saga<any, any>,
          stores: { stateStore, commandQueue, timerStore },
        },
      ],
    ]);

    // Scheduler runs without a fixed tenant — it must narrow per-row.
    const scheduler = new SagaTimerScheduler(new PgUnitOfWork(pool), timerStore, handlers);
    const round = await scheduler.runOnce();
    expect(round.fired).toBe(2);

    const acmeInst = await acmeUow.withTransaction((tx: PgTx) =>
      stateStore.load(tx, { sagaName: "Counter", instanceId: "i-1", tenantId: "acme" })
    );
    const contosoInst = await contosoUow.withTransaction((tx: PgTx) =>
      stateStore.load(tx, { sagaName: "Counter", instanceId: "i-1", tenantId: "contoso" })
    );
    expect(acmeInst!.state.fired).toBe(1);
    expect(contosoInst!.state.fired).toBe(1);

    const rows = await pool.query(
      `SELECT tenant_id, status FROM eventfabric.saga_scheduled_messages
        WHERE id = 'tick' ORDER BY tenant_id`
    );
    expect(rows.rows.map((r: any) => ({ t: r.tenant_id, s: r.status }))).toEqual([
      { t: "acme", s: "fired" },
      { t: "contoso", s: "fired" },
    ]);
  });

  it("orphaned timer (no handler) defaults to status='failed' so ops can triage rather than silently discarding", async () => {
    await seedInstance("i-orphan");

    const timerStore = new PgSagaTimerStore();
    const uow = new PgUnitOfWork(pool);

    await uow.withTransaction((tx: PgTx) =>
      timerStore.schedule(tx, {
        tenantId: "default",
        sagaName: "GhostSaga",        // no handler registered
        instanceId: "i-orphan",
        id: "lost",
        fireAt: new Date(Date.now() - 1000),
        message: { type: "$timer", id: "lost", payload: null },
      })
    );

    // No handler for "GhostSaga" — default policy is "fail".
    const scheduler = new SagaTimerScheduler(uow, timerStore, new Map());
    const round = await scheduler.runOnce();
    expect(round).toMatchObject({ claimed: 1, orphaned: 1, fired: 0 });

    const row = await pool.query(
      `SELECT status, last_error FROM eventfabric.saga_scheduled_messages
        WHERE id = 'lost'`
    );
    expect(row.rows[0]!.status).toBe("failed");
    expect(row.rows[0]!.last_error).toMatch(/No handler/);
  });

  it("orphaned timer with onOrphanedTimer='discard' silently markFireds the row (legacy behaviour, opt-in)", async () => {
    await seedInstance("i-discard");

    const stateStore = new PgSagaStateStore<CounterState>();
    const timerStore = new PgSagaTimerStore();
    const uow = new PgUnitOfWork(pool);

    await uow.withTransaction((tx: PgTx) =>
      timerStore.schedule(tx, {
        tenantId: "default",
        sagaName: "GhostSaga",
        instanceId: "i-discard",
        id: "lost",
        fireAt: new Date(Date.now() - 1000),
        message: { type: "$timer", id: "lost", payload: null },
      })
    );

    const scheduler = new SagaTimerScheduler(uow, timerStore, new Map(), {
      onOrphanedTimer: "discard",
    });
    const round = await scheduler.runOnce();
    expect(round).toMatchObject({ claimed: 1, orphaned: 1 });

    const row = await pool.query(
      `SELECT status FROM eventfabric.saga_scheduled_messages WHERE id = 'lost'`
    );
    expect(row.rows[0]!.status).toBe("fired");
  });

  it("cleanupTerminal({ statuses: ['fired','cancelled'] }) deletes both terminal kinds past the cutoff, leaves pending + claimed alone", async () => {
    const timerStore = new PgSagaTimerStore();
    const uow = new PgUnitOfWork(pool);

    // Schedule four timers then transition them to different statuses.
    for (const id of ["t-fired-old", "t-cancelled-old", "t-pending-old", "t-fired-fresh"]) {
      await uow.withTransaction((tx: PgTx) =>
        timerStore.schedule(tx, {
          tenantId: "default", sagaName: "Counter", instanceId: "i-1",
          id, fireAt: new Date(Date.now() + 60_000),
          message: { type: "$timer", id, payload: null },
        })
      );
    }

    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      `UPDATE eventfabric.saga_scheduled_messages
          SET status = 'fired', scheduled_at = $1::timestamptz
        WHERE id = 't-fired-old'`,
      [old]
    );
    await pool.query(
      `UPDATE eventfabric.saga_scheduled_messages
          SET status = 'cancelled', scheduled_at = $1::timestamptz
        WHERE id = 't-cancelled-old'`,
      [old]
    );
    await pool.query(
      `UPDATE eventfabric.saga_scheduled_messages
          SET scheduled_at = $1::timestamptz
        WHERE id = 't-pending-old'`,
      [old]
    );
    // t-fired-fresh: status=pending, scheduled_at=now. Flip status only.
    await pool.query(
      `UPDATE eventfabric.saga_scheduled_messages SET status = 'fired' WHERE id = 't-fired-fresh'`
    );

    // Explicit ["fired","cancelled"] — the default is now "fired" only,
    // since cancelled rows are typically kept for "why didn't this fire?" triage.
    const deleted = await uow.withTransaction((tx: PgTx) =>
      timerStore.cleanupTerminal(tx, {
        olderThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        statuses: ["fired", "cancelled"],
      })
    );
    expect(deleted).toBe(2); // t-fired-old + t-cancelled-old

    const remaining = await pool.query(
      `SELECT id FROM eventfabric.saga_scheduled_messages
        WHERE instance_id = 'i-1' ORDER BY id`
    );
    expect(remaining.rows.map((r: any) => r.id).sort()).toEqual(
      ["t-fired-fresh", "t-pending-old"]
    );
  });

  it("cleanupTerminal() default keeps cancelled rows for triage; only fired is pruned", async () => {
    const timerStore = new PgSagaTimerStore();
    const uow = new PgUnitOfWork(pool);

    for (const id of ["t-fired", "t-cancelled"]) {
      await uow.withTransaction((tx: PgTx) =>
        timerStore.schedule(tx, {
          tenantId: "default", sagaName: "Counter", instanceId: "i-2",
          id, fireAt: new Date(Date.now() + 60_000),
          message: { type: "$timer", id, payload: null },
        })
      );
    }
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      `UPDATE eventfabric.saga_scheduled_messages
          SET status = 'fired', scheduled_at = $1::timestamptz WHERE id = 't-fired'`,
      [old]
    );
    await pool.query(
      `UPDATE eventfabric.saga_scheduled_messages
          SET status = 'cancelled', scheduled_at = $1::timestamptz WHERE id = 't-cancelled'`,
      [old]
    );

    const deleted = await uow.withTransaction((tx: PgTx) =>
      timerStore.cleanupTerminal(tx, {
        olderThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      })
    );
    expect(deleted).toBe(1); // only fired

    const remaining = await pool.query(
      `SELECT id, status FROM eventfabric.saga_scheduled_messages
        WHERE instance_id = 'i-2' ORDER BY id`
    );
    expect(remaining.rows).toEqual([{ id: "t-cancelled", status: "cancelled" }]);
  });
});
