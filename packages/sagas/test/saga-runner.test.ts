import { describe, it, expect } from "vitest";
import type { Transaction, EventEnvelope } from "@eventfabric/core";
import type { Command } from "@eventfabric/mediator";
import type { Saga, SagaReaction, TimerMessage } from "../src/saga";
import type { SagaObserver } from "../src/saga-observer";
import {
  applySagaTransition,
  InMemorySagaCommandQueue,
  InMemorySagaStateStore,
  InMemorySagaTimerStore,
} from "../src";

const tx = {} as Transaction;

// ---------- domain fixture: funds-transfer saga ----------
//
// Mirrors the example in proposal 0002. A single state machine that
// reacts to the transfer chain, emits a withdraw command + a timeout
// timer on start, and tears down on either deposit-completed or
// timeout-fired.

type TransferState = {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  step: "started" | "withdrawn" | "deposited";
};

type TransactionStarted = {
  type: "TransactionStarted";
  version: 1;
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
};
type WithdrawalCompleted = { type: "WithdrawalCompleted"; version: 1; transactionId: string };
type DepositCompleted = { type: "DepositCompleted"; version: 1; transactionId: string };
type Unrelated = { type: "Unrelated"; version: 1; somethingElse: string };
type BankingEvent =
  | TransactionStarted
  | WithdrawalCompleted
  | DepositCompleted
  | Unrelated;

const buildCommand = (
  type: string,
  payload: Record<string, unknown>,
  cause: string
): Command => ({
  type,
  version: 1,
  payload,
  metadata: {
    commandId: `cmd-${type}-${Math.random()}`,
    idempotencyKey: `${type}:${cause}`,
    issuedAt: new Date().toISOString(),
    causationId: cause,
    correlationId: cause,
  },
});

const fundsTransferSaga: Saga<TransferState, BankingEvent> = {
  name: "FundsTransfer",
  version: 1,

  correlate(env) {
    const e = env.payload;
    if (e.type === "TransactionStarted") return e.transactionId;
    if (e.type === "WithdrawalCompleted") return e.transactionId;
    if (e.type === "DepositCompleted") return e.transactionId;
    return null;
  },

  startsNewInstance(env) {
    return env.payload.type === "TransactionStarted";
  },

  initialState(env) {
    const e = env.payload as TransactionStarted;
    return {
      transferId: e.transactionId,
      fromAccountId: e.fromAccountId,
      toAccountId: e.toAccountId,
      amount: e.amount,
      step: "started",
    };
  },

  reactToEvent(state, env, ctx): SagaReaction<TransferState> {
    const e = env.payload;
    if (e.type === "TransactionStarted") {
      return {
        newState: state,
        commands: [
          buildCommand(
            "WithdrawFromAccount",
            { accountId: state.fromAccountId, amount: state.amount, transferId: state.transferId },
            ctx.metadata.correlationId
          ),
        ],
        schedule: [
          {
            id: "withdraw-timeout",
            fireAt: { afterMs: 30_000 },
            message: { type: "$timer", id: "withdraw-timeout", payload: {} },
          },
        ],
      };
    }
    if (e.type === "WithdrawalCompleted") {
      return {
        newState: { ...state, step: "withdrawn" },
        commands: [
          buildCommand(
            "DepositToAccount",
            { accountId: state.toAccountId, amount: state.amount, transferId: state.transferId },
            ctx.metadata.correlationId
          ),
        ],
        cancel: ["withdraw-timeout"],
      };
    }
    if (e.type === "DepositCompleted") {
      return {
        newState: { ...state, step: "deposited" },
        commands: [
          buildCommand(
            "CompleteTransaction",
            { transferId: state.transferId },
            ctx.metadata.correlationId
          ),
        ],
        end: true,
      };
    }
    return { newState: state };
  },

  reactToTimer(state, timer: TimerMessage, ctx): SagaReaction<TransferState> {
    if (timer.id === "withdraw-timeout") {
      return {
        newState: state,
        commands: [
          buildCommand(
            "FailTransaction",
            { transferId: state.transferId, reason: "Withdrawal timeout" },
            ctx.metadata.correlationId
          ),
        ],
        end: true,
      };
    }
    return { newState: state };
  },
};

