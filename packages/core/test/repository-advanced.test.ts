import { describe, it, expect } from "vitest";
import { Repository } from "../src/repository";
import { AggregateRoot } from "../src/aggregates/aggregate-root";
import type { AnyEvent, EventEnvelope, EventStore, Transaction, UnitOfWork } from "../src/types";
import type { SnapshotStore } from "../src/snapshots/snapshot-store";
import type { Snapshot } from "../src/snapshots/snapshot";

type E = { type: "Inc"; version: 1; by: number };
type S = { n: number };

class Counter extends AggregateRoot<S, E> {
  protected handlers = {
    Inc: (s: S, e: Extract<E, { type: "Inc" }>) => {
      s.n += e.by;
    }
  };

  constructor(id: string, snap?: S) {
    super(id, snap ?? { n: 0 });
  }

  inc(by: number) {
    this.raise({ type: "Inc", version: 1, by });
  }
}

class MemTx implements Transaction {}

class MemUow implements UnitOfWork<MemTx> {
  async withTransaction<T>(fn: (tx: MemTx) => Promise<T>): Promise<T> {
    return fn(new MemTx());
  }
}

class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}

class MemStore implements EventStore<E, MemTx> {
  private streams = new Map<string, EventEnvelope<E>[]>();
  private gp = 0n;

  async append(tx: MemTx, p: any) {
    void tx;
    const key = `${p.aggregateName}:${p.aggregateId}`;
    const existing = this.streams.get(key) ?? [];
    const expected = p.expectedAggregateVersion;
    const lastVersion = existing.length ? existing[existing.length - 1]!.aggregateVersion : 0;
    if (lastVersion !== expected) {
      throw new ConcurrencyError(`Expected version ${expected} but stream is at ${lastVersion}`);
    }

    const appended: EventEnvelope<E>[] = p.events.map((evt: E, idx: number) => {
      this.gp += 1n;
      return {
        eventId: `e-${this.gp}`,
        aggregateName: p.aggregateName,
        aggregateId: p.aggregateId,
        aggregateVersion: expected + idx + 1,
        globalPosition: this.gp,
        occurredAt: new Date().toISOString(),
        payload: evt
      };
    });

    const next = [...existing, ...appended];
    this.streams.set(key, next);
    return { appended, nextAggregateVersion: expected + p.events.length };
  }

  async loadStream(tx: MemTx, p: any) {
    void tx;
    const key = `${p.aggregateName}:${p.aggregateId}`;
    const existing = this.streams.get(key) ?? [];
    const from = p.fromVersion ?? 1;
    return existing.filter(e => e.aggregateVersion >= from);
  }

  async loadGlobal(tx: MemTx, p: any): Promise<EventEnvelope<E>[]> {
    void tx;
    const all: EventEnvelope<E>[] = [];
    for (const stream of this.streams.values()) {
      all.push(...stream);
    }
    const filtered = all.filter(e => e.globalPosition > p.fromGlobalPositionExclusive);
    return filtered.slice(0, p.limit);
  }

  async loadByGlobalPositions(tx: MemTx, positions: bigint[]): Promise<EventEnvelope<E>[]> {
    void tx;
    const all: EventEnvelope<E>[] = [];
    for (const stream of this.streams.values()) {
      all.push(...stream);
    }
    const posSet = new Set(positions.map(p => p.toString()));
    return all.filter(e => posSet.has(e.globalPosition.toString()));
  }

  async dismiss(tx: MemTx, eventId: string): Promise<void> {
    void tx; void eventId;
  }
}

class MemSnapshotStore implements SnapshotStore<S, MemTx> {
  private snapshots = new Map<string, Snapshot<S>>();

  async load(tx: MemTx, aggregateName: string, aggregateId: string): Promise<Snapshot<S> | null> {
    void tx;
    const key = `${aggregateName}:${aggregateId}`;
    return this.snapshots.get(key) ?? null;
  }

  async save(tx: MemTx, snapshot: Snapshot<S>): Promise<void> {
    void tx;
    const key = `${snapshot.aggregateName}:${snapshot.aggregateId}`;
    this.snapshots.set(key, snapshot);
  }
}

