import { describe, it, expect, vi } from "vitest";
import type { Transaction } from "@eventfabric/core";
import type { Command, CommandContext, LoggerLike } from "../src";
import { createLoggingMiddleware } from "../src";

const tx = {} as Transaction;
const makeCmd = (overrides: Partial<Command["metadata"]> = {}): Command => ({
  type: "Deposit",
  version: 1,
  payload: { accountId: "a1", amount: 100 },
  metadata: {
    commandId: "cmd-1",
    idempotencyKey: "idem-1",
    issuedAt: "2026-04-29T00:00:00Z",
    ...overrides,
  },
});
const makeCtx = (cmd: Command): CommandContext => ({ tx, metadata: cmd.metadata });

function makeLogger(): LoggerLike & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (...args: unknown[]) => logs.push(args.join(" ")),
    error: (...args: unknown[]) => errors.push(args.join(" ")),
  };
}

describe("createLoggingMiddleware", () => {
  it("emits a start + success line on the happy path", async () => {
    const logger = makeLogger();
    const mw = createLoggingMiddleware({ logger });
    const cmd = makeCmd({ commandId: "cmd-xyz" });

    await mw(cmd, makeCtx(cmd), async () => "ok");

    expect(logger.logs).toHaveLength(2);
    expect(logger.logs[0]).toMatch(/→ command Deposit \(id=cmd-xyz\)/);
    expect(logger.logs[1]).toMatch(/✓ command Deposit \(\d+ms\)/);
    expect(logger.errors).toHaveLength(0);
  });

  it("emits start + failure line and re-throws when next() throws", async () => {
    const logger = makeLogger();
    const mw = createLoggingMiddleware({ logger });
    const cmd = makeCmd();

    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "CustomError";
      }
    }

    await expect(
      mw(cmd, makeCtx(cmd), async () => {
        throw new CustomError("boom");
      })
    ).rejects.toThrow("boom");

    expect(logger.logs).toHaveLength(1);
    expect(logger.logs[0]).toMatch(/→ command Deposit/);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toMatch(/✗ command Deposit \(\d+ms\) CustomError: boom/);
  });

  it("includes tenantId in the start line when set on the command", async () => {
    const logger = makeLogger();
    const mw = createLoggingMiddleware({ logger });
    const cmd = makeCmd({ tenantId: "acme" });

    await mw(cmd, makeCtx(cmd), async () => null);

    expect(logger.logs[0]).toMatch(/tenant=acme/);
  });

  it("respects the prefix option", async () => {
    const logger = makeLogger();
    const mw = createLoggingMiddleware({ logger, prefix: "[svc-a] " });
    const cmd = makeCmd();

    await mw(cmd, makeCtx(cmd), async () => null);

    expect(logger.logs[0]!.startsWith("[svc-a] →")).toBe(true);
    expect(logger.logs[1]!.startsWith("[svc-a] ✓")).toBe(true);
  });

  it("defaults to console when no logger is supplied", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mw = createLoggingMiddleware();
      const cmd = makeCmd();
      await mw(cmd, makeCtx(cmd), async () => null);
      expect(consoleLog).toHaveBeenCalledTimes(2);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
      consoleError.mockRestore();
    }
  });
});