let pos = 0n;
const env = (payload: BankingEvent, transferId = "t-1"): EventEnvelope<BankingEvent> => ({
  eventId: `e-${pos}`,
  tenantId: "default",
  aggregateName: "Transaction",
  aggregateId: transferId,
  aggregateVersion: 1,
  globalPosition: ++pos,
  occurredAt: new Date().toISOString(),
  payload,
});

const fixture = () => {
  pos = 0n;
  return {
    stateStore: new InMemorySagaStateStore<TransferState>(),
    commandQueue: new InMemorySagaCommandQueue(),
    timerStore: new InMemorySagaTimerStore(),
  };
};

describe("applySagaTransition — funds-transfer saga", () => {
  it("starts a new instance on TransactionStarted, emits WithdrawFromAccount command + schedules a timeout timer", async () => {
    const stores = fixture();
    const transferStarted = env({
      type: "TransactionStarted",
      version: 1,
      transactionId: "t-1",
      fromAccountId: "a-from",
      toAccountId: "a-to",
      amount: 50,
    });

    const outcome = await applySagaTransition(
      fundsTransferSaga,
      { kind: "event", envelope: transferStarted },
      { tx, tenantId: "default" },
      stores
    );

    expect(outcome.result).toBe("applied");
    if (outcome.result !== "applied") return;

    expect(outcome.instance.state.step).toBe("started");
    expect(outcome.instance.lastEventPos).toBe(transferStarted.globalPosition);
    expect(outcome.instance.stateVersion).toBe(1);

    const pending = stores.commandQueue.pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.command.type).toBe("WithdrawFromAccount");

    const timers = stores.timerStore.pendingTimers();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.id).toBe("withdraw-timeout");
  });

  it("cancels the timeout timer when WithdrawalCompleted arrives in time", async () => {
    const stores = fixture();
    const ctx = { tx, tenantId: "default" };

    await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({
          type: "TransactionStarted",
          version: 1,
          transactionId: "t-1",
          fromAccountId: "a-from",
          toAccountId: "a-to",
          amount: 50,
        }),
      },
      ctx,
      stores
    );

    expect(stores.timerStore.pendingTimers()).toHaveLength(1);

    const outcome = await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({
          type: "WithdrawalCompleted",
          version: 1,
          transactionId: "t-1",
        }),
      },
      ctx,
      stores
    );

    expect(outcome.result).toBe("applied");
    expect(stores.timerStore.pendingTimers()).toHaveLength(0);
    if (outcome.result === "applied") {
      expect(outcome.instance.state.step).toBe("withdrawn");
    }
    const pending = stores.commandQueue.pendingRows();
    // First TransactionStarted enqueued WithdrawFromAccount; this round adds DepositToAccount.
    expect(pending.map((r) => r.command.type).sort()).toEqual([
      "DepositToAccount",
      "WithdrawFromAccount",
    ]);
  });

  it("terminates the instance on DepositCompleted (status -> completed) and ignores subsequent events", async () => {
    const stores = fixture();
    const ctx = { tx, tenantId: "default" };

    for (const e of [
      env({
        type: "TransactionStarted",
        version: 1,
        transactionId: "t-1",
        fromAccountId: "a-from",
        toAccountId: "a-to",
        amount: 50,
      }),
      env({ type: "WithdrawalCompleted", version: 1, transactionId: "t-1" }),
      env({ type: "DepositCompleted", version: 1, transactionId: "t-1" }),
    ]) {
      await applySagaTransition(fundsTransferSaga, { kind: "event", envelope: e }, ctx, stores);
    }

    const [instance] = stores.stateStore.list();
    expect(instance!.status).toBe("completed");
    expect(instance!.state.step).toBe("deposited");

    const after = await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({ type: "DepositCompleted", version: 1, transactionId: "t-1" }),
      },
      ctx,
      stores
    );
    expect(after.result).toBe("skipped");
    if (after.result === "skipped") expect(after.reason).toBe("instance-terminal");
  });

  it("withdraw-timeout timer fires FailTransaction and ends the saga", async () => {
    const stores = fixture();
    const ctx = { tx, tenantId: "default" };
    await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({
          type: "TransactionStarted",
          version: 1,
          transactionId: "t-1",
          fromAccountId: "a-from",
          toAccountId: "a-to",
          amount: 50,
        }),
      },
      ctx,
      stores
    );

    const outcome = await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "timer",
        instanceId: "t-1",
        tenantId: "default",
        timer: { type: "$timer", id: "withdraw-timeout", payload: {} },
      },
      ctx,
      stores
    );

    expect(outcome.result).toBe("applied");
    if (outcome.result === "applied") {
      expect(outcome.instance.status).toBe("completed");
    }
    const failCmd = stores.commandQueue
      .pendingRows()
      .find((r) => r.command.type === "FailTransaction");
    expect(failCmd).toBeTruthy();
  });

  it("skips events with no correlate match", async () => {
    const stores = fixture();
    const outcome = await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({ type: "Unrelated", version: 1, somethingElse: "x" }),
      },
      { tx, tenantId: "default" },
      stores
    );
    expect(outcome.result).toBe("skipped");
    if (outcome.result === "skipped") expect(outcome.reason).toBe("no-correlation");
    expect(stores.stateStore.list()).toHaveLength(0);
  });

  it("skips events whose correlate matches no instance and which don't start one", async () => {
    const stores = fixture();
    const outcome = await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({ type: "WithdrawalCompleted", version: 1, transactionId: "no-such" }),
      },
      { tx, tenantId: "default" },
      stores
    );
    expect(outcome.result).toBe("skipped");
    if (outcome.result === "skipped") expect(outcome.reason).toBe("no-instance");
  });

  it("is idempotent: replaying the same event a second time is a no-op", async () => {
    const stores = fixture();
    const ctx = { tx, tenantId: "default" };
    const e = env({
      type: "TransactionStarted",
      version: 1,
      transactionId: "t-1",
      fromAccountId: "a-from",
      toAccountId: "a-to",
      amount: 50,
    });

    const first = await applySagaTransition(
      fundsTransferSaga,
      { kind: "event", envelope: e },
      ctx,
      stores
    );
    expect(first.result).toBe("applied");

    const replay = await applySagaTransition(
      fundsTransferSaga,
      { kind: "event", envelope: e },
      ctx,
      stores
    );
    expect(replay.result).toBe("skipped");
    if (replay.result === "skipped") expect(replay.reason).toBe("already-applied");

    // Commands must not double-emit on replay.
    expect(stores.commandQueue.pendingRows()).toHaveLength(1);
    expect(stores.timerStore.pendingTimers()).toHaveLength(1);
  });

  it("scopes instances by tenant — two tenants with the same transferId run independently", async () => {
    const stores = fixture();
    const e = env({
      type: "TransactionStarted",
      version: 1,
      transactionId: "t-1",
      fromAccountId: "a",
      toAccountId: "b",
      amount: 1,
    });
    await applySagaTransition(fundsTransferSaga, { kind: "event", envelope: e }, { tx, tenantId: "acme" }, stores);
    await applySagaTransition(fundsTransferSaga, { kind: "event", envelope: e }, { tx, tenantId: "contoso" }, stores);

    const all = stores.stateStore.list();
    expect(all.map((i) => i.tenantId).sort()).toEqual(["acme", "contoso"]);
  });

  it("returns 'concurrent' when the state store reports a stale stateVersion at update time", async () => {
    const stores = fixture();
    const ctx = { tx, tenantId: "default" };
    await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({
          type: "TransactionStarted",
          version: 1,
          transactionId: "t-1",
          fromAccountId: "a-from",
          toAccountId: "a-to",
          amount: 50,
        }),
      },
      ctx,
      stores
    );

    // Wrap the state store so the next `update` reports a CAS miss — the
    // realistic scenario where another worker advanced the instance
    // between our `load` and our `update`.
    const wrapped = {
      ...stores.stateStore,
      load: stores.stateStore.load.bind(stores.stateStore),
      insert: stores.stateStore.insert.bind(stores.stateStore),
      update: async () => false,
    };

    const outcome = await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({ type: "WithdrawalCompleted", version: 1, transactionId: "t-1" }),
      },
      ctx,
      { ...stores, stateStore: wrapped }
    );
    expect(outcome.result).toBe("concurrent");
  });
});

