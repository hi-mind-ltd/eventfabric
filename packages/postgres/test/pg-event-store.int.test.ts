import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore, ConcurrencyError, RowShapeError } from "../src/pg-event-store";
import { migrate } from "../src/pg-migrator";
import type { AnyEvent } from "@eventfabric/core";

type E = { type: "A"; version: 1; n: number };

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);
}, 120000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

describe("PgEventStore", () => {
  beforeEach(async () => {
    // Clean up before each test
    await pool.query(`DELETE FROM eventfabric.outbox`);
    await pool.query(`DELETE FROM eventfabric.stream_versions`);
    await pool.query(`DELETE FROM eventfabric.events`);
  }, 60000);

  it("appends events with global ordering and enqueues outbox", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgEventStore<E>();

    const result = await uow.withTransaction(async (tx) => {
      return store.append(tx, {
        aggregateName: "User",
        aggregateId: "u1",
        expectedAggregateVersion: 0,
        events: [{ type: "A", version: 1, n: 1 }],
        enqueueOutbox: true,
        outboxTopic: "user"
      });
    });

    expect(result.nextAggregateVersion).toBe(1);
    expect(result.appended[0]!.globalPosition).toBeGreaterThan(0n);

    const outbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].topic).toBe("user");
  });

  describe("loadStream", () => {
    it("loads all events from a stream starting from version 1", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      // Append multiple events
      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [
            { type: "A", version: 1, n: 1 },
            { type: "A", version: 1, n: 2 },
            { type: "A", version: 1, n: 3 }
          ]
        });
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "u1" });
      });

      expect(events).toHaveLength(3);
      expect(events[0]!.aggregateVersion).toBe(1);
      expect(events[1]!.aggregateVersion).toBe(2);
      expect(events[2]!.aggregateVersion).toBe(3);
      expect(events[0]!.payload.n).toBe(1);
      expect(events[1]!.payload.n).toBe(2);
      expect(events[2]!.payload.n).toBe(3);
    });

    it("loads events from a specific version onwards", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [
            { type: "A", version: 1, n: 1 },
            { type: "A", version: 1, n: 2 },
            { type: "A", version: 1, n: 3 }
          ]
        });
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "u1", fromVersion: 2 });
      });

      expect(events).toHaveLength(2);
      expect(events[0]!.aggregateVersion).toBe(2);
      expect(events[1]!.aggregateVersion).toBe(3);
    });

    it("filters out dismissed events by default", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let eventIds: string[] = [];
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [
            { type: "A", version: 1, n: 1 },
            { type: "A", version: 1, n: 2 },
            { type: "A", version: 1, n: 3 }
          ]
        });
        eventIds = result.appended.map(e => e.eventId);
      });

      // Dismiss the middle event
      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, eventIds[1]!, { reason: "Test", by: "test-user" });
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "u1" });
      });

      expect(events).toHaveLength(2);
      expect(events[0]!.payload.n).toBe(1);
      expect(events[1]!.payload.n).toBe(3);
    });

    it("includes dismissed events when includeDismissed is true", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let eventIds: string[] = [];
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [
            { type: "A", version: 1, n: 1 },
            { type: "A", version: 1, n: 2 },
            { type: "A", version: 1, n: 3 }
          ]
        });
        eventIds = result.appended.map(e => e.eventId);
      });

      // Dismiss the middle event
      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, eventIds[1]!, { reason: "Test", by: "test-user" });
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "u1", includeDismissed: true });
      });

      expect(events).toHaveLength(3);
      expect(events[1]!.dismissed).toBeDefined();
      expect(events[1]!.dismissed?.reason).toBe("Test");
      expect(events[1]!.dismissed?.by).toBe("test-user");
    });

    it("returns empty array for non-existent stream", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "nonexistent" });
      });

      expect(events).toHaveLength(0);
    });

    it("loads events from different aggregates independently", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: 1 }]
        });
        await store.append(tx, {
          aggregateName: "Order",
          aggregateId: "o1",
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: 2 }]
        });
      });

      const userEvents = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "u1" });
      });

      const orderEvents = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "Order", aggregateId: "o1" });
      });

      expect(userEvents).toHaveLength(1);
      expect(orderEvents).toHaveLength(1);
      expect(userEvents[0]!.payload.n).toBe(1);
      expect(orderEvents[0]!.payload.n).toBe(2);
    });
  });

  describe("loadGlobal", () => {
    it("loads events from a global position", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let firstGlobalPos: bigint | undefined;
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [
            { type: "A", version: 1, n: 1 },
            { type: "A", version: 1, n: 2 }
          ]
        });
        firstGlobalPos = result.appended[0]!.globalPosition;
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadGlobal(tx, {
          fromGlobalPositionExclusive: firstGlobalPos!,
          limit: 10
        });
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.payload.n).toBe(2);
    });

    it("respects the limit parameter", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: Array.from({ length: 10 }, (_, i) => ({ type: "A", version: 1, n: i + 1 }))
        });
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadGlobal(tx, {
          fromGlobalPositionExclusive: 0n,
          limit: 5
        });
      });

      expect(events).toHaveLength(5);
    });

    it("filters out dismissed events by default", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let eventIds: string[] = [];
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [
            { type: "A", version: 1, n: 1 },
            { type: "A", version: 1, n: 2 },
            { type: "A", version: 1, n: 3 }
          ]
        });
        eventIds = result.appended.map(e => e.eventId);
      });

      // Dismiss the first event
      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, eventIds[0]!);
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadGlobal(tx, {
          fromGlobalPositionExclusive: 0n,
          limit: 10
        });
      });

      expect(events).toHaveLength(2);
      expect(events[0]!.payload.n).toBe(2);
      expect(events[1]!.payload.n).toBe(3);
    });

    it("includes dismissed events when includeDismissed is true", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let eventIds: string[] = [];
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [
            { type: "A", version: 1, n: 1 },
            { type: "A", version: 1, n: 2 }
          ]
        });
        eventIds = result.appended.map(e => e.eventId);
      });

      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, eventIds[0]!, { reason: "Test" });
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadGlobal(tx, {
          fromGlobalPositionExclusive: 0n,
          limit: 10,
          includeDismissed: true
        });
      });

      expect(events).toHaveLength(2);
      expect(events[0]!.dismissed).toBeDefined();
      expect(events[1]!.dismissed).toBeUndefined();
    });

    it("returns empty array when no events exist after position", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      const events = await uow.withTransaction(async (tx) => {
        return store.loadGlobal(tx, {
          fromGlobalPositionExclusive: 1000n,
          limit: 10
        });
      });

      expect(events).toHaveLength(0);
    });
  });

  describe("loadByGlobalPositions", () => {
    it("loads events by specific global positions", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let globalPositions: bigint[] = [];
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [
            { type: "A", version: 1, n: 1 },
            { type: "A", version: 1, n: 2 },
            { type: "A", version: 1, n: 3 }
          ]
        });
        globalPositions = result.appended.map(e => e.globalPosition);
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadByGlobalPositions(tx, [globalPositions[0]!, globalPositions[2]!]);
      });

      expect(events).toHaveLength(2);
      expect(events[0]!.payload.n).toBe(1);
      expect(events[1]!.payload.n).toBe(3);
    });

    it("returns events in ascending global position order", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let globalPositions: bigint[] = [];
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [
            { type: "A", version: 1, n: 1 },
            { type: "A", version: 1, n: 2 },
            { type: "A", version: 1, n: 3 }
          ]
        });
        globalPositions = result.appended.map(e => e.globalPosition);
      });

      // Request in reverse order
      const events = await uow.withTransaction(async (tx) => {
        return store.loadByGlobalPositions(tx, [globalPositions[2]!, globalPositions[0]!]);
      });

      expect(events).toHaveLength(2);
      expect(events[0]!.globalPosition).toBeLessThan(events[1]!.globalPosition);
    });

    it("returns empty array for empty positions array", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      const events = await uow.withTransaction(async (tx) => {
        return store.loadByGlobalPositions(tx, []);
      });

      expect(events).toHaveLength(0);
    });

    it("returns only existing events for non-existent positions", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let globalPos: bigint | undefined;
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: 1 }]
        });
        globalPos = result.appended[0]!.globalPosition;
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadByGlobalPositions(tx, [globalPos!, 9999n, 8888n]);
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.globalPosition).toBe(globalPos);
    });

    it("includes dismissed events (no filtering)", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let eventIds: string[] = [];
      let globalPositions: bigint[] = [];
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [
            { type: "A", version: 1, n: 1 },
            { type: "A", version: 1, n: 2 }
          ]
        });
        eventIds = result.appended.map(e => e.eventId);
        globalPositions = result.appended.map(e => e.globalPosition);
      });

      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, eventIds[0]!);
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadByGlobalPositions(tx, globalPositions);
      });

      expect(events).toHaveLength(2);
      expect(events[0]!.dismissed).toBeDefined();
      expect(events[1]!.dismissed).toBeUndefined();
    });
  });

  describe("dismiss", () => {
    it("dismisses an event with reason and by", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let eventId: string | undefined;
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: 1 }]
        });
        eventId = result.appended[0]!.eventId;
      });

      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, eventId!, { reason: "Invalid event", by: "admin" });
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "u1", includeDismissed: true });
      });

      expect(events).toHaveLength(1);
      expect(events[0]!.dismissed).toBeDefined();
      expect(events[0]!.dismissed?.reason).toBe("Invalid event");
      expect(events[0]!.dismissed?.by).toBe("admin");
      expect(events[0]!.dismissed?.at).toBeTruthy();
    });

    it("dismisses an event with custom timestamp", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let eventId: string | undefined;
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: 1 }]
        });
        eventId = result.appended[0]!.eventId;
      });

      const customTime = "2024-01-01T00:00:00.000Z";
      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, eventId!, { at: customTime, reason: "Test" });
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "u1", includeDismissed: true });
      });

      expect(events[0]!.dismissed?.at).toBe(customTime);
    });

    it("dismisses an event without reason or by", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      let eventId: string | undefined;
      await uow.withTransaction(async (tx) => {
        const result = await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: 1 }]
        });
        eventId = result.appended[0]!.eventId;
      });

      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, eventId!);
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "u1", includeDismissed: true });
      });

      expect(events[0]!.dismissed).toBeDefined();
      expect(events[0]!.dismissed?.reason).toBeUndefined();
      expect(events[0]!.dismissed?.by).toBeUndefined();
    });

    it("handles dismissing non-existent event gracefully", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      // Should not throw
      await uow.withTransaction(async (tx) => {
        await store.dismiss(tx, "00000000-0000-0000-0000-000000000000");
      });
    });
  });

  describe("concurrency error handling", () => {
    it("throws ConcurrencyError when expected version doesn't match", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      // First append succeeds
      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: 1 }]
        });
      });

      // Second append with wrong expected version should fail
      await expect(
        uow.withTransaction(async (tx) => {
          await store.append(tx, {
            aggregateName: "User",
            aggregateId: "u1",
            expectedAggregateVersion: 0, // Should be 1
            events: [{ type: "A", version: 1, n: 2 }]
          });
        })
      ).rejects.toThrow(ConcurrencyError);
    });

    it("ConcurrencyError has correct message", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: 1 }]
        });
      });

      try {
        await uow.withTransaction(async (tx) => {
          await store.append(tx, {
            aggregateName: "User",
            aggregateId: "u1",
            expectedAggregateVersion: 0,
            events: [{ type: "A", version: 1, n: 2 }]
          });
        });
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e).toBeInstanceOf(ConcurrencyError);
        expect(e.message).toContain("already exists");
      }
    });

    it("allows concurrent appends to different aggregates", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await Promise.all([
        uow.withTransaction(async (tx) => {
          await store.append(tx, {
            aggregateName: "User",
            aggregateId: "u1",
            expectedAggregateVersion: 0,
            events: [{ type: "A", version: 1, n: 1 }]
          });
        }),
        uow.withTransaction(async (tx) => {
          await store.append(tx, {
            aggregateName: "Order",
            aggregateId: "o1",
            expectedAggregateVersion: 0,
            events: [{ type: "A", version: 1, n: 2 }]
          });
        })
      ]);

      const userEvents = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "u1" });
      });

      const orderEvents = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "Order", aggregateId: "o1" });
      });

      expect(userEvents).toHaveLength(1);
      expect(orderEvents).toHaveLength(1);
    });

    // The append() path is check-then-insert under READ COMMITTED:
    //   1. SELECT MAX(aggregate_version) ...  (no locks)
    //   2. if (maxVersion !== expectedVersion) throw ConcurrencyError
    //   3. INSERT ...
    // Between (1) and (3), another tx can commit events at the same version.
    // The UNIQUE(aggregate_name, aggregate_id, aggregate_version) constraint
    // saves correctness — the second INSERT fails — but the failure surfaces
    // as a raw pg error (code 23505) instead of a ConcurrencyError. Callers
    // doing `err instanceof ConcurrencyError` silently miss half the race.
    it("surfaces concurrent same-version appends as ConcurrencyError (not raw pg 23505)", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      // Run the race many iterations to cover both resolution paths:
      //   - read-time check wins → ConcurrencyError (always worked)
      //   - insert-time unique constraint wins → previously raw pg 23505
      // Empirically ~97% of conflicts resolve at the INSERT path.
      const iterations = 30;

      for (let i = 0; i < iterations; i++) {
        const aggId = `race-${i}`;

        const results = await Promise.allSettled([
          uow.withTransaction((tx) =>
            store.append(tx, {
              aggregateName: "Race",
              aggregateId: aggId,
              expectedAggregateVersion: 0,
              events: [{ type: "A", version: 1, n: 1 }]
            })
          ),
          uow.withTransaction((tx) =>
            store.append(tx, {
              aggregateName: "Race",
              aggregateId: aggId,
              expectedAggregateVersion: 0,
              events: [{ type: "A", version: 1, n: 2 }]
            })
          )
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

        // UNIQUE constraint guarantees exactly one winner.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        // Both resolution paths must surface as ConcurrencyError.
        expect(rejected[0]!.reason).toBeInstanceOf(ConcurrencyError);

        // Store must be consistent: exactly one v1 event.
        const events = await uow.withTransaction((tx) =>
          store.loadStream(tx, { aggregateName: "Race", aggregateId: aggId })
        );
        expect(events).toHaveLength(1);
        expect(events[0]!.aggregateVersion).toBe(1);
      }
    }, 30000);

    it("allows sequential appends with correct version", async () => {
      const uow = new PgUnitOfWork(pool);
      const store = new PgEventStore<E>();

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 0,
          events: [{ type: "A", version: 1, n: 1 }]
        });
      });

      await uow.withTransaction(async (tx) => {
        await store.append(tx, {
          aggregateName: "User",
          aggregateId: "u1",
          expectedAggregateVersion: 1,
          events: [{ type: "A", version: 1, n: 2 }]
        });
      });

      const events = await uow.withTransaction(async (tx) => {
        return store.loadStream(tx, { aggregateName: "User", aggregateId: "u1" });
      });

      expect(events).toHaveLength(2);
    });
  });

  // Guards the SQL→domain boundary against schema drift / query typos / corrupt
  // rows. Without validation, a malformed payload would flow through as
  // EventEnvelope<E> and crash downstream projections with a confusing error.
  describe("row shape validation", () => {
    it("throws RowShapeError when payload is missing required discriminators", async () => {
      const store = new PgEventStore<E>();
      const uow = new PgUnitOfWork(pool);

      // Insert a row directly via SQL with a payload that is technically valid
      // JSONB but lacks the required `type` / `version` discriminators.
      await pool.query(
        `INSERT INTO eventfabric.events
          (event_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at)
         VALUES (gen_random_uuid(), 'Bad', 'bad-1', 1, 'A', 1, '{}'::jsonb, now())`
      );

      await expect(
        uow.withTransaction((tx) =>
          store.loadStream(tx, { aggregateName: "Bad", aggregateId: "bad-1" })
        )
      ).rejects.toBeInstanceOf(RowShapeError);
    });

    it("throws RowShapeError when payload is SQL NULL (non-object)", async () => {
      const store = new PgEventStore<E>();
      const uow = new PgUnitOfWork(pool);

      // Insert a row with payload stored as JSON null (valid JSONB, invalid domain shape)
      await pool.query(
        `INSERT INTO eventfabric.events
          (event_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at)
         VALUES (gen_random_uuid(), 'Bad', 'bad-2', 1, 'A', 1, 'null'::jsonb, now())`
      );

      await expect(
        uow.withTransaction((tx) =>
          store.loadStream(tx, { aggregateName: "Bad", aggregateId: "bad-2" })
        )
      ).rejects.toBeInstanceOf(RowShapeError);
    });

    it("error message identifies the offending field", async () => {
      const store = new PgEventStore<E>();
      const uow = new PgUnitOfWork(pool);

      await pool.query(
        `INSERT INTO eventfabric.events
          (event_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at)
         VALUES (gen_random_uuid(), 'Bad', 'bad-3', 1, 'A', 1, '{"type":"X"}'::jsonb, now())`
      );

      try {
        await uow.withTransaction((tx) =>
          store.loadStream(tx, { aggregateName: "Bad", aggregateId: "bad-3" })
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(RowShapeError);
        expect(String(err.message)).toMatch(/version/);
      }
    });
  });

  // Schema-evolution support: an upcaster lets you migrate historical event
  // payloads to the current shape at read time, so you don't have to rewrite
  // the event log when you ship a new event version.
  describe("upcasters", () => {
    type EventV1 = { type: "Widgeted"; version: 1; label: string };
    type EventV2 = { type: "Widgeted"; version: 2; label: string; tenantId: string };
    type Evolved = EventV1 | EventV2;

    it("applies the upcaster to migrate historical payloads on load", async () => {
      // Seed: historical v1 event appended through a store without an upcaster
      const writer = new PgEventStore<EventV1>();
      const uow = new PgUnitOfWork(pool);

      await uow.withTransaction((tx) =>
        writer.append(tx, {
          aggregateName: "Widget",
          aggregateId: "w1",
          expectedAggregateVersion: 0,
          events: [{ type: "Widgeted", version: 1, label: "old" }]
        })
      );

      // Reader: same store class, now configured with a v1 → v2 upcaster
      const reader = new PgEventStore<Evolved>({
        upcaster: (raw) => {
          if (raw.type === "Widgeted" && raw.version === 1) {
            const v1 = raw as EventV1;
            return { type: "Widgeted", version: 2, label: v1.label, tenantId: "default" };
          }
          return raw as Evolved;
        }
      });

      const events = await uow.withTransaction((tx) =>
        reader.loadStream(tx, { aggregateName: "Widget", aggregateId: "w1" })
      );

      expect(events).toHaveLength(1);
      const payload = events[0]!.payload as EventV2;
      expect(payload.version).toBe(2);
      expect(payload.label).toBe("old");
      expect(payload.tenantId).toBe("default");
    });

    it("leaves current-shape events untouched", async () => {
      const upcasterCalls: AnyEvent[] = [];
      const store = new PgEventStore<EventV2>({
        upcaster: (raw) => {
          upcasterCalls.push(raw);
          // Fast path: already current-shape
          if (raw.type === "Widgeted" && raw.version === 2) return raw as EventV2;
          throw new Error(`Unexpected historical event: ${JSON.stringify(raw)}`);
        }
      });

      const uow = new PgUnitOfWork(pool);
      await uow.withTransaction((tx) =>
        store.append(tx, {
          aggregateName: "Widget",
          aggregateId: "w2",
          expectedAggregateVersion: 0,
          events: [{ type: "Widgeted", version: 2, label: "fresh", tenantId: "t1" }]
        })
      );

      const events = await uow.withTransaction((tx) =>
        store.loadStream(tx, { aggregateName: "Widget", aggregateId: "w2" })
      );

      expect(events).toHaveLength(1);
      const payload = events[0]!.payload;
      expect(payload.version).toBe(2);
      expect(payload.tenantId).toBe("t1");
      // Upcaster was called (on both the append RETURNING and the subsequent load)
      expect(upcasterCalls.length).toBeGreaterThan(0);
    });

    it("passthrough when no upcaster is configured", async () => {
      const store = new PgEventStore<EventV2>();
      const uow = new PgUnitOfWork(pool);

      await uow.withTransaction((tx) =>
        store.append(tx, {
          aggregateName: "Widget",
          aggregateId: "w3",
          expectedAggregateVersion: 0,
          events: [{ type: "Widgeted", version: 2, label: "plain", tenantId: "t2" }]
        })
      );

      const events = await uow.withTransaction((tx) =>
        store.loadStream(tx, { aggregateName: "Widget", aggregateId: "w3" })
      );

      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({
        type: "Widgeted",
        version: 2,
        label: "plain",
        tenantId: "t2"
      });
    });
  });
});
