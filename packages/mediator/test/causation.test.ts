import { describe, it, expect } from "vitest";
import type { Transaction } from "@eventfabric/core";
import type { CommandContext } from "../src";
import { commandContextToEventMeta } from "../src";

const tx = {} as Transaction;

const makeCtx = (overrides: Partial<CommandContext["metadata"]> = {}): CommandContext => ({
  tx,
  metadata: {
    commandId: "cmd-1",
    idempotencyKey: "k1",
    issuedAt: "2026-04-28T00:00:00Z",
    ...overrides,
  },
});

describe("commandContextToEventMeta", () => {
  it("uses commandId for both correlationId (when missing) and causationId", () => {
    const meta = commandContextToEventMeta(makeCtx({ commandId: "cmd-xyz" }));
    expect(meta).toEqual({ correlationId: "cmd-xyz", causationId: "cmd-xyz" });
  });

  it("preserves an inbound correlationId while stamping causationId from the command", () => {
    const meta = commandContextToEventMeta(
      makeCtx({ commandId: "cmd-xyz", correlationId: "trace-abc" })
    );
    expect(meta).toEqual({ correlationId: "trace-abc", causationId: "cmd-xyz" });
  });
});
