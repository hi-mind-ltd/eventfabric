import { describe, it, expect, vi } from "vitest";
import {
  AsyncProjectionRunner,
  type AsyncRunnerOptions
} from "../src/projections/async-projection-runner";
import type { AsyncRunnerObserver } from "../src/projections/async-runner-observer";
import { CatchUpProjector, type CatchUpOptions } from "../src/projections/catch-up-projector";
import type { CatchUpProjectorObserver } from "../src/projections/catch-up-observer";
import type { EventEnvelope, Transaction, UnitOfWork, EventStore } from "../src/types";
import type { OutboxStore, OutboxRow } from "../src/outbox/outbox-store";
import type { ProjectionCheckpointStore } from "../src/projections/projection-checkpoint-store";
import type { AsyncProjection } from "../src/projections/async-projection";
import type { CatchUpProjection } from "../src/projections/catch-up-projection";

type E = { type: "Tick"; version: 1; n: number };

class MockTx implements Transaction {}

class MockUow implements UnitOfWork<MockTx> {
  async withTransaction<T>(fn: (tx: MockTx) => Promise<T>): Promise<T> {
    return fn(new MockTx());
  }
}

class MockEventStore implements EventStore<E, MockTx> {
  events: EventEnvelope<E>[] = [];
  async loadByGlobalPositions(_tx: MockTx, positions: bigint[]): Promise<EventEnvelope<E>[]> {
    return this.events.filter((e) => positions.some((p) => p === e.globalPosition));
  }
  async loadGlobal(
    _tx: MockTx,
    p: { fromGlobalPositionExclusive: bigint; limit: number; includeDismissed?: boolean }
  ): Promise<EventEnvelope<E>[]> {
    return this.events
      .filter((e) => e.globalPosition > p.fromGlobalPositionExclusive)
      .slice(0, p.limit);
  }
  async append(): Promise<{ appended: EventEnvelope<E>[]; nextAggregateVersion: number }> {
    return { appended: [], nextAggregateVersion: 0 };
  }
  async loadStream(): Promise<EventEnvelope<E>[]> {
    return [];
  }
  async dismiss(): Promise<void> {}
}

class MockOutbox implements OutboxStore<MockTx> {
  claimed: OutboxRow[] = [];
  acked: OutboxRow["id"][] = [];
  released: Array<{ id: OutboxRow["id"]; error: string }> = [];
  deadLettered: Array<{ row: OutboxRow; reason: string }> = [];
  async claimBatch(): Promise<OutboxRow[]> {
    return this.claimed;
  }
  async ack(_tx: MockTx, id: OutboxRow["id"]): Promise<void> {
    this.acked.push(id);
  }
  async releaseWithError(_tx: MockTx, id: OutboxRow["id"], error: string): Promise<void> {
    this.released.push({ id, error });
  }
  async deadLetter(_tx: MockTx, row: OutboxRow, reason: string): Promise<void> {
    this.deadLettered.push({ row, reason });
  }
}

class MockCheckpoints implements ProjectionCheckpointStore<MockTx> {
  map = new Map<string, bigint>();
  async get(_tx: MockTx, name: string) {
    return {
      projectionName: name,
      lastGlobalPosition: this.map.get(name) ?? 0n,
      updatedAt: new Date().toISOString()
    };
  }
  async set(_tx: MockTx, name: string, pos: bigint): Promise<void> {
    this.map.set(name, pos);
  }
}

function mkEvent(n: number): EventEnvelope<E> {
  return {
    eventId: `evt-${n}`,
    aggregateName: "A",
    aggregateId: "1",
    aggregateVersion: n,
    globalPosition: BigInt(n),
    occurredAt: new Date().toISOString(),
    payload: { type: "Tick", version: 1, n }
  };
}

