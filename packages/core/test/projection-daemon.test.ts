import { describe, it, expect, beforeEach } from "vitest";
import { ProjectionDaemon } from "../src/projections/projection-daemon";
import type { TenantScopedUnitOfWorkFactory } from "../src/projections/catch-up-projector";
import type { EventEnvelope, Transaction, UnitOfWork, EventStore } from "../src/types";
import type { ProjectionCheckpointStore, ProjectionCheckpoint } from "../src/projections/projection-checkpoint-store";
import type { CatchUpProjection } from "../src/projections/catch-up-projection";
import type {
  ProjectionDeadLetterStore,
  ProjectionDeadLetter,
  NewProjectionDeadLetter
} from "../src/projections/projection-dead-letter-store";
import type { HighWaterMark } from "../src/projections/high-water-mark";

type E = { type: "TestEvent"; version: 1; value: string };

// ---------------------------------------------------------------------------
// Transactional in-memory mocks: writes are buffered on the tx and applied on
// commit, so a handler failure rolls back checkpoint / dead-letter writes.
// ---------------------------------------------------------------------------

type MockTx = Transaction & { tenantId: string; onCommit: Array<() => void> };

class MockUow implements TenantScopedUnitOfWorkFactory<MockTx> {
  forTenant(tenantId: string): UnitOfWork<MockTx> {
    return {
      async withTransaction<T>(fn: (tx: MockTx) => Promise<T>): Promise<T> {
        const tx: MockTx = { tenantId, onCommit: [] };
        const res = await fn(tx);
        for (const op of tx.onCommit) op();
        return res;
      }
    };
  }
  narrow(tx: MockTx, tenantId: string): MockTx {
    return { ...tx, tenantId };
  }
}

class MockEventStore implements EventStore<E, MockTx> {
  events: EventEnvelope<E>[] = [];
  async loadGlobal(
    _tx: MockTx,
    p: { fromGlobalPositionExclusive: bigint; toGlobalPositionInclusive?: bigint; limit: number; includeDismissed?: boolean; tenantId?: string }
  ) {
    return this.events
      .filter((e) => e.globalPosition > p.fromGlobalPositionExclusive)
      .filter((e) => p.toGlobalPositionInclusive === undefined || e.globalPosition <= p.toGlobalPositionInclusive)
      .filter((e) => p.tenantId === undefined || e.tenantId === p.tenantId)
      .slice(0, p.limit)
      .filter((e) => p.includeDismissed || !e.dismissed);
  }
  async discoverActiveTenants(
    _tx: MockTx,
    p: { fromGlobalPositionExclusive: bigint; toGlobalPositionInclusive?: bigint }
  ) {
    const set = new Set<string>();
    for (const e of this.events) {
      if (e.globalPosition <= p.fromGlobalPositionExclusive) continue;
      if (p.toGlobalPositionInclusive !== undefined && e.globalPosition > p.toGlobalPositionInclusive) continue;
      set.add(e.tenantId);
    }
    return [...set].sort();
  }
  async loadByGlobalPositions(_tx: MockTx, positions: bigint[]) {
    return this.events.filter((e) => positions.includes(e.globalPosition));
  }
  async append(): Promise<{ appended: EventEnvelope<E>[]; nextAggregateVersion: number }> {
    return { appended: [], nextAggregateVersion: 0 };
  }
  async loadStream(): Promise<EventEnvelope<E>[]> { return []; }
  async dismiss(): Promise<void> {}
}

class MockCheckpoints implements ProjectionCheckpointStore<MockTx> {
  positions = new Map<string, bigint>();
  busy = new Set<string>();
  private key(p: string, t: string) { return `${p}|${t}`; }
  private cp(p: string, t: string): ProjectionCheckpoint {
    return { projectionName: p, tenantId: t, lastGlobalPosition: this.positions.get(this.key(p, t)) ?? 0n, updatedAt: "" };
  }
  async get(_tx: MockTx, p: string, t: string) { return this.cp(p, t); }
  async claim(_tx: MockTx, p: string, t: string) {
    return this.busy.has(this.key(p, t)) ? null : this.cp(p, t);
  }
  async set(tx: MockTx, p: string, t: string, pos: bigint) {
    tx.onCommit.push(() => {
      const k = this.key(p, t);
      if ((this.positions.get(k) ?? 0n) <= pos) this.positions.set(k, pos);
    });
  }
  async reset(tx: MockTx, p: string, t: string) {
    tx.onCommit.push(() => this.positions.set(this.key(p, t), 0n));
  }
  at(p: string, t = "default") { return this.positions.get(this.key(p, t)) ?? 0n; }
}

