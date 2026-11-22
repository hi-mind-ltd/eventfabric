import { describe, it, expect } from "vitest";
import type { Transaction, EventEnvelope } from "@eventfabric/core";
import type { Saga, SagaReaction } from "../src/saga";
import {
  applySagaTransition,
  sagaAsProjection,
  InMemorySagaCommandQueue,
  InMemorySagaStateStore,
  InMemorySagaTimerStore,
} from "../src";

const tx = {} as Transaction;

type CounterState = { seen: string[] };
type Tick = { type: "Tick"; version: 1; counterId: string; label: string };

const counterSaga: Saga<CounterState, Tick> = {
  name: "Counter",
  version: 1,
  correlate: (env) => env.payload.counterId,
  startsNewInstance: () => true,
  initialState: () => ({ seen: [] }),
  reactToEvent(state, env): SagaReaction<CounterState> {
    return { newState: { seen: [...state.seen, env.payload.label] } };
  },
};

const tick = (globalPosition: bigint, label: string, counterId = "c-1"): EventEnvelope<Tick> => ({
  eventId: `e-${globalPosition}`,
  tenantId: "default",
  aggregateName: "Counter",
  aggregateId: counterId,
  aggregateVersion: 1,
  globalPosition,
  occurredAt: new Date().toISOString(),
  payload: { type: "Tick", version: 1, counterId, label },
});

const stores = () => ({
  stateStore: new InMemorySagaStateStore<CounterState>(),
  commandQueue: new InMemorySagaCommandQueue(),
  timerStore: new InMemorySagaTimerStore(),
});

const load = (s: ReturnType<typeof stores>) =>
  s.stateStore.load(tx, { sagaName: "Counter", instanceId: "c-1", tenantId: "default" });

describe("applySagaTransition — replay of a dead-lettered event", () => {
  it("skips an older event normally, but applies it with replay: true", async () => {
    const s = stores();
    const ctx = { tx, tenantId: "default" };
    await applySagaTransition(counterSaga, { kind: "event", envelope: tick(1n, "first") }, ctx, s);
    await applySagaTransition(counterSaga, { kind: "event", envelope: tick(5n, "later") }, ctx, s);

    // Event 3 failed earlier and was dead-lettered; the instance moved past it.
    const normal = await applySagaTransition(counterSaga, { kind: "event", envelope: tick(3n, "failed-earlier") }, ctx, s);
    expect(normal).toEqual({ result: "skipped", reason: "already-applied" });

    const replayed = await applySagaTransition(
      counterSaga,
      { kind: "event", envelope: tick(3n, "failed-earlier") },
      ctx,
      s,
      { replay: true }
    );
    expect(replayed.result).toBe("applied");
    expect((await load(s))!.state.seen).toEqual(["first", "later", "failed-earlier"]);
  });

  it("never moves lastEventPos backwards", async () => {
    const s = stores();
    const ctx = { tx, tenantId: "default" };
    await applySagaTransition(counterSaga, { kind: "event", envelope: tick(5n, "later") }, ctx, s);
    await applySagaTransition(counterSaga, { kind: "event", envelope: tick(3n, "old") }, ctx, s, { replay: true });
    expect((await load(s))!.lastEventPos).toBe(5n);

    // So event 4, if redelivered, is still treated as applied... and event 6 is new.
    const four = await applySagaTransition(counterSaga, { kind: "event", envelope: tick(4n, "x") }, ctx, s);
    expect(four.result).toBe("skipped");
    const six = await applySagaTransition(counterSaga, { kind: "event", envelope: tick(6n, "next") }, ctx, s);
    expect(six.result).toBe("applied");
    expect((await load(s))!.lastEventPos).toBe(6n);
  });
});

describe("sagaAsProjection", () => {
  it("defaults the projection name to saga:<name>, and accepts an override", () => {
    expect(sagaAsProjection(counterSaga, stores()).name).toBe("saga:Counter");
    expect(sagaAsProjection(counterSaga, stores(), { projectionName: "custom" }).name).toBe("custom");
  });

  it("applies events in order and skips duplicates", async () => {
    const s = stores();
    const p = sagaAsProjection(counterSaga, s);
    await p.handle(tx, tick(1n, "a"));
    await p.handle(tx, tick(2n, "b"));
    await p.handle(tx, tick(2n, "b")); // redelivered batch
    expect((await load(s))!.state.seen).toEqual(["a", "b"]);
  });

  it("forwards ctx.replay so a dead-letter replay is applied out of order", async () => {
    const s = stores();
    const p = sagaAsProjection(counterSaga, s);
    await p.handle(tx, tick(1n, "a"));
    await p.handle(tx, tick(3n, "c"));
    await p.handle(tx, tick(2n, "b"), { replay: false });
    expect((await load(s))!.state.seen).toEqual(["a", "c"]);

    await p.handle(tx, tick(2n, "b"), { replay: true });
    expect((await load(s))!.state.seen).toEqual(["a", "c", "b"]);
  });

  it("throws a ConcurrencyError when the instance was advanced concurrently", async () => {
    const s = stores();
    await sagaAsProjection(counterSaga, s).handle(tx, tick(1n, "a"));
    const racing = {
      ...s,
      stateStore: {
        load: s.stateStore.load.bind(s.stateStore),
        insert: s.stateStore.insert.bind(s.stateStore),
        update: async () => false,
      },
    };
    const err = await sagaAsProjection(counterSaga, racing as any).handle(tx, tick(2n, "b")).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ConcurrencyError");
  });
});