describe("AsyncProjectionRunner observers", () => {
  function setup(observer: AsyncRunnerObserver) {
    const uow = new MockUow();
    const store = new MockEventStore();
    const outbox = new MockOutbox();
    const checkpoints = new MockCheckpoints();
    const projection: AsyncProjection<E, MockTx> = {
      name: "p1",
      topicFilter: { mode: "all" },
      async handle() {}
    };
    const opts: AsyncRunnerOptions = {
      workerId: "w1",
      batchSize: 10,
      idleSleepMs: 10,
      observer
    };
    const runner = new AsyncProjectionRunner(uow, store, outbox, checkpoints, [projection], opts);
    return { runner, store, outbox, checkpoints, projection };
  }

  it("fires onEventHandled with duration on success", async () => {
    const onEventHandled = vi.fn();
    const { runner, store, outbox } = setup({ onEventHandled });
    outbox.claimed = [{ id: 1, globalPosition: 1n, topic: null, attempts: 1 }];
    store.events = [mkEvent(1)];

    await (runner as any).processBatch(outbox.claimed, false, 10);

    expect(onEventHandled).toHaveBeenCalledTimes(1);
    const info = onEventHandled.mock.calls[0]![0];
    expect(info.projection).toBe("p1");
    expect(info.eventType).toBe("Tick");
    expect(info.globalPosition).toBe(1n);
    expect(info.workerId).toBe("w1");
    expect(info.attempts).toBe(1);
    expect(typeof info.durationMs).toBe("number");
    expect(info.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fires onEventFailed with error on handler throw", async () => {
    const onEventFailed = vi.fn();
    const onEventHandled = vi.fn();
    const uow = new MockUow();
    const store = new MockEventStore();
    const outbox = new MockOutbox();
    const checkpoints = new MockCheckpoints();
    const projection: AsyncProjection<E, MockTx> = {
      name: "p1",
      topicFilter: { mode: "all" },
      async handle() {
        throw new Error("kaboom");
      }
    };
    const runner = new AsyncProjectionRunner(uow, store, outbox, checkpoints, [projection], {
      workerId: "w1",
      batchSize: 10,
      observer: { onEventFailed, onEventHandled }
    });
    outbox.claimed = [{ id: 1, globalPosition: 1n, topic: null, attempts: 1 }];
    store.events = [mkEvent(1)];

    await expect((runner as any).processBatch(outbox.claimed, false, 10)).rejects.toThrow("kaboom");
    expect(onEventHandled).not.toHaveBeenCalled();
    expect(onEventFailed).toHaveBeenCalledTimes(1);
    const info = onEventFailed.mock.calls[0]![0];
    expect(info.error).toBeInstanceOf(Error);
    expect(info.error.message).toBe("kaboom");
    expect(info.projection).toBe("p1");
  });

  it("invokes runHandler wrapper and passes info", async () => {
    const runHandler = vi.fn(async (handle: () => Promise<void>, _info: unknown) => {
      await handle();
    });
    const { runner, store, outbox } = setup({ runHandler });
    outbox.claimed = [{ id: 1, globalPosition: 1n, topic: null, attempts: 2 }];
    store.events = [mkEvent(1)];

    await (runner as any).processBatch(outbox.claimed, false, 10);

    expect(runHandler).toHaveBeenCalledTimes(1);
    const infoArg = runHandler.mock.calls[0]![1] as { projection: string; attempts: number };
    expect(infoArg.projection).toBe("p1");
    expect(infoArg.attempts).toBe(2);
  });

  it("fires onMessageAcked for each processed row", async () => {
    const onMessageAcked = vi.fn();
    const { runner, store, outbox } = setup({ onMessageAcked });
    outbox.claimed = [
      { id: 1, globalPosition: 1n, topic: null, attempts: 1 },
      { id: 2, globalPosition: 2n, topic: null, attempts: 1 }
    ];
    store.events = [mkEvent(1), mkEvent(2)];

    await (runner as any).processBatch(outbox.claimed, false, 10);

    expect(onMessageAcked).toHaveBeenCalledTimes(2);
    expect(onMessageAcked.mock.calls.map((c) => (c[0] as { outboxId: number }).outboxId)).toEqual([
      1, 2
    ]);
  });

  it("fires onMessageDeadLettered when attempts exceed maxAttempts", async () => {
    const onMessageDeadLettered = vi.fn();
    const { runner, outbox } = setup({ onMessageDeadLettered });
    outbox.claimed = [{ id: 1, globalPosition: 1n, topic: null, attempts: 11 }];

    await (runner as any).processBatch(outbox.claimed, false, 10);

    expect(onMessageDeadLettered).toHaveBeenCalledTimes(1);
    const info = onMessageDeadLettered.mock.calls[0]![0];
    expect(info.outboxId).toBe(1);
    expect(info.attempts).toBe(11);
    expect(info.reason).toMatch(/Exceeded/);
  });

  it("observer errors never affect runner behavior", async () => {
    const onEventHandled = vi.fn(() => {
      throw new Error("observer is broken");
    });
    const { runner, store, outbox } = setup({ onEventHandled });
    outbox.claimed = [{ id: 1, globalPosition: 1n, topic: null, attempts: 1 }];
    store.events = [mkEvent(1)];

    // Must not throw despite observer error
    await expect(
      (runner as any).processBatch(outbox.claimed, false, 10)
    ).resolves.toBeUndefined();
    expect(outbox.acked).toEqual([1]);
  });
});

describe("CatchUpProjector observers", () => {
  function setup(observer: CatchUpProjectorObserver) {
    const uow = new MockUow();
    const store = new MockEventStore();
    const checkpoints = new MockCheckpoints();
    const projector = new CatchUpProjector(uow, store, checkpoints);
    const projection: CatchUpProjection<E, MockTx> = {
      name: "cp1",
      async handle() {}
    };
    const options: CatchUpOptions = { batchSize: 10, observer };
    return { projector, store, checkpoints, projection, options };
  }

  it("fires onBatchLoaded, onEventHandled, and onCheckpointAdvanced on a successful batch", async () => {
    const onBatchLoaded = vi.fn();
    const onEventHandled = vi.fn();
    const onCheckpointAdvanced = vi.fn();
    const { projector, store, projection, options } = setup({
      onBatchLoaded,
      onEventHandled,
      onCheckpointAdvanced
    });
    store.events = [mkEvent(1), mkEvent(2), mkEvent(3)];

    await projector.catchUpProjection(projection, { ...options, maxBatches: 2 });

    expect(onBatchLoaded).toHaveBeenCalledTimes(1);
    expect(onBatchLoaded.mock.calls[0]![0]).toMatchObject({
      projection: "cp1",
      count: 3,
      fromPosition: 0n
    });
    expect(onEventHandled).toHaveBeenCalledTimes(3);
    expect(onCheckpointAdvanced).toHaveBeenCalledTimes(1);
    expect(onCheckpointAdvanced.mock.calls[0]![0]).toMatchObject({
      projection: "cp1",
      fromPosition: 0n,
      toPosition: 3n
    });
  });

  it("invokes runHandler wrapper for each event", async () => {
    const runHandler = vi.fn(async (handle: () => Promise<void>, _info: unknown) => {
      await handle();
    });
    const { projector, store, projection, options } = setup({ runHandler });
    store.events = [mkEvent(1), mkEvent(2)];

    await projector.catchUpProjection(projection, { ...options, maxBatches: 1 });

    expect(runHandler).toHaveBeenCalledTimes(2);
  });

  it("fires onEventFailed and onProjectorError on handler throw", async () => {
    const onEventFailed = vi.fn();
    const onProjectorError = vi.fn();
    const uow = new MockUow();
    const store = new MockEventStore();
    const checkpoints = new MockCheckpoints();
    const projector = new CatchUpProjector(uow, store, checkpoints);
    const projection: CatchUpProjection<E, MockTx> = {
      name: "cp1",
      async handle() {
        throw new Error("cp-boom");
      }
    };
    store.events = [mkEvent(1)];

    await expect(
      projector.catchUpProjection(projection, {
        batchSize: 10,
        observer: { onEventFailed, onProjectorError }
      })
    ).rejects.toThrow("cp-boom");

    expect(onEventFailed).toHaveBeenCalledTimes(1);
    expect(onEventFailed.mock.calls[0]![0].error.message).toBe("cp-boom");
    expect(onProjectorError).toHaveBeenCalledTimes(1);
    expect(onProjectorError.mock.calls[0]![0].error.message).toBe("cp-boom");
  });

  it("observer errors never affect projector behavior", async () => {
    const onEventHandled = vi.fn(() => {
      throw new Error("cp observer broken");
    });
    const { projector, store, projection, options } = setup({ onEventHandled });
    store.events = [mkEvent(1)];

    await expect(
      projector.catchUpProjection(projection, { ...options, maxBatches: 1 })
    ).resolves.toBeUndefined();
  });
});