describe("applySagaTransition — observer hooks", () => {
  it("fires onInstanceStarted exactly once on the first event that creates an instance", async () => {
    const stores = fixture();
    const startedCalls: Array<{ sagaName: string; instanceId: string }> = [];
    const observer: SagaObserver = {
      onInstanceStarted: (info) =>
        startedCalls.push({ sagaName: info.sagaName, instanceId: info.instanceId }),
    };
    const ctx = { tx, tenantId: "default" };

    await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({
          type: "TransactionStarted",
          version: 1,
          transactionId: "t-1",
          fromAccountId: "a-from",
          toAccountId: "a-to",
          amount: 50,
        }),
      },
      ctx,
      stores,
      { observer }
    );

    // Second event for the same instance must not refire started.
    await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({ type: "WithdrawalCompleted", version: 1, transactionId: "t-1" }),
      },
      ctx,
      stores,
      { observer }
    );

    expect(startedCalls).toEqual([{ sagaName: "FundsTransfer", instanceId: "t-1" }]);
  });

  it("fires onInstanceCompleted with non-negative ageMs when reaction.end is true", async () => {
    const stores = fixture();
    let completedAgeMs: number | null = null;
    const observer: SagaObserver = {
      onInstanceCompleted: (info) => {
        completedAgeMs = info.ageMs;
      },
    };
    const ctx = { tx, tenantId: "default" };

    await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({
          type: "TransactionStarted",
          version: 1,
          transactionId: "t-1",
          fromAccountId: "a-from",
          toAccountId: "a-to",
          amount: 50,
        }),
      },
      ctx,
      stores,
      { observer }
    );
    expect(completedAgeMs).toBeNull(); // not done yet

    await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({ type: "WithdrawalCompleted", version: 1, transactionId: "t-1" }),
      },
      ctx,
      stores,
      { observer }
    );
    expect(completedAgeMs).toBeNull(); // still not done

    await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({ type: "DepositCompleted", version: 1, transactionId: "t-1" }),
      },
      ctx,
      stores,
      { observer }
    );
    expect(completedAgeMs).not.toBeNull();
    expect(completedAgeMs!).toBeGreaterThanOrEqual(0);
  });

  it("runReact wrapper is invoked exactly once and threads its return value", async () => {
    const stores = fixture();
    const calls: Array<{ delivery: string; trigger: string }> = [];
    const observer: SagaObserver = {
      runReact: async (react, info) => {
        calls.push({ delivery: info.delivery, trigger: info.trigger });
        return react();
      },
    };

    await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({
          type: "TransactionStarted",
          version: 1,
          transactionId: "t-1",
          fromAccountId: "a-from",
          toAccountId: "a-to",
          amount: 50,
        }),
      },
      { tx, tenantId: "default" },
      stores,
      { observer }
    );

    expect(calls).toEqual([{ delivery: "event", trigger: "TransactionStarted" }]);
  });

  it("a thrown observer hook does not break the transition (errors are swallowed)", async () => {
    const stores = fixture();
    const observer: SagaObserver = {
      onInstanceStarted: () => {
        throw new Error("observer bug");
      },
    };

    const outcome = await applySagaTransition(
      fundsTransferSaga,
      {
        kind: "event",
        envelope: env({
          type: "TransactionStarted",
          version: 1,
          transactionId: "t-1",
          fromAccountId: "a-from",
          toAccountId: "a-to",
          amount: 50,
        }),
      },
      { tx, tenantId: "default" },
      stores,
      { observer }
    );

    expect(outcome.result).toBe("applied");
  });
});

