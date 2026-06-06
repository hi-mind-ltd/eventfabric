import { describe, it, expect } from "vitest";
import type { Transaction, UnitOfWork } from "@eventfabric/core";
import {
  InMemorySagaCommandQueue,
  InMemorySagaStateStore,
  InMemorySagaTimerStore,
  SagaTimerScheduler,
  type Saga,
  type SagaObserver,
  type SagaReaction,
  type SagaTimerHandler,
  type TimerMessage,
} from "../src";

const tx = {} as Transaction;

class NoOpUow implements UnitOfWork<Transaction> {
  async withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return fn({});
  }
}

type CounterState = { fired: number };
const counterSaga: Saga<CounterState, never> = {
  name: "Counter",
  version: 1,
  correlate: () => null,
  startsNewInstance: () => false,
  initialState: () => ({ fired: 0 }),
  reactToEvent: (state) => ({ newState: state }),
  reactToTimer(state, timer: TimerMessage): SagaReaction<CounterState> {
    if (timer.id === "end") {
      return { newState: { fired: state.fired + 1 }, end: true };
    }
    return { newState: { fired: state.fired + 1 } };
  },
};

const seedInstance = async (
  stateStore: InMemorySagaStateStore<CounterState>,
  instanceId: string,
  tenantId: string = "default"
) => {
  await stateStore.insert(tx, {
    sagaName: "Counter",
    instanceId,
    tenantId,
    state: { fired: 0 },
    stateVersion: 0,
    status: "active",
    schemaVersion: 1,
    lastEventPos: null,
    createdAt: "2026-04-29T00:00:00Z",
    updatedAt: "2026-04-29T00:00:00Z",
  });
};

const buildHandlers = () => {
  const stateStore = new InMemorySagaStateStore<CounterState>();
  const commandQueue = new InMemorySagaCommandQueue();
  const timerStore = new InMemorySagaTimerStore();
  const handlers = new Map<string, SagaTimerHandler<Transaction>>([
    [
      "Counter",
      {
        saga: counterSaga as Saga<any, any>,
        stores: { stateStore, commandQueue, timerStore },
      },
    ],
  ]);
  return { stateStore, commandQueue, timerStore, handlers };
};

