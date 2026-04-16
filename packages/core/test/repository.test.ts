import { describe, it, expect } from "vitest";
import { Repository } from "../src/repository";
import { AggregateRoot } from "../src/aggregates/aggregate-root";
import type { AnyEvent, EventEnvelope, EventStore, Transaction, UnitOfWork } from "../src/types";

type E = { type: "Inc"; version: 1; by: number };
type S = { n: number };

class Counter extends AggregateRoot<S, E> {
  protected handlers = { Inc: (s, e) => { s.n += e.by; } };
  constructor(id: string, snap?: S) { super(id, snap ?? { n: 0 }); }
  inc(by: number) { this.raise({ type: "Inc", version: 1, by }); }
}

class MemTx implements Transaction {}

class MemUow implements UnitOfWork<MemTx> {
  async withTransaction<T>(fn: (tx: MemTx) => Promise<T>): Promise<T> {
    return fn(new MemTx());
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
    if (lastVersion !== expected) throw new Error("Concurrency");

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

describe("Repository", () => {
  it("binds aggregateName once and saves/loads", async () => {
    const repo = new Repository<Counter, S, E, MemTx>(
      "Counter",
      new MemUow(),
      new MemStore(),
      (id, snap) => new Counter(id, snap),
      { snapshotPolicy: { everyNEvents: 0 } }
    );

    const c = await repo.load("a");
    c.inc(2);
    await repo.save(c);

    const c2 = await repo.load("a");
    expect(c2.state.n).toBe(2);
    expect(c2.version).toBe(1);
  });
});
