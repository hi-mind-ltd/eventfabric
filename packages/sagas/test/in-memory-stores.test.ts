import { describe, it, expect } from "vitest";
import type { Transaction } from "@eventfabric/core";
import type { Command } from "@eventfabric/mediator";
import {
  InMemorySagaCommandQueue,
  InMemorySagaStateStore,
  InMemorySagaTimerStore,
} from "../src";

const tx = {} as Transaction;

const cmd = (type: string, key: string): Command => ({
  type,
  version: 1,
  payload: {},
  metadata: { commandId: `c-${key}`, idempotencyKey: key, issuedAt: "2026-04-28T00:00:00Z" },
});

const baseInstance = (overrides: Partial<{ stateVersion: number }> = {}) => ({
  sagaName: "S",
  instanceId: "i",
  tenantId: "default",
  state: { count: 0 },
  stateVersion: overrides.stateVersion ?? 0,
  status: "active" as const,
  schemaVersion: 1,
  lastEventPos: null as bigint | null,
  createdAt: "2026-04-28T00:00:00Z",
  updatedAt: "2026-04-28T00:00:00Z",
});

describe("InMemorySagaStateStore", () => {
  it("insert + load round-trips a deep copy (mutating the loaded value does not affect storage)", async () => {
    const store = new InMemorySagaStateStore<{ count: number }>();
    await store.insert(tx, baseInstance());
    const loaded = await store.load(tx, { sagaName: "S", instanceId: "i", tenantId: "default" });
    expect(loaded).not.toBeNull();
    loaded!.state.count = 999;
    const reloaded = await store.load(tx, { sagaName: "S", instanceId: "i", tenantId: "default" });
    expect(reloaded!.state.count).toBe(0);
  });

  it("rejects double-insert of the same (saga, instance, tenant)", async () => {
    const store = new InMemorySagaStateStore<{ count: number }>();
    await store.insert(tx, baseInstance());
    await expect(store.insert(tx, baseInstance())).rejects.toThrow(/already exists/);
  });

  it("update returns false when expectedVersion does not match", async () => {
    const store = new InMemorySagaStateStore<{ count: number }>();
    await store.insert(tx, baseInstance());
    const ok = await store.update(tx, { ...baseInstance(), stateVersion: 1 }, 99);
    expect(ok).toBe(false);
  });

  it("update returns true on matching expectedVersion and persists", async () => {
    const store = new InMemorySagaStateStore<{ count: number }>();
    await store.insert(tx, baseInstance());
    const ok = await store.update(
      tx,
      { ...baseInstance(), stateVersion: 1, state: { count: 7 } },
      0
    );
    expect(ok).toBe(true);
    const loaded = await store.load(tx, { sagaName: "S", instanceId: "i", tenantId: "default" });
    expect(loaded!.stateVersion).toBe(1);
    expect(loaded!.state.count).toBe(7);
  });
});

describe("InMemorySagaCommandQueue", () => {
  it("enqueue then claimBatch returns rows in FIFO and marks them claimed", async () => {
    const q = new InMemorySagaCommandQueue();
    await q.enqueue(tx, { tenantId: "default", sagaName: "S", instanceId: "i", command: cmd("A", "1") });
    await q.enqueue(tx, { tenantId: "default", sagaName: "S", instanceId: "i", command: cmd("B", "2") });
    const claimed = await q.claimBatch(tx, { batchSize: 10 });
    expect(claimed.map((c) => c.command.type)).toEqual(["A", "B"]);
    expect(await q.claimBatch(tx, { batchSize: 10 })).toHaveLength(0);
  });

  it("ack removes a claimed row from the pending set", async () => {
    const q = new InMemorySagaCommandQueue();
    await q.enqueue(tx, { tenantId: "default", sagaName: "S", instanceId: "i", command: cmd("A", "1") });
    const [claimed] = await q.claimBatch(tx, { batchSize: 1 });
    await q.ack(tx, { id: claimed!.id });
    expect(q.pendingRows()).toHaveLength(0);
  });

  it("releaseWithError returns a claimed row to pending and increments attempts on next claim", async () => {
    const q = new InMemorySagaCommandQueue();
    await q.enqueue(tx, { tenantId: "default", sagaName: "S", instanceId: "i", command: cmd("A", "1") });
    const [first] = await q.claimBatch(tx, { batchSize: 1 });
    await q.releaseWithError(tx, { id: first!.id, error: new Error("boom") });
    const [second] = await q.claimBatch(tx, { batchSize: 1 });
    expect(second!.attempts).toBe(2);
  });
});

describe("InMemorySagaTimerStore", () => {
  it("schedule + claimDue + markFired", async () => {
    const ts = new InMemorySagaTimerStore();
    const key = { tenantId: "default", sagaName: "S", instanceId: "i" };
    const fireAt = new Date(Date.now() - 1000);
    await ts.schedule(tx, {
      ...key,
      id: "t1",
      fireAt,
      message: { type: "$timer", id: "t1", payload: null },
    });

    const due = await ts.claimDue(tx, { now: new Date(), batchSize: 10 });
    expect(due.map((d) => d.id)).toEqual(["t1"]);
    await ts.markFired(tx, { ...key, id: "t1" });

    const drainAgain = await ts.claimDue(tx, { now: new Date(), batchSize: 10 });
    expect(drainAgain).toHaveLength(0);
  });

  it("schedule with the same id replaces the prior pending row", async () => {
    const ts = new InMemorySagaTimerStore();
    const key = { tenantId: "default", sagaName: "S", instanceId: "i" };
    await ts.schedule(tx, {
      ...key,
      id: "t1",
      fireAt: new Date(Date.now() + 60_000),
      message: { type: "$timer", id: "t1", payload: { v: 1 } },
    });
    await ts.schedule(tx, {
      ...key,
      id: "t1",
      fireAt: new Date(Date.now() + 120_000),
      message: { type: "$timer", id: "t1", payload: { v: 2 } },
    });
    const pending = ts.pendingTimers();
    expect(pending).toHaveLength(1);
  });

  it("cancel removes the matching ids and counts the cancellations", async () => {
    const ts = new InMemorySagaTimerStore();
    const key = { tenantId: "default", sagaName: "S", instanceId: "i" };
    await ts.schedule(tx, { ...key, id: "t1", fireAt: new Date(Date.now() + 1000), message: { type: "$timer", id: "t1", payload: null } });
    await ts.schedule(tx, { ...key, id: "t2", fireAt: new Date(Date.now() + 1000), message: { type: "$timer", id: "t2", payload: null } });
    const cancelled = await ts.cancel(tx, { ...key, ids: ["t1", "t-missing"] });
    expect(cancelled).toBe(1);
    expect(ts.pendingTimers().map((t) => t.id)).toEqual(["t2"]);
  });

  it("does not return future timers from claimDue", async () => {
    const ts = new InMemorySagaTimerStore();
    const key = { tenantId: "default", sagaName: "S", instanceId: "i" };
    await ts.schedule(tx, {
      ...key,
      id: "t-future",
      fireAt: new Date(Date.now() + 60_000),
      message: { type: "$timer", id: "t-future", payload: null },
    });
    const due = await ts.claimDue(tx, { now: new Date(), batchSize: 10 });
    expect(due).toHaveLength(0);
  });
});
