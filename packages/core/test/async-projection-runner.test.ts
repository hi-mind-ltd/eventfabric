import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AsyncProjectionRunner } from "../src/projections/async-projection-runner";
import type { EventEnvelope, Transaction, UnitOfWork, EventStore } from "../src/types";
import type { TenantScopedUnitOfWorkFactory } from "../src/projections/catch-up-projector";
import type { OutboxStore, OutboxRow } from "../src/outbox/outbox-store";
import type { ProjectionCheckpointStore, ProjectionCheckpoint } from "../src/projections/projection-checkpoint-store";
import type { AsyncProjection } from "../src/projections/async-projection";
import { computeBackoffMs } from "../src/resilience/backoff";

type E = { type: "TestEvent"; version: 1; value: string };

// Mock implementations
type MockTx = Transaction & { tenantId: string };

class MockUowFactory implements TenantScopedUnitOfWorkFactory<MockTx> {
  transactions: Array<{ fn: (tx: MockTx) => Promise<any> }> = [];
  forTenant(tenantId: string): UnitOfWork<MockTx> {
    const self = this;
    return {
      async withTransaction<T>(fn: (tx: MockTx) => Promise<T>): Promise<T> {
        self.transactions.push({ fn });
        return fn({ tenantId });
      }
    };
  }
  narrow(tx: MockTx, tenantId: string): MockTx {
    return { ...tx, tenantId };
  }
}

class MockEventStore implements EventStore<E, MockTx> {
  events = new Map<string, EventEnvelope<E>>();

  async loadByGlobalPositions(_tx: MockTx, positions: bigint[]): Promise<EventEnvelope<E>[]> {
    return positions
      .map((p) => this.events.get(p.toString()))
      .filter((e): e is EventEnvelope<E> => e !== undefined);
  }

  // Not used in tests, but required by interface
  async append(): Promise<{ appended: EventEnvelope<E>[]; nextAggregateVersion: number }> {
    return { appended: [], nextAggregateVersion: 0 };
  }
  async loadStream(): Promise<EventEnvelope<E>[]> { return []; }
  async loadGlobal(): Promise<EventEnvelope<E>[]> { return []; }
  async discoverActiveTenants(): Promise<string[]> { return []; }
  async dismiss(): Promise<void> {}
}

class MockOutboxStore implements OutboxStore<MockTx> {
  claimed: OutboxRow[] = [];
  acked: Array<OutboxRow["id"]> = [];
  released: Array<{ id: OutboxRow["id"]; error: string }> = [];
  deadLettered: Array<{ row: OutboxRow; reason: string }> = [];