class MockDeadLetters implements ProjectionDeadLetterStore<MockTx> {
  items: ProjectionDeadLetter[] = [];
  private nextId = 1;
  async add(tx: MockTx, item: NewProjectionDeadLetter) {
    tx.onCommit.push(() => this.items.push({ ...item, id: this.nextId++, deadLetteredAt: new Date().toISOString() }));
  }
  async get(_tx: MockTx, id: ProjectionDeadLetter["id"]) { return this.items.find((i) => i.id === id) ?? null; }
  async list() { return [...this.items]; }
  async delete(tx: MockTx, id: ProjectionDeadLetter["id"]) {
    tx.onCommit.push(() => { this.items = this.items.filter((i) => i.id !== id); });
  }
  async purge(tx: MockTx, opts: { projectionName: string; tenantId?: string }) {
    const n = this.items.filter((i) => i.projectionName === opts.projectionName && (!opts.tenantId || i.tenantId === opts.tenantId)).length;
    tx.onCommit.push(() => {
      this.items = this.items.filter((i) => !(i.projectionName === opts.projectionName && (!opts.tenantId || i.tenantId === opts.tenantId)));
    });
    return n;
  }
}

class FakeHwm implements HighWaterMark {
  constructor(public mark: bigint | null = null, private readonly store?: MockEventStore) {}
  async safePosition() {
    if (this.mark !== null) return this.mark;
    return this.store!.events.reduce((m, e) => (e.globalPosition > m ? e.globalPosition : m), 0n);
  }
}

const ev = (pos: number, tenantId = "default", dismissed = false): EventEnvelope<E> => ({
  eventId: `evt-${pos}`,
  globalPosition: BigInt(pos),
  payload: { type: "TestEvent", version: 1, value: `v${pos}` },
  tenantId,
  aggregateName: "A",
  aggregateId: String(pos),
  aggregateVersion: 1,
  occurredAt: new Date().toISOString(),
  dismissed: dismissed ? { at: new Date().toISOString() } : undefined
});