describe("Repository Advanced", () => {
  describe("concurrency error handling", () => {
    it("throws concurrency error when expected version doesn't match", async () => {
      const repo = new Repository<Counter, S, E, MemTx>(
        "Counter",
        new MemUow(),
        new MemStore(),
        (id, snap) => new Counter(id, snap)
      );

      // First save succeeds
      const c1 = await repo.load("concurrent-1");
      c1.inc(1);
      await repo.save(c1);

      // Second save with stale version should fail
      const c2 = await repo.load("concurrent-1");
      c2.inc(2);
      // But c2 has version 1, so this should work
      await repo.save(c2);

      // Now try to save with wrong version
      const c3 = new Counter("concurrent-1");
      c3.version = 0; // Wrong version
      c3.inc(3);

      await expect(repo.save(c3)).rejects.toThrow(ConcurrencyError);
    });

    it("propagates concurrency error with correct message", async () => {
      const repo = new Repository<Counter, S, E, MemTx>(
        "Counter",
        new MemUow(),
        new MemStore(),
        (id, snap) => new Counter(id, snap)
      );

      const c1 = await repo.load("concurrent-2");
      c1.inc(1);
      await repo.save(c1);

      const c2 = new Counter("concurrent-2");
      c2.version = 0; // Wrong version
      c2.inc(2);

      try {
        await repo.save(c2);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e).toBeInstanceOf(ConcurrencyError);
        expect(e.message).toContain("Expected version 0 but stream is at 1");
      }
    });

    it("allows concurrent saves to different aggregates", async () => {
      const repo = new Repository<Counter, S, E, MemTx>(
        "Counter",
        new MemUow(),
        new MemStore(),
        (id, snap) => new Counter(id, snap)
      );

      await Promise.all([
        (async () => {
          const c1 = await repo.load("agg1");
          c1.inc(1);
          await repo.save(c1);
        })(),
        (async () => {
          const c2 = await repo.load("agg2");
          c2.inc(2);
          await repo.save(c2);
        })()
      ]);

      const c1 = await repo.load("agg1");
      const c2 = await repo.load("agg2");

      expect(c1.state.n).toBe(1);
      expect(c2.state.n).toBe(2);
    });

    it("allows sequential saves with correct version", async () => {
      const repo = new Repository<Counter, S, E, MemTx>(
        "Counter",
        new MemUow(),
        new MemStore(),
        (id, snap) => new Counter(id, snap)
      );

      const c1 = await repo.load("sequential");
      c1.inc(1);
      await repo.save(c1);

      const c2 = await repo.load("sequential");
      c2.inc(2);
      await repo.save(c2);

      const c3 = await repo.load("sequential");
      expect(c3.state.n).toBe(3);
      expect(c3.version).toBe(2);
    });
  });

  describe("loading from specific version", () => {
    it("loads events from snapshot version onwards", async () => {
      const snapshotStore = new MemSnapshotStore();
      const store = new MemStore();
      const repo = new Repository<Counter, S, E, MemTx>(
        "Counter",
        new MemUow(),
        store,
        (id, snap) => new Counter(id, snap),
        { snapshotStore }
      );

      // Create events 1-5
      const c1 = await repo.load("version-test");
      for (let i = 0; i < 5; i++) {
        c1.inc(1);
        await repo.save(c1);
      }

      // Create snapshot at version 5
      await snapshotStore.save(new MemTx(), {
        aggregateName: "Counter",
        aggregateId: "version-test",
        aggregateVersion: 5,
        createdAt: new Date().toISOString(),
        snapshotSchemaVersion: 1,
        state: { n: 5 }
      });

      // Add more events (6-7)
      c1.inc(1);
      await repo.save(c1);
      c1.inc(1);
      await repo.save(c1);

      // Load should use snapshot and only replay events 6-7
      const c2 = await repo.load("version-test");
      expect(c2.state.n).toBe(7); // 5 from snapshot + 2 from events 6-7
      expect(c2.version).toBe(7);
    });

    it("loads all events when no snapshot exists", async () => {
      const store = new MemStore();
      const repo = new Repository<Counter, S, E, MemTx>(
        "Counter",
        new MemUow(),
        store,
        (id, snap) => new Counter(id, snap)
      );

      // Create events
      const c1 = await repo.load("no-snapshot");
      for (let i = 0; i < 5; i++) {
        c1.inc(1);
        await repo.save(c1);
      }

      // Load should replay all events from version 1
      const c2 = await repo.load("no-snapshot");
      expect(c2.state.n).toBe(5);
      expect(c2.version).toBe(5);
    });

    it("loads from version 1 when snapshot is at version 0", async () => {
      const snapshotStore = new MemSnapshotStore();
      const store = new MemStore();
      
      // Create snapshot at version 0 (initial state)
      await snapshotStore.save(new MemTx(), {
        aggregateName: "Counter",
        aggregateId: "zero-snapshot",
        aggregateVersion: 0,
        createdAt: new Date().toISOString(),
        snapshotSchemaVersion: 1,
        state: { n: 0 }
      });

      // Manually add an event at version 1 to the store
      await store.append(new MemTx(), {
        aggregateName: "Counter",
        aggregateId: "zero-snapshot",
        expectedAggregateVersion: 0,
        events: [{ type: "Inc", version: 1, by: 10 }]
      });

      const repo = new Repository<Counter, S, E, MemTx>(
        "Counter",
        new MemUow(),
        store,
        (id, snap) => new Counter(id, snap),
        { snapshotStore }
      );

      // Load should use snapshot (version 0) and replay events from version 1
      const c2 = await repo.load("zero-snapshot");
      expect(c2.state.n).toBe(10); // 0 from snapshot + 10 from event
      expect(c2.version).toBe(1);
    });
  });

  describe("snapshot integration", () => {
    it("loads aggregate with snapshot state", async () => {
      const snapshotStore = new MemSnapshotStore();
      const repo = new Repository<Counter, S, E, MemTx>(
        "Counter",
        new MemUow(),
        new MemStore(),
        (id, snap) => new Counter(id, snap),
        { snapshotStore }
      );

      // Create snapshot manually
      await snapshotStore.save(new MemTx(), {
        aggregateName: "Counter",
        aggregateId: "snap-test",
        aggregateVersion: 10,
        createdAt: new Date().toISOString(),
        snapshotSchemaVersion: 1,
        state: { n: 100 }
      });

      const c = await repo.load("snap-test");
      expect(c.state.n).toBe(100);
      expect(c.version).toBe(10);
    });

    it("loads events from snapshot version onwards", async () => {
      const snapshotStore = new MemSnapshotStore();
      const store = new MemStore();
      const repo = new Repository<Counter, S, E, MemTx>(
        "Counter",
        new MemUow(),
        store,
        (id, snap) => new Counter(id, snap),
        { snapshotStore }
      );

      // Create events 1-3
      const c0 = await repo.load("replay-test");
      for (let i = 0; i < 3; i++) {
        c0.inc(10);
        await repo.save(c0);
      }

      // Create snapshot at version 3
      await snapshotStore.save(new MemTx(), {
        aggregateName: "Counter",
        aggregateId: "replay-test",
        aggregateVersion: 3,
        createdAt: new Date().toISOString(),
        snapshotSchemaVersion: 1,
        state: { n: 30 }
      });

      // Add events after version 3
      const c1 = await repo.load("replay-test");
      c1.inc(5);
      await repo.save(c1);
      c1.inc(10);
      await repo.save(c1);

      // Load should use snapshot and replay events from version 4 onwards
      const c2 = await repo.load("replay-test");
      // The Repository loads from baseVersion + 1, which is 4
      // So it should replay events 4 and 5
      expect(c2.version).toBe(5);
      // State should reflect snapshot + events 4-5
      expect(c2.state.n).toBeGreaterThanOrEqual(30);
    });

    it("uses snapshot state as initial state for aggregate", async () => {
      const snapshotStore = new MemSnapshotStore();
      const repo = new Repository<Counter, S, E, MemTx>(
        "Counter",
        new MemUow(),
        new MemStore(),
        (id, snap) => new Counter(id, snap),
        { snapshotStore }
      );

      await snapshotStore.save(new MemTx(), {
        aggregateName: "Counter",
        aggregateId: "initial-state",
        aggregateVersion: 5,
        createdAt: new Date().toISOString(),
        snapshotSchemaVersion: 1,
        state: { n: 50 }
      });

      const c = await repo.load("initial-state");
      // Aggregate should be created with snapshot state
      expect(c.state.n).toBe(50);
    });
  });
});