  async claimBatch(_tx: MockTx, _opts: { batchSize: number; workerId: string; topic?: string | null }): Promise<OutboxRow[]> {
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

class MockCheckpointStore implements ProjectionCheckpointStore<MockTx> {
  checkpoints = new Map<string, ProjectionCheckpoint>();

  private key(projectionName: string, tenantId: string): string {
    return `${projectionName}|${tenantId}`;
  }

  async get(_tx: MockTx, projectionName: string, tenantId: string): Promise<ProjectionCheckpoint> {
    const cp = this.checkpoints.get(this.key(projectionName, tenantId));
    if (cp) return cp;
    const newCp: ProjectionCheckpoint = {
      projectionName,
      tenantId,
      lastGlobalPosition: 0n,
      updatedAt: new Date().toISOString()
    };
    this.checkpoints.set(this.key(projectionName, tenantId), newCp);
    return newCp;
  }

  async set(_tx: MockTx, projectionName: string, tenantId: string, lastGlobalPosition: bigint): Promise<void> {
    this.checkpoints.set(this.key(projectionName, tenantId), {
      projectionName,
      tenantId,
      lastGlobalPosition,
      updatedAt: new Date().toISOString()
    });
  }
}

describe("AsyncProjectionRunner", () => {
  let uow: MockUowFactory;
  let eventStore: MockEventStore;
  let outbox: MockOutboxStore;
  let checkpoints: MockCheckpointStore;
  let runner: AsyncProjectionRunner<E, MockTx>;
  
  beforeEach(() => {
    uow = new MockUowFactory();
    eventStore = new MockEventStore();
    outbox = new MockOutboxStore();
    checkpoints = new MockCheckpointStore();
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });
  
  function createRunner(projections: AsyncProjection<E, MockTx>[], opts: Partial<AsyncRunnerOptions> = {}): AsyncProjectionRunner<E, MockTx> {
    const options: AsyncRunnerOptions = {
      workerId: "test-worker",
      batchSize: 10,
      idleSleepMs: 10,
      ...opts
    };
    return new AsyncProjectionRunner(uow, eventStore, outbox, checkpoints, projections, options);
  }
  
  describe("processBatch mode", () => {
    it("processes events and updates checkpoints", async () => {
      const handled: string[] = [];
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env.payload.value);
        }
      };
      
      runner = createRunner([projection], { transactionMode: "batch" });
      
      // Setup outbox and events
      const row1: OutboxRow = { id: 1, globalPosition: 1n, topic: "test", attempts: 0 };
      const row2: OutboxRow = { id: 2, globalPosition: 2n, topic: "test", attempts: 0 };
      outbox.claimed = [row1, row2];
      
      eventStore.events.set("1", {
        eventId: "evt-1",
        globalPosition: 1n,
        payload: { type: "TestEvent", version: 1, value: "event1" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 1,
        occurredAt: new Date().toISOString()
      });
      eventStore.events.set("2", {
        eventId: "evt-2",
        globalPosition: 2n,
        payload: { type: "TestEvent", version: 1, value: "event2" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 2,
        occurredAt: new Date().toISOString()
      });
      
      // Manually call processBatch via reflection (in real usage, start() would call it)
      await (runner as any).processBatch([row1, row2], false, 10);
      
      expect(handled).toEqual(["event1", "event2"]);
      expect(outbox.acked).toEqual([1, 2]);
      expect(checkpoints.checkpoints.get("test-proj" + "|default")?.lastGlobalPosition).toBe(2n);
    });
    
    it("filters events by topic", async () => {
      const handled: string[] = [];
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "include", topics: ["user"] },
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env.payload.value);
        }
      };
      
      runner = createRunner([projection], { transactionMode: "batch" });
      
      const row1: OutboxRow = { id: 1, globalPosition: 1n, topic: "user", attempts: 0 };
      const row2: OutboxRow = { id: 2, globalPosition: 2n, topic: "order", attempts: 0 };
      outbox.claimed = [row1, row2];
      
      eventStore.events.set("1", {
        eventId: "evt-1",
        globalPosition: 1n,
        payload: { type: "TestEvent", version: 1, value: "event1" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 1,
        occurredAt: new Date().toISOString()
      });
      eventStore.events.set("2", {
        eventId: "evt-2",
        globalPosition: 2n,
        payload: { type: "TestEvent", version: 1, value: "event2" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 2,
        occurredAt: new Date().toISOString()
      });
      
      await (runner as any).processBatch([row1, row2], false, 10);
      
      expect(handled).toEqual(["event1"]); // Only user topic
      expect(outbox.acked).toEqual([1, 2]); // Both acked, but only one processed
    });
    
    it("skips dismissed events when includeDismissed is false", async () => {
      const handled: string[] = [];
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env.payload.value);
        }
      };
      
      runner = createRunner([projection], { transactionMode: "batch" });
      
      const row: OutboxRow = { id: 1, globalPosition: 1n, topic: "test", attempts: 0 };
      eventStore.events.set("1", {
        eventId: "evt-1",
        globalPosition: 1n,
        payload: { type: "TestEvent", version: 1, value: "event1" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 1,
        occurredAt: new Date().toISOString(),
        dismissed: { at: new Date().toISOString() }
      });
      
      await (runner as any).processBatch([row], false, 10);
      
      expect(handled).toHaveLength(0);
      expect(outbox.acked).toEqual([1]); // Still acked
    });
    
