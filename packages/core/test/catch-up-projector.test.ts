import { describe, it, expect, beforeEach } from "vitest";
import { CatchUpProjector, type TenantScopedUnitOfWorkFactory } from "../src/projections/catch-up-projector";
import type { EventEnvelope, Transaction, UnitOfWork, EventStore } from "../src/types";
import type { ProjectionCheckpointStore, ProjectionCheckpoint } from "../src/projections/projection-checkpoint-store";
import type { CatchUpProjection } from "../src/projections/catch-up-projection";

type E = { type: "TestEvent"; version: 1; value: string };

// Mock implementations
type MockTx = Transaction & { tenantId: string };

class MockUowFactory implements TenantScopedUnitOfWorkFactory<MockTx> {
  forTenant(tenantId: string): UnitOfWork<MockTx> {
    return {
      async withTransaction<T>(fn: (tx: MockTx) => Promise<T>): Promise<T> {
        return fn({ tenantId });
      }
    };
  }
  narrow(tx: MockTx, tenantId: string): MockTx {
    return { ...tx, tenantId };
  }
}

class MockEventStore implements EventStore<E, MockTx> {
  events: EventEnvelope<E>[] = [];
  loadGlobalCalls: Array<{ fromGlobalPositionExclusive: bigint; limit: number; includeDismissed?: boolean; tenantId?: string }> = [];

  async loadGlobal(
    tx: MockTx,
    params: { fromGlobalPositionExclusive: bigint; limit: number; includeDismissed?: boolean; tenantId?: string }
  ): Promise<EventEnvelope<E>[]> {
    this.loadGlobalCalls.push(params);
    return this.events
      .filter((e) => e.globalPosition > params.fromGlobalPositionExclusive)
      .filter((e) => params.tenantId === undefined || e.tenantId === params.tenantId)
      .slice(0, params.limit);
  }

  async discoverActiveTenants(
    _tx: MockTx,
    params: { fromGlobalPositionExclusive: bigint; limit?: number }
  ): Promise<string[]> {
    const tenants = new Set<string>();
    for (const e of this.events) {
      if (e.globalPosition > params.fromGlobalPositionExclusive) tenants.add(e.tenantId);
    }
    return [...tenants].sort();
  }

  // Not used in tests, but required by interface
  async append(): Promise<{ appended: EventEnvelope<E>[]; nextAggregateVersion: number }> {
    return { appended: [], nextAggregateVersion: 0 };
  }
  async loadStream(): Promise<EventEnvelope<E>[]> { return []; }
  async loadByGlobalPositions(): Promise<EventEnvelope<E>[]> { return []; }
  async dismiss(): Promise<void> {}
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

describe("CatchUpProjector", () => {
  let uow: MockUowFactory;
  let eventStore: MockEventStore;
  let checkpoints: MockCheckpointStore;
  let projector: CatchUpProjector<E, MockTx>;
  
  beforeEach(() => {
    uow = new MockUowFactory();
    eventStore = new MockEventStore();
    checkpoints = new MockCheckpointStore();
    projector = new CatchUpProjector(uow, eventStore, checkpoints);
  });
  
  describe("catchUpProjection", () => {
    it("processes events from checkpoint forward", async () => {
      const handled: EventEnvelope<E>[] = [];
      const projection: CatchUpProjection<E, MockTx> = {
        name: "test-proj",
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env);
        }
      };
      
      // Setup events
      eventStore.events = [
        {
          globalPosition: 1n,
          payload: { type: "TestEvent", version: 1, value: "event1" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 1,
          occurredAt: new Date().toISOString(),
          dismissed: false
        },
        {
          globalPosition: 2n,
          payload: { type: "TestEvent", version: 1, value: "event2" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 2,
          occurredAt: new Date().toISOString(),
          dismissed: false
        }
      ];
      
      await projector.catchUpProjection(projection);
      
      expect(handled).toHaveLength(2);
      expect(handled[0]!.payload.value).toBe("event1");
      expect(handled[1]!.payload.value).toBe("event2");
      expect(checkpoints.checkpoints.get("test-proj" + "|default")?.lastGlobalPosition).toBe(2n);
    });
    
    it("starts from checkpoint position", async () => {
      const handled: EventEnvelope<E>[] = [];
      const projection: CatchUpProjection<E, MockTx> = {
        name: "test-proj",
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env);
        }
      };
      
      // Set checkpoint to 1
      await checkpoints.set(({ tenantId: "default" }), "test-proj", "default", 1n);
      
      eventStore.events = [
        {
          globalPosition: 1n,
          payload: { type: "TestEvent", version: 1, value: "event1" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 1,
          occurredAt: new Date().toISOString(),
          dismissed: false
        },
        {
          globalPosition: 2n,
          payload: { type: "TestEvent", version: 1, value: "event2" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 2,
          occurredAt: new Date().toISOString(),
          dismissed: false
        }
      ];
      
      await projector.catchUpProjection(projection);
      
      expect(handled).toHaveLength(1);
      expect(handled[0]!.payload.value).toBe("event2"); // Only event after checkpoint
      expect(checkpoints.checkpoints.get("test-proj" + "|default")?.lastGlobalPosition).toBe(2n);
    });
    
    it("processes events in batches", async () => {
      const handled: EventEnvelope<E>[] = [];
      const projection: CatchUpProjection<E, MockTx> = {
        name: "test-proj",
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env);
        }
      };
      
      // Create 1000 events
      eventStore.events = Array.from({ length: 1000 }, (_, i) => ({
        globalPosition: BigInt(i + 1),
        payload: { type: "TestEvent", version: 1, value: `event${i + 1}` },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: i + 1,
        occurredAt: new Date().toISOString(),
        dismissed: false
      }));
      
      await projector.catchUpProjection(projection, { batchSize: 100 });
      
      expect(handled).toHaveLength(1000);
      expect(eventStore.loadGlobalCalls.length).toBeGreaterThan(1); // Multiple batches
    });
    
    it("respects maxBatches limit", async () => {
      const handled: EventEnvelope<E>[] = [];
      const projection: CatchUpProjection<E, MockTx> = {
        name: "test-proj",
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env);
        }
      };
      
      // Create 1000 events
      eventStore.events = Array.from({ length: 1000 }, (_, i) => ({
        globalPosition: BigInt(i + 1),
        payload: { type: "TestEvent", version: 1, value: `event${i + 1}` },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: i + 1,
        occurredAt: new Date().toISOString(),
        dismissed: false
      }));
      
      await projector.catchUpProjection(projection, { batchSize: 100, maxBatches: 2 });
      
      expect(handled).toHaveLength(200); // Only 2 batches
      expect(eventStore.loadGlobalCalls.length).toBe(2);
    });
    
