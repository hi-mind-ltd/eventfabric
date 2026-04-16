import { describe, it, expect, vi } from "vitest";
import type { EventEnvelope } from "../src/types";
import { forEventType, asyncForEventType } from "../src/projections/for-event-type";

type DepositedV1 = { type: "Deposited"; version: 1; amount: number };
type WithdrawnV1 = { type: "Withdrawn"; version: 1; amount: number };
type AccountEvent = DepositedV1 | WithdrawnV1;

function envelope<E extends AccountEvent>(payload: E): EventEnvelope<AccountEvent> {
  return {
    eventId: "e1",
    aggregateName: "Account",
    aggregateId: "a1",
    aggregateVersion: 1,
    globalPosition: 1n,
    occurredAt: new Date().toISOString(),
    payload
  };
}

describe("forEventType (catch-up)", () => {
  it("invokes the handler when event type matches", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const projection = forEventType<AccountEvent, "Deposited">(
      "deposit-audit",
      "Deposited",
      handler
    );

    const env = envelope<DepositedV1>({ type: "Deposited", version: 1, amount: 100 });
    await projection.handle({} as never, env);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![1].payload).toEqual({
      type: "Deposited",
      version: 1,
      amount: 100
    });
  });

  it("skips the handler when event type does not match", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const projection = forEventType<AccountEvent, "Deposited">(
      "deposit-audit",
      "Deposited",
      handler
    );

    const env = envelope<WithdrawnV1>({ type: "Withdrawn", version: 1, amount: 50 });
    await projection.handle({} as never, env);

    expect(handler).not.toHaveBeenCalled();
  });

  it("exposes the supplied name on the projection", () => {
    const projection = forEventType<AccountEvent, "Deposited">(
      "deposit-audit",
      "Deposited",
      async () => {}
    );
    expect(projection.name).toBe("deposit-audit");
  });

  it("propagates handler errors", async () => {
    const projection = forEventType<AccountEvent, "Deposited">(
      "deposit-audit",
      "Deposited",
      async () => {
        throw new Error("boom");
      }
    );

    const env = envelope<DepositedV1>({ type: "Deposited", version: 1, amount: 1 });
    await expect(projection.handle({} as never, env)).rejects.toThrow("boom");
  });
});

describe("asyncForEventType (outbox/async)", () => {
  it("invokes the handler on matching event type", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const projection = asyncForEventType<AccountEvent, "Deposited">(
      "deposit-notifier",
      "Deposited",
      handler
    );

    const env = envelope<DepositedV1>({ type: "Deposited", version: 1, amount: 10 });
    await projection.handle({} as never, env);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("skips non-matching event types", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const projection = asyncForEventType<AccountEvent, "Deposited">(
      "deposit-notifier",
      "Deposited",
      handler
    );

    const env = envelope<WithdrawnV1>({ type: "Withdrawn", version: 1, amount: 5 });
    await projection.handle({} as never, env);

    expect(handler).not.toHaveBeenCalled();
  });

  it("passes through the optional topic filter", () => {
    const projection = asyncForEventType<AccountEvent, "Deposited">(
      "deposit-notifier",
      "Deposited",
      async () => {},
      { topicFilter: { mode: "include", topics: ["account"] } }
    );

    expect(projection.topicFilter).toEqual({ mode: "include", topics: ["account"] });
  });

  it("leaves topicFilter undefined when no options are provided", () => {
    const projection = asyncForEventType<AccountEvent, "Deposited">(
      "deposit-notifier",
      "Deposited",
      async () => {}
    );
    expect(projection.topicFilter).toBeUndefined();
  });
});