const fastBackoff = { minMs: 1, maxMs: 1, factor: 1, jitter: 0 };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ProjectionDaemon", () => {
  let uow: MockUow;
  let store: MockEventStore;
  let checkpoints: MockCheckpoints;
  let dlq: MockDeadLetters;
  let hwm: FakeHwm;

  beforeEach(() => {
    uow = new MockUow();
    store = new MockEventStore();
    checkpoints = new MockCheckpoints();
    dlq = new MockDeadLetters();
    hwm = new FakeHwm(null, store);
  });

  function daemon(projections: CatchUpProjection<E, MockTx>[], opts: ConstructorParameters<typeof ProjectionDaemon>[6] = {}) {
    return new ProjectionDaemon<E, MockTx>(uow, store, checkpoints, hwm, dlq, projections, {
      batchSize: 10,
      backoff: fastBackoff,
      ...opts
    });
  }

  function recorder(name: string, extra?: (env: EventEnvelope<E>) => void) {
    const handled: Array<[string, bigint]> = [];
    const projection: CatchUpProjection<E, MockTx> = {
      name,
      async handle(tx, env) {
        extra?.(env);
        // Record on commit, like a read-model write: a rolled-back batch leaves no trace.
        tx.onCommit.push(() => handled.push([tx.tenantId, env.globalPosition]));
      }
    };
    return { projection, handled };
  }

  it("rejects duplicate projection names", () => {
    const { projection } = recorder("p");
    expect(() => daemon([projection, projection])).toThrow("Duplicate projection name: p");
  });

  it("processes every tenant's events and reports whether it did work", async () => {
    store.events = [ev(1, "a"), ev(2, "b"), ev(3, "a")];
    const { projection, handled } = recorder("p");
    const d = daemon([projection]);

    expect(await d.runOnce()).toBe(true);
    expect(handled).toEqual(expect.arrayContaining([["a", 1n], ["a", 3n], ["b", 2n]]));
    expect(handled).toHaveLength(3);
    expect(checkpoints.at("p", "a")).toBe(3n);
    expect(checkpoints.at("p", "b")).toBe(2n);

    expect(await d.runOnce()).toBe(false);
  });

  it("picks up new events and new tenants on later rounds", async () => {
    store.events = [ev(1, "a")];
    const { projection, handled } = recorder("p");
    const d = daemon([projection]);
    await d.runOnce();

    store.events.push(ev(2, "b"), ev(3, "a"));
    await d.runOnce();
    expect(handled).toEqual([["a", 1n], ["a", 3n], ["b", 2n]]);
  });

  it("never reads past the high water mark", async () => {
    store.events = [ev(1), ev(2), ev(3)];
    hwm.mark = 2n;
    const { projection, handled } = recorder("p");
    await daemon([projection]).runOnce();
    expect(handled.map(([, p]) => p)).toEqual([1n, 2n]);
    expect(checkpoints.at("p")).toBe(2n);
  });

  it("back-fills a projection added later from the start of the log", async () => {
    store.events = [ev(1), ev(2)];
    const first = recorder("first");
    await daemon([first.projection]).runOnce();

    const second = recorder("second");
    await daemon([first.projection, second.projection]).runOnce();
    expect(second.handled.map(([, p]) => p)).toEqual([1n, 2n]);
    expect(first.handled).toHaveLength(2);
  });

  it("skips a pair another instance holds and retries it next round", async () => {
    store.events = [ev(1)];
    checkpoints.busy.add("p|default");
    const { projection, handled } = recorder("p");
    const d = daemon([projection]);

    await d.runOnce();
    expect(handled).toEqual([]);

    checkpoints.busy.clear();
    await d.runOnce();
    expect(handled).toEqual([["default", 1n]]);
  });

  it("skips dismissed events and moves the checkpoint past a batch made of them", async () => {
    store.events = [ev(1, "default", true), ev(2, "default", true), ev(3)];
    const { projection, handled } = recorder("p");
    await daemon([projection], { batchSize: 2 }).runOnce();
    expect(handled).toEqual([["default", 3n]]);
    expect(checkpoints.at("p")).toBe(3n);
  });

  it("commits the events before a failing one, then retries the failing event", async () => {
    store.events = [ev(1), ev(2), ev(3)];
    let failuresLeft = 2;
    const { projection, handled } = recorder("p", (env) => {
      if (env.globalPosition === 2n && failuresLeft-- > 0) throw new Error("transient");
    });
    const d = daemon([projection], { maxAttempts: 5 });

    await d.runOnce();
    expect(handled.map(([, p]) => p)).toEqual([1n]);
    expect(checkpoints.at("p")).toBe(1n);

    for (let i = 0; i < 5 && checkpoints.at("p") < 3n; i++) {
      await tick();
      await d.runOnce();
    }
    expect(handled.map(([, p]) => p)).toEqual([1n, 2n, 3n]);
    expect(dlq.items).toEqual([]);
  });

  it("dead-letters an event after maxAttempts and moves on", async () => {
    store.events = [ev(1), ev(2), ev(3)];
    let attempts = 0;
    const deadLettered: unknown[] = [];
    const { projection, handled } = recorder("p", (env) => {
      if (env.globalPosition === 2n) {
        attempts++;
        throw new Error("poison");
      }
    });
    const d = daemon([projection], {
      maxAttempts: 3,
      observer: { onEventDeadLettered: (info) => deadLettered.push(info) }
    });

    for (let i = 0; i < 10 && checkpoints.at("p") < 3n; i++) {
      await d.runOnce();
      await tick();
    }

    expect(attempts).toBe(3);
    expect(handled.map(([, p]) => p)).toEqual([1n, 3n]);
    expect(checkpoints.at("p")).toBe(3n);
    expect(dlq.items).toHaveLength(1);
    expect(dlq.items[0]).toMatchObject({
      projectionName: "p",
      tenantId: "default",
      globalPosition: 2n,
      eventId: "evt-2",
      eventType: "TestEvent",
      attempts: 3
    });
    expect(dlq.items[0]!.lastError).toContain("poison");
    expect(deadLettered).toHaveLength(1);
  });

  it("dead-letters a poison event even when a later event in its batch also fails", async () => {
    // Event 2 fails the first time it is attempted, which is in the same
    // batch that dead-letters event 1. The dead letter must still commit;
    // otherwise event 1's failure state is lost and it gets retried past
    // maxAttempts.
    store.events = [ev(1), ev(2), ev(3)];
    let attemptsOn1 = 0;
    let twoFailed = false;
    const { projection } = recorder("p", (env) => {
      if (env.globalPosition === 1n) { attemptsOn1++; throw new Error("poison"); }
      if (env.globalPosition === 2n && !twoFailed) { twoFailed = true; throw new Error("fails once"); }
    });
    const d = daemon([projection], { maxAttempts: 2 });

    for (let i = 0; i < 20 && checkpoints.at("p") < 3n; i++) {
      await d.runOnce();
      await tick();
    }
    expect(attemptsOn1).toBe(2);
    expect(dlq.items.map((i) => i.globalPosition)).toEqual([1n]);
    expect(checkpoints.at("p")).toBe(3n);
  });

  it("isolates failures per tenant", async () => {
    store.events = [ev(1, "bad"), ev(2, "good")];
    const { projection, handled } = recorder("p", (env) => {
      if (env.tenantId === "bad") throw new Error("boom");
    });
    await daemon([projection], { maxAttempts: 100 }).runOnce();
    expect(handled).toEqual([["good", 2n]]);
  });

  it("replayDeadLetter runs the handler again and deletes the dead letter", async () => {
    store.events = [ev(1)];
    let broken = true;
    const { projection, handled } = recorder("p", () => {
      if (broken) throw new Error("down");
    });
    const d = daemon([projection], { maxAttempts: 1 });
    for (let i = 0; i < 5 && dlq.items.length === 0; i++) {
      await d.runOnce();
      await tick();
    }
    expect(dlq.items).toHaveLength(1);

    broken = false;
    const res = await d.replayDeadLetter(dlq.items[0]!.id);
    expect(res).toEqual({ replayed: true });
    expect(handled).toEqual([["default", 1n]]);
    expect(dlq.items).toEqual([]);

    expect(await d.replayDeadLetter(999)).toEqual({ replayed: false, reason: "Dead letter not found" });
  });

  it("passes { replay: false } normally and { replay: true } when replaying a dead letter", async () => {
    store.events = [ev(1)];
    let broken = true;
    const seen: Array<boolean | undefined> = [];
    const projection: CatchUpProjection<E, MockTx> = {
      name: "p",
      async handle(_tx, _env, ctx) {
        seen.push(ctx?.replay);
        if (broken) throw new Error("down");
      }
    };
    const d = daemon([projection], { maxAttempts: 1 });
    for (let i = 0; i < 5 && dlq.items.length === 0; i++) {
      await d.runOnce();
      await tick();
    }
    broken = false;
    await d.replayDeadLetter(dlq.items[0]!.id);
    expect(seen).toEqual([false, true]);
  });

  it("replayDeadLetter keeps the dead letter when the handler still fails", async () => {
    store.events = [ev(1)];
    const { projection } = recorder("p", () => { throw new Error("still down"); });
    const d = daemon([projection], { maxAttempts: 1 });
    for (let i = 0; i < 5 && dlq.items.length === 0; i++) {
      await d.runOnce();
      await tick();
    }
    await expect(d.replayDeadLetter(dlq.items[0]!.id)).rejects.toThrow("still down");
    expect(dlq.items).toHaveLength(1);
  });

  it("rebuild resets every tenant, clears dead letters and replays from the start", async () => {
    store.events = [ev(1, "a"), ev(2, "b")];
    const resets: string[] = [];
    const handled: Array<[string, bigint]> = [];
    const projection: CatchUpProjection<E, MockTx> = {
      name: "p",
      async handle(tx, env) { handled.push([tx.tenantId, env.globalPosition]); },
      async reset(tx) { resets.push(tx.tenantId); }
    };
    const d = daemon([projection]);
    await d.runOnce();
    dlq.items.push({
      id: 50, projectionName: "p", tenantId: "a", globalPosition: 1n, eventId: "evt-1",
      eventType: "TestEvent", attempts: 3, lastError: "x", deadLetteredAt: ""
    });
    handled.length = 0;

    await d.rebuild("p");

    expect(resets.sort()).toEqual(["a", "b"]);
    expect(handled.sort()).toEqual([["a", 1n], ["b", 2n]]);
    expect(dlq.items).toEqual([]);
  });

  it("rebuild rejects unknown projections", async () => {
    await expect(daemon([]).rebuild("nope")).rejects.toThrow("Projection not registered: nope");
  });

  it("start() runs until aborted and resolves", async () => {
    store.events = [ev(1)];
    const { projection, handled } = recorder("p");
    const ac = new AbortController();
    const running = daemon([projection], { idleSleepMs: 5 }).start(ac.signal);
    for (let i = 0; i < 100 && handled.length === 0; i++) await tick();
    store.events.push(ev(2));
    for (let i = 0; i < 100 && handled.length < 2; i++) await tick();
    ac.abort();
    await expect(running).resolves.toBeUndefined();
    expect(handled.map(([, p]) => p)).toEqual([1n, 2n]);
  });

  it("start() reports infrastructure errors and keeps going", async () => {
    store.events = [ev(1)];
    let fail = true;
    const errors: unknown[] = [];
    const flakyHwm: HighWaterMark = {
      async safePosition() {
        if (fail) { fail = false; throw new Error("db down"); }
        return 1n;
      }
    };
    const { projection, handled } = recorder("p");
    const d = new ProjectionDaemon<E, MockTx>(uow, store, checkpoints, flakyHwm, dlq, [projection], {
      idleSleepMs: 5,
      backoff: fastBackoff,
      observer: { onProjectorError: (i) => errors.push(i) }
    });
    const ac = new AbortController();
    const running = d.start(ac.signal);
    for (let i = 0; i < 100 && handled.length === 0; i++) await tick();
    ac.abort();
    await running;
    expect(errors).toHaveLength(1);
    expect(handled).toEqual([["default", 1n]]);
  });
});
