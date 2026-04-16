import { describe, it, expect } from "vitest";
import { InlineProjector } from "../src/projections/inline-projector";
import type { AnyEvent, EventEnvelope, Transaction } from "../src/types";

type E = { type: "A"; version: 1; value: number };

class MockTx implements Transaction {}

describe("InlineProjector", () => {
  it("runs all projections for each event", async () => {
    const handled1: string[] = [];
    const handled2: string[] = [];

    const projection1 = {
      name: "proj1",
      async handle(tx: MockTx, env: EventEnvelope<E>) {
        handled1.push(env.eventId);
      }
    };

    const projection2 = {
      name: "proj2",
      async handle(tx: MockTx, env: EventEnvelope<E>) {
        handled2.push(env.eventId);
      }
    };

    const projector = new InlineProjector<E, MockTx>([projection1, projection2]);

    const envelopes: EventEnvelope<E>[] = [
      {
        eventId: "e1",
        aggregateName: "Test",
        aggregateId: "1",
        aggregateVersion: 1,
        globalPosition: 1n,
        occurredAt: new Date().toISOString(),
        payload: { type: "A", version: 1, value: 1 }
      },
      {
        eventId: "e2",
        aggregateName: "Test",
        aggregateId: "1",
        aggregateVersion: 2,
        globalPosition: 2n,
        occurredAt: new Date().toISOString(),
        payload: { type: "A", version: 1, value: 2 }
      }
    ];

    await projector.run(new MockTx(), envelopes);

    expect(handled1).toHaveLength(2);
    expect(handled1).toEqual(["e1", "e2"]);
    expect(handled2).toHaveLength(2);
    expect(handled2).toEqual(["e1", "e2"]);
  });

  it("skips dismissed events", async () => {
    const handled: string[] = [];

    const projection = {
      name: "proj",
      async handle(tx: MockTx, env: EventEnvelope<E>) {
        handled.push(env.eventId);
      }
    };

    const projector = new InlineProjector<E, MockTx>([projection]);

    const envelopes: EventEnvelope<E>[] = [
      {
        eventId: "e1",
        aggregateName: "Test",
        aggregateId: "1",
        aggregateVersion: 1,
        globalPosition: 1n,
        occurredAt: new Date().toISOString(),
        payload: { type: "A", version: 1, value: 1 },
        dismissed: {
          at: new Date().toISOString(),
          reason: "Test",
          by: "admin"
        }
      },
      {
        eventId: "e2",
        aggregateName: "Test",
        aggregateId: "1",
        aggregateVersion: 2,
        globalPosition: 2n,
        occurredAt: new Date().toISOString(),
        payload: { type: "A", version: 1, value: 2 }
      },
      {
        eventId: "e3",
        aggregateName: "Test",
        aggregateId: "1",
        aggregateVersion: 3,
        globalPosition: 3n,
        occurredAt: new Date().toISOString(),
        payload: { type: "A", version: 1, value: 3 },
        dismissed: {
          at: new Date().toISOString()
        }
      }
    ];

    await projector.run(new MockTx(), envelopes);

    // Should only handle non-dismissed events
    expect(handled).toHaveLength(1);
    expect(handled).toEqual(["e2"]);
  });

  it("handles empty projections array", async () => {
    const projector = new InlineProjector<E, MockTx>([]);

    const envelopes: EventEnvelope<E>[] = [
      {
        eventId: "e1",
        aggregateName: "Test",
        aggregateId: "1",
        aggregateVersion: 1,
        globalPosition: 1n,
        occurredAt: new Date().toISOString(),
        payload: { type: "A", version: 1, value: 1 }
      }
    ];

    // Should not throw
    await projector.run(new MockTx(), envelopes);
  });

  it("handles empty envelopes array", async () => {
    const handled: string[] = [];
    const projection = {
      name: "proj",
      async handle(tx: MockTx, env: EventEnvelope<E>) {
        handled.push(env.eventId);
      }
    };

    const projector = new InlineProjector<E, MockTx>([projection]);

    await projector.run(new MockTx(), []);

    expect(handled).toHaveLength(0);
  });

  it("processes events in order", async () => {
    const order: string[] = [];

    const projection = {
      name: "proj",
      async handle(tx: MockTx, env: EventEnvelope<E>) {
        order.push(env.eventId);
      }
    };

    const projector = new InlineProjector<E, MockTx>([projection]);

    const envelopes: EventEnvelope<E>[] = [
      {
        eventId: "e1",
        aggregateName: "Test",
        aggregateId: "1",
        aggregateVersion: 1,
        globalPosition: 1n,
        occurredAt: new Date().toISOString(),
        payload: { type: "A", version: 1, value: 1 }
      },
      {
        eventId: "e2",
        aggregateName: "Test",
        aggregateId: "1",
        aggregateVersion: 2,
        globalPosition: 2n,
        occurredAt: new Date().toISOString(),
        payload: { type: "A", version: 1, value: 2 }
      },
      {
        eventId: "e3",
        aggregateName: "Test",
        aggregateId: "1",
        aggregateVersion: 3,
        globalPosition: 3n,
        occurredAt: new Date().toISOString(),
        payload: { type: "A", version: 1, value: 3 }
      }
    ];

    await projector.run(new MockTx(), envelopes);

    expect(order).toEqual(["e1", "e2", "e3"]);
  });

  it("handles errors in projections", async () => {
    const projection1 = {
      name: "proj1",
      async handle(tx: MockTx, env: EventEnvelope<E>) {
        throw new Error("Projection error");
      }
    };

    const projection2 = {
      name: "proj2",
      async handle(tx: MockTx, env: EventEnvelope<E>) {
        // Should not be called if first projection throws
      }
    };

    const projector = new InlineProjector<E, MockTx>([projection1, projection2]);

    const envelopes: EventEnvelope<E>[] = [
      {
        eventId: "e1",
        aggregateName: "Test",
        aggregateId: "1",
        aggregateVersion: 1,
        globalPosition: 1n,
        occurredAt: new Date().toISOString(),
        payload: { type: "A", version: 1, value: 1 }
      }
    ];

    await expect(projector.run(new MockTx(), envelopes)).rejects.toThrow("Projection error");
  });
});

