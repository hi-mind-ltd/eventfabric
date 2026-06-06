import { describe, it, expect, vi } from "vitest";
import type { Transaction, UnitOfWork } from "@eventfabric/core";
import type { Command, CommandHandler, CommandMiddleware } from "../src";
import {
  CommandBus,
  ConcurrentCommandInFlightError,
  InMemoryIdempotencyStore,
  MissingTenantIdError,
  NoHandlerRegisteredError,
} from "../src";

interface TxToken extends Transaction {
  readonly id: number;
}

class CountingUnitOfWork implements UnitOfWork<TxToken> {
  private nextId = 0;
  public openCount = 0;
  public commitCount = 0;
  public rollbackCount = 0;
  async withTransaction<T>(fn: (tx: TxToken) => Promise<T>): Promise<T> {
    this.openCount++;
    const tx: TxToken = { id: this.nextId++ };
    try {
      const result = await fn(tx);
      this.commitCount++;
      return result;
    } catch (err) {
      this.rollbackCount++;
      throw err;
    }
  }
}

interface DepositCommand extends Command<{ accountId: string; amount: number }> {
  type: "Deposit";
}

const makeCommand = (
  overrides: Partial<DepositCommand & { metadataOverrides: Partial<DepositCommand["metadata"]> }> = {}
): DepositCommand => {
  const { metadataOverrides = {}, ...rest } = overrides as any;
  return {
    type: "Deposit",
    version: 1,
    payload: { accountId: "a1", amount: 100 },
    metadata: {
      commandId: "cmd-1",
      idempotencyKey: "idem-1",
      issuedAt: "2026-04-27T00:00:00Z",
      ...metadataOverrides,
    },
    ...rest,
  };
};

class ConcurrencyError extends Error {
  constructor(msg = "concurrency") {
    super(msg);
    this.name = "ConcurrencyError";
  }
}

