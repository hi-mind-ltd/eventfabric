import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import type { EventEnvelope } from "@eventfabric/core";
import {
  applySagaTransition,
  InMemorySagaCommandQueue,
  InMemorySagaTimerStore,
  sagaAsAsyncProjection,
  type Saga,
  type SagaReaction,
} from "@eventfabric/sagas";
import { PgSagaStateStore, sagasMigrations } from "../src";
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
  await pool.query(`DELETE FROM eventfabric.saga_instances`);
});

// --- minimal saga fixture: counts events by aggregateId ---

type CounterState = { count: number };
type Tick = { type: "Tick"; version: 1; counterId: string };

const counterSaga: Saga<CounterState, Tick> = {
  name: "Counter",
  version: 1,
  correlate: (env) => env.payload.counterId,
  startsNewInstance: () => true,
  initialState: () => ({ count: 0 }),
  reactToEvent(state, _env, _ctx): SagaReaction<CounterState> {
    return { newState: { count: state.count + 1 } };
  },
};

let pos = 0n;
const env = (counterId: string, tenantId = "default"): EventEnvelope<Tick> => ({
  eventId: `e-${pos++}`,
  tenantId,
  aggregateName: "Counter",
  aggregateId: counterId,
  aggregateVersion: 1,
  globalPosition: pos,
  occurredAt: new Date().toISOString(),
  payload: { type: "Tick", version: 1, counterId },
});