describe("SagaTimerScheduler", () => {
  it("delivers due timers to reactToTimer and marks them fired", async () => {
    const { stateStore, timerStore, handlers } = buildHandlers();
    await seedInstance(stateStore, "i-1");

    await timerStore.schedule(tx, {
      tenantId: "default",
      sagaName: "Counter",
      instanceId: "i-1",
      id: "tick",
      fireAt: new Date(Date.now() - 1000),
      message: { type: "$timer", id: "tick", payload: null },
    });

    const scheduler = new SagaTimerScheduler(new NoOpUow(), timerStore, handlers);
    const round = await scheduler.runOnce();
    expect(round).toEqual({ claimed: 1, fired: 1, released: 0, orphaned: 0 });

    const inst = await stateStore.load(tx, {
      sagaName: "Counter",
      instanceId: "i-1",
      tenantId: "default",
    });
    expect(inst!.state.fired).toBe(1);
    expect(timerStore.pendingTimers()).toHaveLength(0);
  });

  it("does not fire timers whose fire_at is in the future", async () => {
    const { stateStore, timerStore, handlers } = buildHandlers();
    await seedInstance(stateStore, "i-1");

    await timerStore.schedule(tx, {
      tenantId: "default",
      sagaName: "Counter",
      instanceId: "i-1",
      id: "tick",
      fireAt: new Date(Date.now() + 60_000),
      message: { type: "$timer", id: "tick", payload: null },
    });

    const scheduler = new SagaTimerScheduler(new NoOpUow(), timerStore, handlers);
    const round = await scheduler.runOnce();
    expect(round).toEqual({ claimed: 0, fired: 0, released: 0, orphaned: 0 });
  });

  it("handles end:true reactions by terminating the saga and not running again", async () => {
    const { stateStore, timerStore, handlers } = buildHandlers();
    await seedInstance(stateStore, "i-1");

    await timerStore.schedule(tx, {
      tenantId: "default",
      sagaName: "Counter",
      instanceId: "i-1",
      id: "end",
      fireAt: new Date(Date.now() - 1000),
      message: { type: "$timer", id: "end", payload: null },
    });

    const scheduler = new SagaTimerScheduler(new NoOpUow(), timerStore, handlers);
    await scheduler.runOnce();

    const inst = await stateStore.load(tx, {
      sagaName: "Counter",
      instanceId: "i-1",
      tenantId: "default",
    });
    expect(inst!.status).toBe("completed");
  });

  it("counts orphans (no saga registered for the row's sagaName) and marks them fired so they don't loop", async () => {
    const { timerStore, handlers } = buildHandlers();
    await timerStore.schedule(tx, {
      tenantId: "default",
      sagaName: "Unregistered",
      instanceId: "i-1",
      id: "tick",
      fireAt: new Date(Date.now() - 1000),
      message: { type: "$timer", id: "tick", payload: null },
    });

    const scheduler = new SagaTimerScheduler(new NoOpUow(), timerStore, handlers);
    const round = await scheduler.runOnce();
    expect(round).toMatchObject({ orphaned: 1, fired: 0 });

    const round2 = await scheduler.runOnce();
    expect(round2.claimed).toBe(0);
  });

  it("releases the timer back to pending when the saga state CAS misses", async () => {
    const { stateStore, commandQueue, timerStore } = buildHandlers();
    await seedInstance(stateStore, "i-1");

    await timerStore.schedule(tx, {
      tenantId: "default",
      sagaName: "Counter",
      instanceId: "i-1",
      id: "tick",
      fireAt: new Date(Date.now() - 1000),
      message: { type: "$timer", id: "tick", payload: null },
    });

    // Wrap the state store to force CAS failure on update.
    const wrapped = {
      ...stateStore,
      load: stateStore.load.bind(stateStore),
      insert: stateStore.insert.bind(stateStore),
      update: async () => false,
    };

    const handlersWithStuntStore = new Map<string, SagaTimerHandler<Transaction>>([
      [
        "Counter",
        {
          saga: counterSaga as Saga<any, any>,
          stores: { stateStore: wrapped, commandQueue, timerStore },
        },
      ],
    ]);

    const scheduler = new SagaTimerScheduler(new NoOpUow(), timerStore, handlersWithStuntStore);
    const round = await scheduler.runOnce();
    expect(round).toMatchObject({ released: 1, fired: 0 });
    // Released → row is back to pending, claimable on next round.
    expect(timerStore.pendingTimers()).toHaveLength(1);
  });

  it("loop respects stop()", async () => {
    const { handlers, timerStore } = buildHandlers();
    const scheduler = new SagaTimerScheduler(new NoOpUow(), timerStore, handlers, {
      idleSleepMs: 5,
    });
    const startPromise = scheduler.start();
    await new Promise((r) => setTimeout(r, 30));
    await scheduler.stop();
    await startPromise;
  });

  it("emits onTimerFired for delivered timers and onTimerOrphaned for unregistered sagas", async () => {
    const { stateStore, timerStore, handlers } = buildHandlers();
    await seedInstance(stateStore, "i-1");

    await timerStore.schedule(tx, {
      tenantId: "default",
      sagaName: "Counter",
      instanceId: "i-1",
      id: "tick",
      fireAt: new Date(Date.now() - 1000),
      message: { type: "$timer", id: "tick", payload: null },
    });
    await timerStore.schedule(tx, {
      tenantId: "default",
      sagaName: "Unregistered",
      instanceId: "i-x",
      id: "ghost",
      fireAt: new Date(Date.now() - 1000),
      message: { type: "$timer", id: "ghost", payload: null },
    });

    const fired: string[] = [];
    const orphaned: string[] = [];
    const observer: SagaObserver = {
      onTimerFired: (info) => fired.push(info.timerId),
      onTimerOrphaned: (info) => orphaned.push(info.timerId),
    };

    const scheduler = new SagaTimerScheduler(new NoOpUow(), timerStore, handlers, {
      observer,
    });
    await scheduler.runOnce();

    expect(fired).toEqual(["tick"]);
    expect(orphaned).toEqual(["ghost"]);
  });

  it("narrows the UoW per item via forTenant before running the saga reaction", async () => {
    // A tenant-aware UoW that records which tenant each opened tx ran for.
    // Mirrors the PgUnitOfWork.forTenant pattern.
    class TenantAwareUow implements UnitOfWork<Transaction> {
      public readonly tenantId: string;
      public readonly opens: string[] = [];
      constructor(tenantId: string = "default") {
        this.tenantId = tenantId;
      }
      async withTransaction<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
        this.opens.push(this.tenantId);
        return fn(tx);
      }
      forTenant(tenantId: string): UnitOfWork<Transaction> {
        if (tenantId === this.tenantId) return this;
        // Share the shared `opens` array so the test can see every open
        // regardless of which scoped instance handled it.
        const child = new TenantAwareUow(tenantId);
        (child as TenantAwareUow & { opens: string[] }).opens = this.opens;
        return child;
      }
    }

    const { stateStore, timerStore, handlers } = buildHandlers();
    await seedInstance(stateStore, "i-acme", "acme");
    await seedInstance(stateStore, "i-contoso", "contoso");

    await timerStore.schedule(tx, {
      tenantId: "acme",
      sagaName: "Counter",
      instanceId: "i-acme",
      id: "tick",
      fireAt: new Date(Date.now() - 1000),
      message: { type: "$timer", id: "tick", payload: null },
    });
    await timerStore.schedule(tx, {
      tenantId: "contoso",
      sagaName: "Counter",
      instanceId: "i-contoso",
      id: "tick",
      fireAt: new Date(Date.now() - 1000),
      message: { type: "$timer", id: "tick", payload: null },
    });

    const uow = new TenantAwareUow("default");
    const scheduler = new SagaTimerScheduler(uow, timerStore, handlers);
    const round = await scheduler.runOnce();
    expect(round).toMatchObject({ claimed: 2, fired: 2 });

    // First open is the initial claimDue (under "default"); subsequent
    // opens are the per-item transitions, which must run narrowed to
    // each item's tenant.
    expect(uow.opens[0]).toBe("default");
    expect(uow.opens.slice(1).sort()).toEqual(["acme", "contoso"]);
  });
});