describe("CommandBus", () => {
  it("dispatches a command to the registered handler and returns its result", async () => {
    const uow = new CountingUnitOfWork();
    const bus = new CommandBus<TxToken>({
      uow,
      idempotencyStore: new InMemoryIdempotencyStore(),
    });

    const handler: CommandHandler<DepositCommand, { newBalance: number }, TxToken> = {
      commandType: "Deposit",
      handle: vi.fn(async () => ({ newBalance: 100 })),
    };
    bus.register(handler);

    const result = await bus.send<{ newBalance: number }>(makeCommand());
    expect(result).toEqual({ newBalance: 100 });
    expect(uow.commitCount).toBe(1);
    expect(uow.rollbackCount).toBe(0);
  });

  it("throws NoHandlerRegisteredError for unknown command types", async () => {
    const bus = new CommandBus<TxToken>({
      uow: new CountingUnitOfWork(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    await expect(bus.send(makeCommand())).rejects.toBeInstanceOf(NoHandlerRegisteredError);
  });

  it("rejects double-registration of the same command type", () => {
    const bus = new CommandBus<TxToken>({
      uow: new CountingUnitOfWork(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const handler: CommandHandler<DepositCommand, void, TxToken> = {
      commandType: "Deposit",
      handle: async () => {},
    };
    bus.register(handler);
    expect(() => bus.register(handler)).toThrow(/already registered/);
  });

  it("returns the cached result on idempotent retry without re-running the handler", async () => {
    const bus = new CommandBus<TxToken>({
      uow: new CountingUnitOfWork(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const handle = vi.fn(async () => ({ newBalance: 100 }));
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, { newBalance: number }, TxToken>);

    const cmd = makeCommand();
    const first = await bus.send(cmd);
    const second = await bus.send(cmd);

    expect(first).toEqual({ newBalance: 100 });
    expect(second).toEqual({ newBalance: 100 });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("releases the slot when the handler throws so a retry re-runs it", async () => {
    const bus = new CommandBus<TxToken>({
      uow: new CountingUnitOfWork(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new Error("first attempt fails"))
      .mockResolvedValueOnce({ newBalance: 100 });
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, { newBalance: number }, TxToken>);

    const cmd = makeCommand();
    await expect(bus.send(cmd)).rejects.toThrow("first attempt fails");
    const second = await bus.send(cmd);
    expect(second).toEqual({ newBalance: 100 });
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("scopes idempotency by tenant — same key in different tenants both run", async () => {
    const bus = new CommandBus<TxToken>({
      uow: new CountingUnitOfWork(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const handle = vi.fn(async () => ({ ok: true }));
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, { ok: boolean }, TxToken>);

    await bus.send(makeCommand({ metadataOverrides: { tenantId: "acme" } } as any));
    await bus.send(makeCommand({ metadataOverrides: { tenantId: "contoso" } } as any));

    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("skips idempotency for handlers registered with idempotency: 'off'", async () => {
    const bus = new CommandBus<TxToken>({
      uow: new CountingUnitOfWork(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const handle = vi.fn(async () => ({ ok: true }));
    bus.register(
      { commandType: "Deposit", handle } as CommandHandler<DepositCommand, { ok: boolean }, TxToken>,
      { idempotency: "off" }
    );

    const cmd = makeCommand();
    await bus.send(cmd);
    await bus.send(cmd);

    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("runs user middleware in registration order outside the idempotency middleware", async () => {
    const bus = new CommandBus<TxToken>({
      uow: new CountingUnitOfWork(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const calls: string[] = [];
    const m1: CommandMiddleware<TxToken> = async (_cmd, _ctx, next) => {
      calls.push("m1:before");
      const r = await next();
      calls.push("m1:after");
      return r;
    };
    const m2: CommandMiddleware<TxToken> = async (_cmd, _ctx, next) => {
      calls.push("m2:before");
      const r = await next();
      calls.push("m2:after");
      return r;
    };
    bus.use(m1);
    bus.use(m2);
    bus.register({
      commandType: "Deposit",
      handle: async () => {
        calls.push("handler");
        return "ok";
      },
    } as CommandHandler<DepositCommand, string, TxToken>);

    await bus.send(makeCommand());
    expect(calls).toEqual([
      "m1:before",
      "m2:before",
      "handler",
      "m2:after",
      "m1:after",
    ]);
  });

  it("middleware can short-circuit and skip the handler", async () => {
    const bus = new CommandBus<TxToken>({
      uow: new CountingUnitOfWork(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const handle = vi.fn();
    bus.use(async () => ({ shortCircuited: true }));
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, unknown, TxToken>);

    const result = await bus.send(makeCommand());
    expect(result).toEqual({ shortCircuited: true });
    expect(handle).not.toHaveBeenCalled();
  });

  it("retries the entire transaction on ConcurrencyError", async () => {
    const uow = new CountingUnitOfWork();
    const bus = new CommandBus<TxToken>({
      uow,
      idempotencyStore: new InMemoryIdempotencyStore(),
      retryOptions: { maxAttempts: 3 },
    });

    const handle = vi
      .fn()
      .mockRejectedValueOnce(new ConcurrencyError())
      .mockRejectedValueOnce(new ConcurrencyError())
      .mockResolvedValueOnce("ok");
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, string, TxToken>);

    const result = await bus.send(makeCommand());
    expect(result).toBe("ok");
    expect(handle).toHaveBeenCalledTimes(3);
    expect(uow.openCount).toBe(3);
    expect(uow.commitCount).toBe(1);
    expect(uow.rollbackCount).toBe(2);
  });

  it("rejects immediately when conflictStrategy is 'reject' and slot is in-flight", async () => {
    const store = new InMemoryIdempotencyStore();
    // Pre-claim from a different command id to simulate a concurrent worker.
    await store.claim({} as TxToken, { key: "idem-1", commandType: "Deposit", commandId: "cmd-other" });

    const bus = new CommandBus<TxToken>({
      uow: new CountingUnitOfWork(),
      idempotencyStore: store,
      idempotencyOptions: { conflictStrategy: "reject" },
    });
    bus.register({
      commandType: "Deposit",
      handle: async () => "should not run",
    } as CommandHandler<DepositCommand, string, TxToken>);

    await expect(bus.send(makeCommand())).rejects.toBeInstanceOf(
      ConcurrentCommandInFlightError
    );
  });

  it("auto-fills causationId from the command's commandId in the handler context", async () => {
    // The bus sets ctx.metadata directly from cmd.metadata, so handlers see
    // the originating commandId and can use it as causation when emitting events.
    const bus = new CommandBus<TxToken>({
      uow: new CountingUnitOfWork(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    let seenMetadata: unknown;
    bus.register({
      commandType: "Deposit",
      handle: async (_cmd, ctx) => {
        seenMetadata = ctx.metadata;
        return null;
      },
    } as CommandHandler<DepositCommand, null, TxToken>);

    await bus.send(makeCommand({ metadataOverrides: { commandId: "cmd-xyz" } } as any));
    expect(seenMetadata).toMatchObject({ commandId: "cmd-xyz" });
  });
});

// ---------- tenant auto-narrowing ----------
//
// A `TenantScopedUnitOfWorkFactory` exposes `forTenant(tenantId)` returning a
// UoW scoped to that tenant. `PgUnitOfWork` is the canonical example. When a
// command carries `metadata.tenantId`, the bus auto-narrows the UoW per call
// so the command's transaction runs under the right tenant — without any
// per-call API on the bus.

interface TenantTx extends Transaction {
  readonly tenantId: string;
}

class TenantAwareUow implements UnitOfWork<TenantTx> {
  public readonly tenantId: string;
  public readonly opens: TenantTx[] = [];
  constructor(tenantId: string = "default") {
    this.tenantId = tenantId;
  }
  async withTransaction<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const tx: TenantTx = { tenantId: this.tenantId };
    this.opens.push(tx);
    return fn(tx);
  }
  forTenant(tenantId: string): UnitOfWork<TenantTx> {
    if (tenantId === this.tenantId) return this;
    return new TenantAwareUow(tenantId);
  }
}

describe("CommandBus — tenant auto-narrowing", () => {
  it("uses the bus's default UoW when the command has no tenantId", async () => {
    const uow = new TenantAwareUow("default");
    const bus = new CommandBus<TenantTx>({
      uow,
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    let seenTenant: string | undefined;
    bus.register({
      commandType: "Deposit",
      handle: async (_cmd, ctx) => {
        seenTenant = ctx.tx.tenantId;
        return null;
      },
    } as CommandHandler<DepositCommand, null, TenantTx>);

    await bus.send(makeCommand());
    expect(seenTenant).toBe("default");
    expect(uow.opens).toHaveLength(1);
  });

  it("narrows to cmd.metadata.tenantId via forTenant on a tenant-aware UoW", async () => {
    const uow = new TenantAwareUow("default");
    const bus = new CommandBus<TenantTx>({
      uow,
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    let seenTenant: string | undefined;
    bus.register({
      commandType: "Deposit",
      handle: async (_cmd, ctx) => {
        seenTenant = ctx.tx.tenantId;
        return null;
      },
    } as CommandHandler<DepositCommand, null, TenantTx>);

    await bus.send(makeCommand({ metadataOverrides: { tenantId: "acme" } } as any));
    expect(seenTenant).toBe("acme");
    // The default UoW shouldn't have opened a tx — only the acme-narrowed one.
    expect(uow.opens).toHaveLength(0);
  });

  it("each send narrows to its own command tenantId (one bus, many tenants)", async () => {
    const uow = new TenantAwareUow("default");
    const bus = new CommandBus<TenantTx>({
      uow,
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const seen: string[] = [];
    bus.register({
      commandType: "Deposit",
      handle: async (_cmd, ctx) => {
        seen.push(ctx.tx.tenantId);
        return null;
      },
    } as CommandHandler<DepositCommand, null, TenantTx>);

    await bus.send(makeCommand({ metadataOverrides: { tenantId: "acme", idempotencyKey: "k-a" } } as any));
    await bus.send(makeCommand({ metadataOverrides: { tenantId: "contoso", idempotencyKey: "k-c" } } as any));
    await bus.send(makeCommand({ idempotencyKey: "k-default" } as any));

    expect(seen).toEqual(["acme", "contoso", "default"]);
  });

  it("falls back to the configured UoW when the UoW has no forTenant (not tenant-aware)", async () => {
    const uow = new CountingUnitOfWork();
    const bus = new CommandBus<TxToken>({
      uow,
      idempotencyStore: new InMemoryIdempotencyStore(),
    });
    const handle = vi.fn(async () => "ok");
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, string, TxToken>);

    // tenantId is set on the cmd, but UoW has no forTenant → bus uses uow as-is.
    await bus.send(makeCommand({ metadataOverrides: { tenantId: "acme" } } as any));
    expect(handle).toHaveBeenCalledOnce();
    expect(uow.commitCount).toBe(1);
  });
});

// ---------- tenant validation gates ----------
//
// The bus trusts `cmd.metadata.tenantId` and routes accordingly. Without
// a validation gate, application code that forgets to verify the
// tenantId matches the authenticated session can be tricked into running
// a victim tenant's UoW. These tests cover the two gates that defend
// against that.

describe("CommandBus.tenantValidator", () => {
  it("runs tenantValidator BEFORE opening any transaction; thrown errors propagate", async () => {
    const uow = new CountingUnitOfWork();
    const bus = new CommandBus<TxToken>({
      uow,
      idempotencyStore: new InMemoryIdempotencyStore(),
      tenantValidator: async (cmd) => {
        if (cmd.metadata.tenantId === "evil") {
          throw new Error("tenant not allowed");
        }
      },
    });
    const handle = vi.fn(async () => "ok");
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, string, TxToken>);

    await expect(
      bus.send(makeCommand({ metadataOverrides: { tenantId: "evil" } } as any))
    ).rejects.toThrow("tenant not allowed");

    // No tx opened, no handler invoked — the gate stopped the request cold.
    expect(uow.openCount).toBe(0);
    expect(handle).not.toHaveBeenCalled();
  });

  it("allows commands when tenantValidator returns void", async () => {
    const uow = new CountingUnitOfWork();
    const validator = vi.fn(async () => undefined);
    const bus = new CommandBus<TxToken>({
      uow,
      idempotencyStore: new InMemoryIdempotencyStore(),
      tenantValidator: validator,
    });
    const handle = vi.fn(async () => "ok");
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, string, TxToken>);

    await bus.send(makeCommand({ metadataOverrides: { tenantId: "acme" } } as any));
    expect(validator).toHaveBeenCalledOnce();
    expect(handle).toHaveBeenCalledOnce();
  });
});

describe("CommandBus.requireTenantId", () => {
  it("throws MissingTenantIdError before opening a tx when requireTenantId=true and tenant is missing", async () => {
    const uow = new CountingUnitOfWork();
    const bus = new CommandBus<TxToken>({
      uow,
      idempotencyStore: new InMemoryIdempotencyStore(),
      requireTenantId: true,
    });
    const handle = vi.fn();
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, void, TxToken>);

    await expect(bus.send(makeCommand())).rejects.toBeInstanceOf(MissingTenantIdError);
    expect(uow.openCount).toBe(0);
    expect(handle).not.toHaveBeenCalled();
  });

  it("permits a command with tenantId when requireTenantId=true", async () => {
    const uow = new CountingUnitOfWork();
    const bus = new CommandBus<TxToken>({
      uow,
      idempotencyStore: new InMemoryIdempotencyStore(),
      requireTenantId: true,
    });
    const handle = vi.fn(async () => "ok");
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, string, TxToken>);
    await bus.send(makeCommand({ metadataOverrides: { tenantId: "acme" } } as any));
    expect(handle).toHaveBeenCalledOnce();
  });
});

describe("CommandBus.in-flight wait (outside tx)", () => {
  it("waits for an in_flight slot OUTSIDE the transaction so connections are not held during sleep", async () => {
    // Block "first" claim until we release it. While it's in_flight, the
    // second send must NOT hold a transaction open — proves the wait is
    // outside the bus's TX scope.
    const uow = new CountingUnitOfWork();
    const store = new InMemoryIdempotencyStore();
    const bus = new CommandBus<TxToken>({
      uow,
      idempotencyStore: store,
      idempotencyOptions: { conflictStrategy: "wait", inFlightWaitMs: 5_000, pollIntervalMs: 5 },
    });

    let release: (v: unknown) => void = () => {};
    const blocker = new Promise((r) => (release = r));
    const handle = vi
      .fn()
      .mockImplementationOnce(async () => {
        await blocker;
        return "first";
      })
      .mockImplementationOnce(async () => "second");
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, string, TxToken>);

    const cmd = makeCommand();
    const first = bus.send(cmd);
    // give the first send time to claim
    await new Promise((r) => setTimeout(r, 10));

    const openCountBeforeSecond = uow.openCount;
    const second = bus.send(cmd);
    // give the second a chance to poll (it should NOT hold a tx open)
    await new Promise((r) => setTimeout(r, 30));

    // Bus retries from scratch each attempt — every retry opens then
    // closes a tx. But between retries (during sleep) no tx must be open.
    // The simplest invariant: rollbackCount grows for each conflict
    // attempt; commitCount stays at 0 until the slot becomes completed.
    expect(uow.commitCount).toBe(0);

    release("go");
    await first;
    const r2 = await second;

    // Both return the same cached result on the dedup retry.
    expect(r2).toBe("first");
    // The handler ran exactly once (the second send hit the completed slot).
    expect(handle).toHaveBeenCalledTimes(1);
    // And the bus opened tx multiple times — once for each in_flight retry.
    expect(uow.openCount).toBeGreaterThan(openCountBeforeSecond);
  });

  it("rejects immediately when conflictStrategy='reject'", async () => {
    const uow = new CountingUnitOfWork();
    const store = new InMemoryIdempotencyStore();
    const bus = new CommandBus<TxToken>({
      uow,
      idempotencyStore: store,
      idempotencyOptions: { conflictStrategy: "reject" },
    });

    let release: (v: unknown) => void = () => {};
    const blocker = new Promise((r) => (release = r));
    const handle = vi.fn(async () => {
      await blocker;
      return "ok";
    });
    bus.register({ commandType: "Deposit", handle } as CommandHandler<DepositCommand, string, TxToken>);

    const cmd = makeCommand();
    const first = bus.send(cmd);
    await new Promise((r) => setTimeout(r, 10));

    await expect(bus.send(cmd)).rejects.toBeInstanceOf(ConcurrentCommandInFlightError);

    release("go");
    await first;
  });
});