describe("applySagaTransition — SagaStateUpcaster", () => {
  // v1 state shape: { from, to, amount, step }
  // v2 state shape: { fromAccountId, toAccountId, amount, step }
  //                 (renamed `from` → `fromAccountId`, `to` → `toAccountId`)

  type TransferStateV2 = {
    fromAccountId: string;
    toAccountId: string;
    amount: number;
    step: "started" | "withdrawn";
  };

  const v2Saga: Saga<TransferStateV2, BankingEvent> = {
    name: "FundsTransferV2",
    version: 2,
    upcaster(rawState, fromVersion) {
      if (fromVersion === 1) {
        const v1 = rawState as { from: string; to: string; amount: number; step: "started" | "withdrawn" };
        return {
          fromAccountId: v1.from,
          toAccountId: v1.to,
          amount: v1.amount,
          step: v1.step,
        };
      }
      // Already at v2.
      return rawState as TransferStateV2;
    },
    correlate(env) {
      const e = env.payload;
      if (e.type === "WithdrawalCompleted" || e.type === "DepositCompleted") return e.transactionId;
      return null;
    },
    startsNewInstance: () => false,
    initialState: () => {
      throw new Error("not used in this test");
    },
    reactToEvent(state, env) {
      const e = env.payload;
      if (e.type === "WithdrawalCompleted") {
        return { newState: { ...state, step: "withdrawn" } };
      }
      return { newState: state };
    },
  };

  it("upcasts v1 state to v2 shape on load, then the reaction sees v2", async () => {
    const stateStore = new InMemorySagaStateStore<TransferStateV2>();
    // Seed a v1-shaped instance directly. The type assertion mirrors what
    // would land if you loaded a row written by a saga at v1 before the bump.
    await stateStore.insert(tx, {
      sagaName: "FundsTransferV2",
      instanceId: "t-1",
      tenantId: "default",
      state: { from: "a-from", to: "a-to", amount: 50, step: "started" } as unknown as TransferStateV2,
      stateVersion: 1,
      status: "active",
      schemaVersion: 1,        // ← persisted under the old version
      lastEventPos: 1n,
      createdAt: "2026-04-29T00:00:00Z",
      updatedAt: "2026-04-29T00:00:00Z",
    });

    let sawInReactor: TransferStateV2 | null = null;
    const sagaWithSpy: Saga<TransferStateV2, BankingEvent> = {
      ...v2Saga,
      reactToEvent(state, env) {
        sawInReactor = state;
        return v2Saga.reactToEvent(state, env, { metadata: { correlationId: "", instanceId: "", tenantId: "" } });
      },
    };

    pos = 50n; // ensure globalPosition > lastEventPos so the event isn't skipped
    await applySagaTransition(
      sagaWithSpy,
      {
        kind: "event",
        envelope: env({ type: "WithdrawalCompleted", version: 1, transactionId: "t-1" }),
      },
      { tx, tenantId: "default" },
      {
        stateStore,
        commandQueue: new InMemorySagaCommandQueue(),
        timerStore: new InMemorySagaTimerStore(),
      }
    );

    // Reactor saw the upcast shape, not the v1 shape.
    expect(sawInReactor).toEqual({
      fromAccountId: "a-from",
      toAccountId: "a-to",
      amount: 50,
      step: "started",
    });
  });

  it("persists schemaVersion=2 after the upcasted reaction commits", async () => {
    const stateStore = new InMemorySagaStateStore<TransferStateV2>();
    await stateStore.insert(tx, {
      sagaName: "FundsTransferV2",
      instanceId: "t-2",
      tenantId: "default",
      state: { from: "a-from", to: "a-to", amount: 50, step: "started" } as unknown as TransferStateV2,
      stateVersion: 1,
      status: "active",
      schemaVersion: 1,
      lastEventPos: 1n,
      createdAt: "2026-04-29T00:00:00Z",
      updatedAt: "2026-04-29T00:00:00Z",
    });

    pos = 60n;
    await applySagaTransition(
      v2Saga,
      {
        kind: "event",
        envelope: env({ type: "WithdrawalCompleted", version: 1, transactionId: "t-2" }),
      },
      { tx, tenantId: "default" },
      {
        stateStore,
        commandQueue: new InMemorySagaCommandQueue(),
        timerStore: new InMemorySagaTimerStore(),
      }
    );

    const loaded = await stateStore.load(tx, {
      sagaName: "FundsTransferV2",
      instanceId: "t-2",
      tenantId: "default",
    });
    expect(loaded!.schemaVersion).toBe(2);
    // And the persisted state is in v2 shape with the reaction's transition applied.
    expect(loaded!.state).toEqual({
      fromAccountId: "a-from",
      toAccountId: "a-to",
      amount: 50,
      step: "withdrawn",
    });
  });

  it("propagates upcaster errors so the transition is rolled back rather than corrupting state", async () => {
    const stateStore = new InMemorySagaStateStore<TransferStateV2>();
    await stateStore.insert(tx, {
      sagaName: "FundsTransferV2",
      instanceId: "t-err",
      tenantId: "default",
      state: { from: "a-from", to: "a-to", amount: 50, step: "started" } as unknown as TransferStateV2,
      stateVersion: 1,
      status: "active",
      schemaVersion: 1,
      lastEventPos: 1n,
      createdAt: "2026-04-29T00:00:00Z",
      updatedAt: "2026-04-29T00:00:00Z",
    });

    const throwingSaga: Saga<TransferStateV2, BankingEvent> = {
      ...v2Saga,
      upcaster() {
        throw new Error("upcaster bug: cannot decode v1 state");
      },
    };

    pos = 80n;
    await expect(
      applySagaTransition(
        throwingSaga,
        {
          kind: "event",
          envelope: env({ type: "WithdrawalCompleted", version: 1, transactionId: "t-err" }),
        },
        { tx, tenantId: "default" },
        {
          stateStore,
          commandQueue: new InMemorySagaCommandQueue(),
          timerStore: new InMemorySagaTimerStore(),
        }
      )
    ).rejects.toThrow("upcaster bug");

    // The persisted instance must be untouched — still at v1 shape, version 1.
    // (The reaction never ran, so nothing should have been written.)
    const loaded = await stateStore.load(tx, {
      sagaName: "FundsTransferV2",
      instanceId: "t-err",
      tenantId: "default",
    });
    expect(loaded!.schemaVersion).toBe(1);
    expect(loaded!.stateVersion).toBe(1);
    expect(loaded!.state).toEqual({ from: "a-from", to: "a-to", amount: 50, step: "started" });
  });

  it("does not invoke the upcaster when schemaVersion already equals saga.version", async () => {
    const stateStore = new InMemorySagaStateStore<TransferStateV2>();
    let upcasterCalls = 0;
    const sagaWithCountedUpcaster: Saga<TransferStateV2, BankingEvent> = {
      ...v2Saga,
      upcaster(rawState, fromVersion) {
        upcasterCalls++;
        return v2Saga.upcaster!(rawState, fromVersion);
      },
    };

    await stateStore.insert(tx, {
      sagaName: "FundsTransferV2",
      instanceId: "t-3",
      tenantId: "default",
      state: { fromAccountId: "a-from", toAccountId: "a-to", amount: 50, step: "started" },
      stateVersion: 1,
      status: "active",
      schemaVersion: 2,        // ← already current
      lastEventPos: 1n,
      createdAt: "2026-04-29T00:00:00Z",
      updatedAt: "2026-04-29T00:00:00Z",
    });

    pos = 70n;
    await applySagaTransition(
      sagaWithCountedUpcaster,
      {
        kind: "event",
        envelope: env({ type: "WithdrawalCompleted", version: 1, transactionId: "t-3" }),
      },
      { tx, tenantId: "default" },
      {
        stateStore,
        commandQueue: new InMemorySagaCommandQueue(),
        timerStore: new InMemorySagaTimerStore(),
      }
    );

    expect(upcasterCalls).toBe(0);
  });
});
