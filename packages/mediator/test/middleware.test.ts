import { describe, it, expect } from "vitest";
import type { Transaction } from "@eventfabric/core";
import type { Command, CommandMiddleware } from "../src";
import { composeMiddleware } from "../src";

interface TxToken extends Transaction {
  readonly id: string;
}

const cmd: Command = {
  type: "X",
  version: 1,
  payload: null,
  metadata: { commandId: "c1", idempotencyKey: "k1", issuedAt: "2026-04-27T00:00:00Z" },
};
const ctx = { tx: { id: "tx" } as TxToken, metadata: cmd.metadata };

describe("composeMiddleware", () => {
  it("invokes the terminal when the chain is empty", async () => {
    const chain = composeMiddleware<TxToken>([], async () => "terminal");
    expect(await chain(cmd, ctx)).toBe("terminal");
  });

  it("threads middleware in registration order with onion semantics", async () => {
    const log: string[] = [];
    const m1: CommandMiddleware<TxToken> = async (_c, _x, next) => {
      log.push("a");
      const r = await next();
      log.push("d");
      return r;
    };
    const m2: CommandMiddleware<TxToken> = async (_c, _x, next) => {
      log.push("b");
      const r = await next();
      log.push("c");
      return r;
    };
    const chain = composeMiddleware<TxToken>([m1, m2], async () => {
      log.push("center");
      return null;
    });
    await chain(cmd, ctx);
    expect(log).toEqual(["a", "b", "center", "c", "d"]);
  });

  it("throws if a middleware calls next() more than once", async () => {
    const buggy: CommandMiddleware<TxToken> = async (_c, _x, next) => {
      await next();
      await next();
      return null;
    };
    const chain = composeMiddleware<TxToken>([buggy], async () => null);
    await expect(chain(cmd, ctx)).rejects.toThrow(/multiple times/);
  });

  it("propagates errors from the terminal up through the chain", async () => {
    const m: CommandMiddleware<TxToken> = async (_c, _x, next) => next();
    const chain = composeMiddleware<TxToken>([m], async () => {
      throw new Error("boom");
    });
    await expect(chain(cmd, ctx)).rejects.toThrow("boom");
  });

  it("middleware can transform the result returned by next()", async () => {
    const wrapping: CommandMiddleware<TxToken> = async (_c, _x, next) => {
      const inner = await next();
      return { wrapped: inner };
    };
    const chain = composeMiddleware<TxToken>([wrapping], async () => "raw");
    expect(await chain(cmd, ctx)).toEqual({ wrapped: "raw" });
  });
});