    it("skips dismissed events when includeDismissed is false", async () => {
      const handled: EventEnvelope<E>[] = [];
      const projection: CatchUpProjection<E, MockTx> = {
        name: "test-proj",
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env);
        }
      };
      
      eventStore.events = [
        {
          globalPosition: 1n,
          payload: { type: "TestEvent", version: 1, value: "event1" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 1,
          occurredAt: new Date().toISOString(),
          dismissed: false
        },
        {
          globalPosition: 2n,
          payload: { type: "TestEvent", version: 1, value: "event2" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 2,
          occurredAt: new Date().toISOString(),
          dismissed: true
        },
        {
          globalPosition: 3n,
          payload: { type: "TestEvent", version: 1, value: "event3" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 3,
          occurredAt: new Date().toISOString(),
          dismissed: false
        }
      ];
      
      await projector.catchUpProjection(projection, { includeDismissed: false });
      
      expect(handled).toHaveLength(2);
      expect(handled[0]!.payload.value).toBe("event1");
      expect(handled[1]!.payload.value).toBe("event3");
    });
    
    it("processes dismissed events when includeDismissed is true", async () => {
      const handled: EventEnvelope<E>[] = [];
      const projection: CatchUpProjection<E, MockTx> = {
        name: "test-proj",
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env);
        }
      };
      
      eventStore.events = [
        {
          globalPosition: 1n,
          payload: { type: "TestEvent", version: 1, value: "event1" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 1,
          occurredAt: new Date().toISOString(),
          dismissed: false
        },
        {
          globalPosition: 2n,
          payload: { type: "TestEvent", version: 1, value: "event2" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 2,
          occurredAt: new Date().toISOString(),
          dismissed: true
        }
      ];
      
      await projector.catchUpProjection(projection, { includeDismissed: true });
      
      expect(handled).toHaveLength(2);
      expect(handled[0]!.payload.value).toBe("event1");
      expect(handled[1]!.payload.value).toBe("event2");
    });
    
    it("stops when no more events", async () => {
      const handled: EventEnvelope<E>[] = [];
      const projection: CatchUpProjection<E, MockTx> = {
        name: "test-proj",
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled.push(env);
        }
      };
      
      eventStore.events = [
        {
          globalPosition: 1n,
          payload: { type: "TestEvent", version: 1, value: "event1" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 1,
          occurredAt: new Date().toISOString(),
          dismissed: false
        }
      ];
      
      await projector.catchUpProjection(projection);
      
      expect(handled).toHaveLength(1);
      expect(eventStore.loadGlobalCalls.length).toBe(2); // Initial load + empty load to stop
    });
    
    it("uses default batch size of 500", async () => {
      const projection: CatchUpProjection<E, MockTx> = {
        name: "test-proj",
        async handle() {}
      };
      
      eventStore.events = Array.from({ length: 1000 }, (_, i) => ({
        globalPosition: BigInt(i + 1),
        payload: { type: "TestEvent", version: 1, value: `event${i + 1}` },
        tenantId: "default",

        aggregateName: "A",
        aggregateId: "1",
        aggregateVersion: i + 1,
        occurredAt: new Date().toISOString(),
        dismissed: false
      }));
      
      await projector.catchUpProjection(projection);
      
      // Should use batch size of 500
      expect(eventStore.loadGlobalCalls[0]!.limit).toBe(500);
    });
  });
  
  describe("catchUpAll", () => {
    it("catches up multiple projections sequentially", async () => {
      const handled1: EventEnvelope<E>[] = [];
      const handled2: EventEnvelope<E>[] = [];
      
      const projection1: CatchUpProjection<E, MockTx> = {
        name: "proj1",
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled1.push(env);
        }
      };
      
      const projection2: CatchUpProjection<E, MockTx> = {
        name: "proj2",
        async handle(tx: MockTx, env: EventEnvelope<E>) {
          handled2.push(env);
        }
      };
      
      eventStore.events = [
        {
          globalPosition: 1n,
          payload: { type: "TestEvent", version: 1, value: "event1" },
          tenantId: "default",

          aggregateName: "A",
          aggregateId: "1",
          aggregateVersion: 1,
          occurredAt: new Date().toISOString(),
          dismissed: false
        }
      ];
      
      await projector.catchUpAll([projection1, projection2]);
      
      expect(handled1).toHaveLength(1);
      expect(handled2).toHaveLength(1);
      expect(checkpoints.checkpoints.get("proj1" + "|default")?.lastGlobalPosition).toBe(1n);
      expect(checkpoints.checkpoints.get("proj2" + "|default")?.lastGlobalPosition).toBe(1n);
    });
  });
});