describe("PgSagaStateStore + sagaAsAsyncProjection", () => {
  it("inserts a fresh row on first event and updates state_version atomically on subsequent events", async () => {
    const stateStore = new PgSagaStateStore<CounterState>();
    const stores = {
      stateStore,
      commandQueue: new InMemorySagaCommandQueue(),
      timerStore: new InMemorySagaTimerStore(),
    };
    const projection = sagaAsAsyncProjection(counterSaga, stores);
    const uow = new PgUnitOfWork(pool);

    pos = 0n;
    for (let i = 0; i < 3; i++) {
      await uow.withTransaction((tx: PgTx) => projection.handle(tx, env("c-1")));
    }

    const loaded = await uow.withTransaction((tx: PgTx) =>
      stateStore.load(tx, { sagaName: "Counter", instanceId: "c-1", tenantId: "default" })
    );
    expect(loaded).not.toBeNull();
    expect(loaded!.state.count).toBe(3);
    // stateVersion advances once per applied transition: insert(0) → 1 → 2 → 3.
    expect(loaded!.stateVersion).toBe(3);
    expect(loaded!.lastEventPos).toBe(3n);
  });

  it("idempotent on event replay — re-handing the same envelope does not double-count", async () => {
    const stateStore = new PgSagaStateStore<CounterState>();
    const stores = {
      stateStore,
      commandQueue: new InMemorySagaCommandQueue(),
      timerStore: new InMemorySagaTimerStore(),
    };
    const projection = sagaAsAsyncProjection(counterSaga, stores);
    const uow = new PgUnitOfWork(pool);

    pos = 100n;
    const e = env("c-replay");
    await uow.withTransaction((tx: PgTx) => projection.handle(tx, e));
    await uow.withTransaction((tx: PgTx) => projection.handle(tx, e));
    await uow.withTransaction((tx: PgTx) => projection.handle(tx, e));

    const loaded = await uow.withTransaction((tx: PgTx) =>
      stateStore.load(tx, { sagaName: "Counter", instanceId: "c-replay", tenantId: "default" })
    );
    expect(loaded!.state.count).toBe(1);
  });

  it("scopes instances per tenant — same counterId in two tenants are independent", async () => {
    const stateStore = new PgSagaStateStore<CounterState>();
    const stores = {
      stateStore,
      commandQueue: new InMemorySagaCommandQueue(),
      timerStore: new InMemorySagaTimerStore(),
    };
    const projection = sagaAsAsyncProjection(counterSaga, stores);

    pos = 200n;
    const acme = new PgUnitOfWork(pool, "acme");
    const contoso = new PgUnitOfWork(pool, "contoso");
    await acme.withTransaction((tx: PgTx) => projection.handle(tx, env("c-1", "acme")));
    await acme.withTransaction((tx: PgTx) => projection.handle(tx, env("c-1", "acme")));
    await contoso.withTransaction((tx: PgTx) => projection.handle(tx, env("c-1", "contoso")));

    const a = await acme.withTransaction((tx: PgTx) =>
      stateStore.load(tx, { sagaName: "Counter", instanceId: "c-1", tenantId: "acme" })
    );
    const c = await contoso.withTransaction((tx: PgTx) =>
      stateStore.load(tx, { sagaName: "Counter", instanceId: "c-1", tenantId: "contoso" })
    );
    expect(a!.state.count).toBe(2);
    expect(c!.state.count).toBe(1);
  });

  it("CAS rejects an update with a stale stateVersion (returns false)", async () => {
    const stateStore = new PgSagaStateStore<CounterState>();
    const uow = new PgUnitOfWork(pool);
    const now = new Date().toISOString();
    await uow.withTransaction((tx: PgTx) =>
      stateStore.insert(tx, {
        tenantId: "default",
        sagaName: "Counter",
        instanceId: "cas-1",
        state: { count: 0 },
        stateVersion: 0,
        status: "active",
        schemaVersion: 1,
        lastEventPos: null,
        createdAt: now,
        updatedAt: now,
      })
    );
    // First update succeeds.
    const ok = await uow.withTransaction((tx: PgTx) =>
      stateStore.update(tx,
        {
          tenantId: "default",
          sagaName: "Counter",
          instanceId: "cas-1",
          state: { count: 1 },
          stateVersion: 1,
          status: "active",
          schemaVersion: 1,
          lastEventPos: 1n,
          createdAt: now,
          updatedAt: now,
        },
        0
      )
    );
    expect(ok).toBe(true);

    // Second update at the wrong expectedVersion fails.
    const stale = await uow.withTransaction((tx: PgTx) =>
      stateStore.update(tx,
        {
          tenantId: "default",
          sagaName: "Counter",
          instanceId: "cas-1",
          state: { count: 99 },
          stateVersion: 99,
          status: "active",
          schemaVersion: 1,
          lastEventPos: 99n,
          createdAt: now,
          updatedAt: now,
        },
        0
      )
    );
    expect(stale).toBe(false);
  });

  it("listActive returns only active instances for the requested saga + tenant", async () => {
    const stateStore = new PgSagaStateStore<CounterState>();
    const uow = new PgUnitOfWork(pool);
    const stores = {
      stateStore,
      commandQueue: new InMemorySagaCommandQueue(),
      timerStore: new InMemorySagaTimerStore(),
    };
    const projection = sagaAsAsyncProjection(counterSaga, stores);

    pos = 500n;
    await uow.withTransaction((tx: PgTx) => projection.handle(tx, env("a")));
    await uow.withTransaction((tx: PgTx) => projection.handle(tx, env("b")));

    // Manually flip "a" to completed.
    await pool.query(
      `UPDATE eventfabric.saga_instances SET status = 'completed' WHERE instance_id = 'a'`
    );

    const active = await uow.withTransaction((tx: PgTx) =>
      stateStore.listActive(tx, { sagaName: "Counter", tenantId: "default" })
    );
    expect(active.map((i) => i.instanceId)).toEqual(["b"]);
  });

  it("the asAsyncProjection wrapper throws ConcurrencyError when state CAS misses", async () => {
    // Drive the saga to a known state, then handle an event with a wrapped
    // store whose `update` always returns false to simulate the CAS miss.
    const stateStore = new PgSagaStateStore<CounterState>();
    const uow = new PgUnitOfWork(pool);
    pos = 600n;

    // Seed an instance via direct apply (no concurrency simulation yet).
    const stores = {
      stateStore,
      commandQueue: new InMemorySagaCommandQueue(),
      timerStore: new InMemorySagaTimerStore(),
    };
    await uow.withTransaction((tx: PgTx) =>
      applySagaTransition(
        counterSaga,
        { kind: "event", envelope: env("conc-1") },
        { tx, tenantId: "default" },
        stores
      )
    );

    // Now wrap the state store to force CAS misses.
    const stuntStore = {
      load: stateStore.load.bind(stateStore),
      insert: stateStore.insert.bind(stateStore),
      update: async () => false,
    };
    const projection = sagaAsAsyncProjection(counterSaga, {
      ...stores,
      stateStore: stuntStore,
    });

    await expect(
      uow.withTransaction((tx: PgTx) => projection.handle(tx, env("conc-1")))
    ).rejects.toMatchObject({ name: "ConcurrencyError" });
  });

  it("cleanupTerminal() deletes completed + failed instances past the cutoff and leaves active ones alone", async () => {
    const stateStore = new PgSagaStateStore<CounterState>();
    const uow = new PgUnitOfWork(pool);
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago

    await uow.withTransaction((tx: PgTx) =>
      Promise.all([
        stateStore.insert(tx, {
          tenantId: "default", sagaName: "Counter", instanceId: "old-completed",
          state: { count: 1 }, stateVersion: 1, status: "completed",
          schemaVersion: 1, lastEventPos: 1n, createdAt: old, updatedAt: old,
        }),
        stateStore.insert(tx, {
          tenantId: "default", sagaName: "Counter", instanceId: "old-failed",
          state: { count: 1 }, stateVersion: 1, status: "failed",
          schemaVersion: 1, lastEventPos: 1n, createdAt: old, updatedAt: old,
        }),
        stateStore.insert(tx, {
          tenantId: "default", sagaName: "Counter", instanceId: "old-active",
          state: { count: 1 }, stateVersion: 1, status: "active",
          schemaVersion: 1, lastEventPos: 1n, createdAt: old, updatedAt: old,
        }),
        stateStore.insert(tx, {
          tenantId: "default", sagaName: "Counter", instanceId: "fresh-completed",
          state: { count: 1 }, stateVersion: 1, status: "completed",
          schemaVersion: 1, lastEventPos: 1n, createdAt: now, updatedAt: now,
        }),
      ])
    );

    const deleted = await uow.withTransaction((tx: PgTx) =>
      stateStore.cleanupTerminal(tx, {
        olderThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days
      })
    );
    expect(deleted).toBe(2); // old-completed + old-failed

    const remaining = await pool.query(
      `SELECT instance_id, status FROM eventfabric.saga_instances ORDER BY instance_id`
    );
    expect(remaining.rows.map((r: any) => r.instance_id).sort()).toEqual([
      "fresh-completed", "old-active",
    ]);
  });

  it("cleanupTerminal() respects the statuses filter when given", async () => {
    const stateStore = new PgSagaStateStore<CounterState>();
    const uow = new PgUnitOfWork(pool);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    await uow.withTransaction((tx: PgTx) =>
      Promise.all([
        stateStore.insert(tx, {
          tenantId: "default", sagaName: "Counter", instanceId: "completed-only",
          state: { count: 1 }, stateVersion: 1, status: "completed",
          schemaVersion: 1, lastEventPos: 1n, createdAt: old, updatedAt: old,
        }),
        stateStore.insert(tx, {
          tenantId: "default", sagaName: "Counter", instanceId: "failed-keep",
          state: { count: 1 }, stateVersion: 1, status: "failed",
          schemaVersion: 1, lastEventPos: 1n, createdAt: old, updatedAt: old,
        }),
      ])
    );

    const deleted = await uow.withTransaction((tx: PgTx) =>
      stateStore.cleanupTerminal(tx, {
        olderThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        statuses: ["completed"], // only completed; keep failed for triage
      })
    );
    expect(deleted).toBe(1);

    const remaining = await pool.query(
      `SELECT instance_id FROM eventfabric.saga_instances ORDER BY instance_id`
    );
    expect(remaining.rows.map((r: any) => r.instance_id)).toEqual(["failed-keep"]);
  });

  it("reactivate() flips a failed instance back to active and bumps stateVersion", async () => {
    const stateStore = new PgSagaStateStore<CounterState>();
    const uow = new PgUnitOfWork(pool);
    const now = new Date().toISOString();

    await uow.withTransaction((tx: PgTx) =>
      stateStore.insert(tx, {
        sagaName: "Counter",
        instanceId: "i-reactivate",
        tenantId: "default",
        state: { count: 7 },
        stateVersion: 3,
        status: "failed",
        schemaVersion: 1,
        lastEventPos: 10n,
        createdAt: now,
        updatedAt: now,
      })
    );

    const ok = await uow.withTransaction((tx: PgTx) =>
      stateStore.reactivate(tx, {
        sagaName: "Counter",
        instanceId: "i-reactivate",
        tenantId: "default",
      })
    );
    expect(ok).toBe(true);

    const reloaded = await uow.withTransaction((tx: PgTx) =>
      stateStore.load(tx, {
        sagaName: "Counter",
        instanceId: "i-reactivate",
        tenantId: "default",
      })
    );
    expect(reloaded!.status).toBe("active");
    expect(reloaded!.stateVersion).toBe(4);
    // State itself is preserved — operator edits separately if needed.
    expect(reloaded!.state).toEqual({ count: 7 });
  });

  it("reactivate() returns false when the instance is missing or not failed", async () => {
    const stateStore = new PgSagaStateStore<CounterState>();
    const uow = new PgUnitOfWork(pool);

    // Missing.
    const missing = await uow.withTransaction((tx: PgTx) =>
      stateStore.reactivate(tx, {
        sagaName: "Counter",
        instanceId: "does-not-exist",
        tenantId: "default",
      })
    );
    expect(missing).toBe(false);

    // Active — not eligible for reactivation.
    const now = new Date().toISOString();
    await uow.withTransaction((tx: PgTx) =>
      stateStore.insert(tx, {
        sagaName: "Counter",
        instanceId: "i-active",
        tenantId: "default",
        state: { count: 0 },
        stateVersion: 0,
        status: "active",
        schemaVersion: 1,
        lastEventPos: null,
        createdAt: now,
        updatedAt: now,
      })
    );
    const notFailed = await uow.withTransaction((tx: PgTx) =>
      stateStore.reactivate(tx, {
        sagaName: "Counter",
        instanceId: "i-active",
        tenantId: "default",
      })
    );
    expect(notFailed).toBe(false);
  });
});