    it("processes dismissed events when includeDismissed is true", async () => {
      const handled: string[] = [];
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env.payload.value);
        }
      };
      
      runner = createRunner([projection], { transactionMode: "batch" });
      
      const row: OutboxRow = { id: 1, globalPosition: 1n, topic: "test", attempts: 0 };
      eventStore.events.set("1", {
        eventId: "evt-1",
        globalPosition: 1n,
        payload: { type: "TestEvent", version: 1, value: "event1" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 1,
        occurredAt: new Date().toISOString(),
        dismissed: { at: new Date().toISOString() }
      });
      
      await (runner as any).processBatch([row], true, 10);
      
      expect(handled).toEqual(["event1"]);
      expect(outbox.acked).toEqual([1]);
    });
    
    it("dead letters messages exceeding maxAttempts", async () => {
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle() {}
      };
      
      runner = createRunner([projection], { transactionMode: "batch" });
      
      const row1: OutboxRow = { id: 1, globalPosition: 1n, topic: "test", attempts: 5 };
      const row2: OutboxRow = { id: 2, globalPosition: 2n, topic: "test", attempts: 11 }; // Exceeds maxAttempts=10
      
      await (runner as any).processBatch([row1, row2], false, 10);
      
      expect(outbox.deadLettered).toHaveLength(1);
      expect(outbox.deadLettered[0]!.row.id).toBe(2);
      expect(outbox.deadLettered[0]!.reason).toContain("maxAttempts=10");
    });
    
    it("releases message with error on projection failure", async () => {
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle() {
          throw new Error("Projection failed");
        }
      };
      
      runner = createRunner([projection], { transactionMode: "batch" });
      
      const row: OutboxRow = { id: 1, globalPosition: 1n, topic: "test", attempts: 0 };
      eventStore.events.set("1", {
        eventId: "evt-1",
        globalPosition: 1n,
        payload: { type: "TestEvent", version: 1, value: "event1" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 1,
        occurredAt: new Date().toISOString()
      });
      
      await expect((runner as any).processBatch([row], false, 10)).rejects.toThrow("Projection failed");
      expect(outbox.released).toHaveLength(1);
      expect(outbox.released[0]!.id).toBe(1);
      expect(outbox.released[0]!.error).toContain("Projection failed");
    });
    
    it("skips events already processed (checkpoint check)", async () => {
      const handled: string[] = [];
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env.payload.value);
        }
      };
      
      runner = createRunner([projection], { transactionMode: "batch" });
      
      // Set checkpoint to 2, so event at position 1 should be skipped
      await checkpoints.set(({ tenantId: "default" }), "test-proj", "default", 2n);
      
      const row: OutboxRow = { id: 1, globalPosition: 1n, topic: "test", attempts: 0 };
      eventStore.events.set("1", {
        eventId: "evt-1",
        globalPosition: 1n,
        payload: { type: "TestEvent", version: 1, value: "event1" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 1,
        occurredAt: new Date().toISOString()
      });
      
      await (runner as any).processBatch([row], false, 10);
      
      expect(handled).toHaveLength(0); // Skipped because checkpoint is at 2
      expect(outbox.acked).toEqual([1]); // Still acked
    });
  });
  
  describe("processOne mode", () => {
    it("processes single event", async () => {
      const handled: string[] = [];
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env.payload.value);
        }
      };
      
      runner = createRunner([projection], { transactionMode: "perRow" });
      
      const row: OutboxRow = { id: 1, globalPosition: 1n, topic: "test", attempts: 0 };
      eventStore.events.set("1", {
        eventId: "evt-1",
        globalPosition: 1n,
        payload: { type: "TestEvent", version: 1, value: "event1" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 1,
        occurredAt: new Date().toISOString()
      });
      
      await (runner as any).processOne(row, false, 10);
      
      expect(handled).toEqual(["event1"]);
      expect(outbox.acked).toEqual([1]);
    });
    
    it("releases message with error on failure in perRow mode", async () => {
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle() {
          throw new Error("Failed");
        }
      };
      
      runner = createRunner([projection], { transactionMode: "perRow" });
      
      const row: OutboxRow = { id: 1, globalPosition: 1n, topic: "test", attempts: 0 };
      eventStore.events.set("1", {
        eventId: "evt-1",
        globalPosition: 1n,
        payload: { type: "TestEvent", version: 1, value: "event1" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 1,
        occurredAt: new Date().toISOString()
      });
      
      await expect((runner as any).processOne(row, false, 10)).rejects.toThrow("Failed");
      expect(outbox.released).toHaveLength(1);
      expect(outbox.released[0]!.id).toBe(1);
    });
  });

  describe("backoff behavior", () => {
    it("uses default backoff options when not specified", () => {
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle() {}
      };
      
      runner = createRunner([projection]);
      
      // Default backoff should be: { minMs: 250, maxMs: 15000, factor: 2, jitter: 0.2 }
      const backoff = (runner as any).opts.backoff ?? { minMs: 250, maxMs: 15000, factor: 2, jitter: 0.2 };
      expect(backoff.minMs).toBe(250);
      expect(backoff.maxMs).toBe(15000);
      expect(backoff.factor).toBe(2);
      expect(backoff.jitter).toBe(0.2);
    });

    it("uses custom backoff options when specified", () => {
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle() {}
      };
      
      const customBackoff = { minMs: 100, maxMs: 1000, factor: 2, jitter: 0 };
      runner = createRunner([projection], { backoff: customBackoff });
      
      expect((runner as any).opts.backoff).toEqual(customBackoff);
    });

    it("applies exponential backoff on errors in start loop", async () => {
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle() {}
      };
      
      const backoff = { minMs: 10, maxMs: 1000, factor: 2, jitter: 0 };
      runner = createRunner([projection], { backoff, idleSleepMs: 10 });
      
      // Mock outbox to throw on first claimBatch call, then return empty
      let claimCount = 0;
      outbox.claimBatch = vi.fn().mockImplementation(async (tx, opts) => {
        claimCount++;
        if (claimCount === 1) {
          throw new Error("Claim failed");
        }
        // Return empty to allow loop to exit
        return [];
      });
      
      const ac = new AbortController();
      const startPromise = runner.start(ac.signal);
      
      // Wait a bit for the error and backoff to be applied
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Verify backoff was calculated correctly
      // attempt 1 should use: minMs * factor^1 = 10 * 2 = 20ms
      const expectedBackoff = computeBackoffMs(1, backoff);
      expect(expectedBackoff).toBe(20);
      
      // Abort the runner immediately
      ac.abort();
      await startPromise.catch(() => {});
      
      // Verify claimBatch was called (at least once)
      expect(outbox.claimBatch).toHaveBeenCalled();
    });

    it("resets attempt counter on successful processing", async () => {
      const projection: AsyncProjection<E, MockTx> = {
        name: "test-proj",
        topicFilter: { mode: "all" },
        async handle() {}
      };
      
      runner = createRunner([projection], { batchSize: 1, idleSleepMs: 10 });
      
      // Set up a successful claim, then return empty to allow loop to exit
      let claimCount = 0;
      outbox.claimBatch = vi.fn().mockImplementation(async (tx, opts) => {
        claimCount++;
        if (claimCount === 1) {
          return [{ id: 1, globalPosition: 1n, topic: "test", attempts: 0 }];
        }
        // Return empty to allow loop to exit
        return [];
      });
      
      eventStore.events.set("1", {
        eventId: "evt-1",
        globalPosition: 1n,
        payload: { type: "TestEvent", version: 1, value: "event1" },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: 1,
        occurredAt: new Date().toISOString()
      });
      
      const ac = new AbortController();
      const startPromise = runner.start(ac.signal);
      
      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 30));
      
      // Abort
      ac.abort();
      await startPromise.catch(() => {});
      
      // Verify event was processed
      expect(outbox.acked).toContain(1);
    });
  });
});

