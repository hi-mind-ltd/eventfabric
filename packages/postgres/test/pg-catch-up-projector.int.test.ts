import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import type { EventEnvelope } from "@eventfabric/core";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { PgProjectionCheckpointStore } from "../src/projections/pg-projection-checkpoint-store";
import { createCatchUpProjector } from "../src/projections/pg-catch-up-projector";
import { migrate } from "../src/pg-migrator";

type E = { type: "A"; version: 1; n: number };

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

describe("PgCatchUpProjector", () => {
  beforeEach(async () => {
    // Clean up before each test
    await pool.query(`DELETE FROM eventfabric.projection_checkpoints`);
    await pool.query(`DELETE FROM eventfabric.stream_versions`);
    await pool.query(`DELETE FROM eventfabric.events`);
  }, 60000);

  it("catches up a projection from the beginning", async () => {
    const uow = new PgUnitOfWork(pool);
    const eventStore = new PgEventStore<E>();
    const projector = createCatchUpProjector<E>(pool, eventStore);

    // Create some events
    await uow.withTransaction(async (tx) => {
      await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u1",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 1 }]
      });
      await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u2",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 2 }]
      });
    });

    const handled: EventEnvelope<E>[] = [];
    const projection = {
      name: "test-projection",
      async handle(tx: any, env: any) {
        handled.push(env);
      }
    };

    await projector.catchUpProjection(projection);

    expect(handled).toHaveLength(2);
    expect(handled[0]!.payload.n).toBe(1);
    expect(handled[1]!.payload.n).toBe(2);

    // Verify checkpoint was updated
    const checkpoints = new PgProjectionCheckpointStore();
    const cp = await uow.withTransaction(async (tx) => {
      return checkpoints.get(tx, "test-projection");
    });
    expect(cp.lastGlobalPosition).toBeGreaterThan(0n);
  });

  it("respects batchSize option", async () => {
    const uow = new PgUnitOfWork(pool);
    const eventStore = new PgEventStore<E>();
    const projector = createCatchUpProjector<E>(pool, eventStore);

    // Create 5 events
    await uow.withTransaction(async (tx) => {
      for (let i = 1; i <= 5; i++) {
        await eventStore.append(tx, {
          aggregateName: "User",
          aggregateId: `u${i}`,
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: i }]
        });
      }
    });

    const handled: EventEnvelope<E>[] = [];
    const projection = {
      name: "batch-test",
      async handle(tx: any, env: any) {
        handled.push(env);
      }
    };

    // Process with batchSize of 2
    await projector.catchUpProjection(projection, { batchSize: 2 });

    expect(handled).toHaveLength(5);
    // Should process in batches of 2
    expect(handled.map(h => h.payload.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("respects maxBatches option", async () => {
    const uow = new PgUnitOfWork(pool);
    const eventStore = new PgEventStore<E>();
    const projector = createCatchUpProjector<E>(pool, eventStore);

    // Create 10 events
    await uow.withTransaction(async (tx) => {
      for (let i = 1; i <= 10; i++) {
        await eventStore.append(tx, {
          aggregateName: "User",
          aggregateId: `u${i}`,
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: i }]
        });
      }
    });

    const handled: EventEnvelope<E>[] = [];
    const projection = {
      name: "max-batches-test",
      async handle(tx: any, env: any) {
        handled.push(env);
      }
    };

    // Process with maxBatches of 2 and batchSize of 3
    await projector.catchUpProjection(projection, { batchSize: 3, maxBatches: 2 });

    // Should only process 2 batches * 3 events = 6 events
    expect(handled).toHaveLength(6);
    expect(handled.map(h => h.payload.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("skips dismissed events when includeDismissed is false", async () => {
    const uow = new PgUnitOfWork(pool);
    const eventStore = new PgEventStore<E>();
    const projector = createCatchUpProjector<E>(pool, eventStore);

    // Create events
    let eventIds: string[] = [];
    await uow.withTransaction(async (tx) => {
      const r1 = await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u1",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 1 }]
      });
      const r2 = await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u2",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 2 }]
      });
      eventIds = [r1.appended[0]!.eventId, r2.appended[0]!.eventId];
    });

    // Dismiss one event
    await uow.withTransaction(async (tx) => {
      await eventStore.dismiss(tx, eventIds[0]!, { reason: "test", by: "admin" });
    });

    const handled: EventEnvelope<E>[] = [];
    const projection = {
      name: "dismissed-test",
      async handle(tx: any, env: any) {
        handled.push(env);
      }
    };

    // Process without includeDismissed
    await projector.catchUpProjection(projection, { includeDismissed: false });

    // Should only handle the non-dismissed event
    expect(handled).toHaveLength(1);
    expect(handled[0]!.payload.n).toBe(2);
  });

  it("includes dismissed events when includeDismissed is true", async () => {
    const uow = new PgUnitOfWork(pool);
    const eventStore = new PgEventStore<E>();
    const projector = createCatchUpProjector<E>(pool, eventStore);

    // Create events
    let eventIds: string[] = [];
    await uow.withTransaction(async (tx) => {
      const r1 = await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u1",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 1 }]
      });
      const r2 = await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u2",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 2 }]
      });
      eventIds = [r1.appended[0]!.eventId, r2.appended[0]!.eventId];
    });

    // Dismiss one event
    await uow.withTransaction(async (tx) => {
      await eventStore.dismiss(tx, eventIds[0]!, { reason: "test", by: "admin" });
    });

    const handled: EventEnvelope<E>[] = [];
    const projection = {
      name: "include-dismissed-test",
      async handle(tx: any, env: any) {
        handled.push(env);
      }
    };

    // Process with includeDismissed
    await projector.catchUpProjection(projection, { includeDismissed: true });

    // Should handle both events
    expect(handled).toHaveLength(2);
    expect(handled.some(h => h.dismissed)).toBe(true);
  });

  it("resumes from checkpoint position", async () => {
    const uow = new PgUnitOfWork(pool);
    const checkpoints = new PgProjectionCheckpointStore();
    const eventStore = new PgEventStore<E>();
    const projector = createCatchUpProjector<E>(pool, eventStore);

    // Create initial events
    let firstGlobalPos: bigint = 0n;
    await uow.withTransaction(async (tx) => {
      const r1 = await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u1",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 1 }]
      });
      firstGlobalPos = r1.appended[0]!.globalPosition;
      
      await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u2",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 2 }]
      });
    });

    // Set checkpoint to first event
    await uow.withTransaction(async (tx) => {
      await checkpoints.set(tx, "resume-test", firstGlobalPos);
    });

    const handled: EventEnvelope<E>[] = [];
    const projection = {
      name: "resume-test",
      async handle(tx: any, env: any) {
        handled.push(env);
      }
    };

    // Catch up should only process events after the checkpoint
    await projector.catchUpProjection(projection);

    // Should only handle the second event
    expect(handled).toHaveLength(1);
    expect(handled[0]!.payload.n).toBe(2);
  });

  it("catches up multiple projections with catchUpAll", async () => {
    const uow = new PgUnitOfWork(pool);
    const checkpoints = new PgProjectionCheckpointStore();
    const eventStore = new PgEventStore<E>();
    const projector = createCatchUpProjector<E>(pool, eventStore);

    // Create events
    await uow.withTransaction(async (tx) => {
      await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u1",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 1 }]
      });
      await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u2",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 2 }]
      });
    });

    const handled1: EventEnvelope<E>[] = [];
    const handled2: EventEnvelope<E>[] = [];
    
    const projection1 = {
      name: "multi-1",
      async handle(tx: any, env: any) {
        handled1.push(env);
      }
    };

    const projection2 = {
      name: "multi-2",
      async handle(tx: any, env: any) {
        handled2.push(env);
      }
    };

    await projector.catchUpAll([projection1, projection2]);

    expect(handled1).toHaveLength(2);
    expect(handled2).toHaveLength(2);
    
    // Verify both checkpoints were updated
    const cp1 = await uow.withTransaction(async (tx) => {
      return checkpoints.get(tx, "multi-1");
    });
    const cp2 = await uow.withTransaction(async (tx) => {
      return checkpoints.get(tx, "multi-2");
    });
    expect(cp1.lastGlobalPosition).toBeGreaterThan(0n);
    expect(cp2.lastGlobalPosition).toBeGreaterThan(0n);
  });

  it("handles empty event store", async () => {
    const eventStore = new PgEventStore<E>();
    const projector = createCatchUpProjector<E>(pool, eventStore);

    const handled: EventEnvelope<E>[] = [];
    const projection = {
      name: "empty-test",
      async handle(tx: any, env: any) {
        handled.push(env);
      }
    };

    await projector.catchUpProjection(projection);

    expect(handled).toHaveLength(0);
  });

  it("updates checkpoint to last processed event", async () => {
    const uow = new PgUnitOfWork(pool);
    const eventStore = new PgEventStore<E>();
    const projector = createCatchUpProjector<E>(pool, eventStore);

    // Create 3 events
    let lastGlobalPos: bigint = 0n;
    await uow.withTransaction(async (tx) => {
      await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u1",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 1 }]
      });
      const r2 = await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u2",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 2 }]
      });
      const r3 = await eventStore.append(tx, {
        aggregateName: "User",
        aggregateId: "u3",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 3 }]
      });
      lastGlobalPos = r3.appended[0]!.globalPosition;
    });

    const projection = {
      name: "checkpoint-test",
      async handle(tx: any, env: any) {
        // Do nothing
      }
    };

    await projector.catchUpProjection(projection);

    // Verify checkpoint is set to last event's global position
    const checkpoints = new PgProjectionCheckpointStore();
    const cp = await uow.withTransaction(async (tx) => {
      return checkpoints.get(tx, "checkpoint-test");
    });
    expect(cp.lastGlobalPosition).toBe(lastGlobalPos);
  });
});

