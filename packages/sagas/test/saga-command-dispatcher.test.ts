import { describe, it, expect, vi } from "vitest";
import type { Transaction, UnitOfWork } from "@eventfabric/core";
import {
  CommandBus,
  InMemoryIdempotencyStore,
  type Command,
  type CommandHandler,
} from "@eventfabric/mediator";
import {
  InMemorySagaCommandQueue,
  SagaCommandDispatcher,
  type SagaObserver,
} from "../src";

class NoOpUow implements UnitOfWork<Transaction> {
  async withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return fn({});
  }
}

interface DoThing extends Command<{ note: string }> {
  type: "DoThing";
}

const cmd = (note: string, key: string = note): DoThing => ({
  type: "DoThing",
  version: 1,
  payload: { note },
  metadata: {
    commandId: `c-${note}`,
    idempotencyKey: key,
    issuedAt: "2026-04-29T00:00:00Z",
  },
});

const buildBus = (handle: (c: DoThing) => Promise<unknown>) => {
  const bus = new CommandBus<Transaction>({
    uow: new NoOpUow(),
    idempotencyStore: new InMemoryIdempotencyStore(),
  });
  bus.register({
    commandType: "DoThing",
    handle: async (c: DoThing) => handle(c),
  } as CommandHandler<DoThing, unknown, Transaction>);
  return bus;
};

describe("SagaCommandDispatcher", () => {
  it("dispatches each pending row exactly once and ack-deletes on success", async () => {
    const queue = new InMemorySagaCommandQueue();
    const handle = vi.fn(async (c: DoThing) => ({ note: c.payload.note }));
    const bus = buildBus(handle);
    const dispatcher = new SagaCommandDispatcher(new NoOpUow(), queue, bus);

    await queue.enqueue({} as Transaction, {
      tenantId: "default",
      sagaName: "S",
      instanceId: "i-1",
      command: cmd("a"),
    });
    await queue.enqueue({} as Transaction, {
      tenantId: "default",
      sagaName: "S",
      instanceId: "i-1",
      command: cmd("b"),
    });

    const round = await dispatcher.runOnce();
    expect(round).toEqual({ claimed: 2, dispatched: 2, failed: 0, released: 0 });
    expect(queue.pendingRows()).toHaveLength(0);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("rewrites the idempotency key to saga:<name>:<instance>:<rowId> so duplicate dispatch dedups", async () => {
    const queue = new InMemorySagaCommandQueue();
    const handle = vi.fn(async (c: DoThing) => ({ key: c.metadata.idempotencyKey }));
    const bus = buildBus(handle);
    const dispatcher = new SagaCommandDispatcher(new NoOpUow(), queue, bus);

    await queue.enqueue({} as Transaction, {
      tenantId: "default",
      sagaName: "S",
      instanceId: "i-42",
      command: cmd("a"),
    });

    await dispatcher.runOnce();
    const seen = handle.mock.calls[0]![0]!.metadata.idempotencyKey;
    expect(seen).toBe("saga:S:i-42:1");
  });

  it("releases the row back to pending when the bus throws and attempts < maxAttempts", async () => {
    const queue = new InMemorySagaCommandQueue();
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true });
    const bus = buildBus(handle);
    const dispatcher = new SagaCommandDispatcher(new NoOpUow(), queue, bus, {
      maxAttempts: 5,
      // Disable backoff for this test — we want the second runOnce to
      // re-claim the row immediately. Backoff is exercised separately.
      retryBackoffMs: () => 0,
    });

    await queue.enqueue({} as Transaction, {
      tenantId: "default",
      sagaName: "S",
      instanceId: "i-1",
      command: cmd("a"),
    });

    const first = await dispatcher.runOnce();
    expect(first).toMatchObject({ released: 1, dispatched: 0, failed: 0 });
    expect(queue.pendingRows()).toHaveLength(1);

    const second = await dispatcher.runOnce();
    expect(second).toMatchObject({ dispatched: 1 });
    expect(queue.pendingRows()).toHaveLength(0);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("invokes markFailed when the queue supports it and attempts >= maxAttempts", async () => {
    const queue = new InMemorySagaCommandQueue();
    const markFailed = vi.fn(async () => {});
    const failable = Object.assign(queue, { markFailed });
    const handle = vi.fn().mockRejectedValue(new Error("perm-fail"));
    const bus = buildBus(handle);
    const dispatcher = new SagaCommandDispatcher(new NoOpUow(), failable, bus, {
      maxAttempts: 1,
    });

    await queue.enqueue({} as Transaction, {
      tenantId: "default",
      sagaName: "S",
      instanceId: "i-1",
      command: cmd("a"),
    });

    const round = await dispatcher.runOnce();
    expect(round).toMatchObject({ failed: 1, released: 0 });
    expect(markFailed).toHaveBeenCalledTimes(1);
  });

  it("returns zero counts when no rows are pending", async () => {
    const queue = new InMemorySagaCommandQueue();
    const dispatcher = new SagaCommandDispatcher(
      new NoOpUow(),
      queue,
      buildBus(async () => ({}))
    );
    const round = await dispatcher.runOnce();
    expect(round).toEqual({ claimed: 0, dispatched: 0, failed: 0, released: 0 });
  });

  it("loop respects stop()", async () => {
    const queue = new InMemorySagaCommandQueue();
    const dispatcher = new SagaCommandDispatcher(
      new NoOpUow(),
      queue,
      buildBus(async () => ({})),
      { idleSleepMs: 5 }
    );

    const startPromise = dispatcher.start();
    await new Promise((r) => setTimeout(r, 30));
    await dispatcher.stop();
    await startPromise;
  });

  it("emits observer hooks per row: dispatched on success, released on transient failure, failed at maxAttempts", async () => {
    const queue = new InMemorySagaCommandQueue();
    let attempt = 0;
    const handle = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient");
      if (attempt === 2) throw new Error("transient again");
      return { ok: true };
    });

    const dispatched: string[] = [];
    const released: string[] = [];
    const failed: string[] = [];
    const observer: SagaObserver = {
      onCommandDispatched: (info) => dispatched.push(info.commandType),
      onCommandReleased: (info) => released.push(info.error.message),
      onCommandFailed: (info) => failed.push(info.error.message),
    };

    const bus = buildBus(handle);
    const dispatcher = new SagaCommandDispatcher(new NoOpUow(), queue, bus, {
      maxAttempts: 2,
      observer,
      retryBackoffMs: () => 0,    // immediate re-claim for this test
    });

    await queue.enqueue({} as Transaction, {
      tenantId: "default",
      sagaName: "S",
      instanceId: "i-1",
      command: cmd("a"),
    });

    // Round 1: handler throws, attempts=1 <= 2 → released.
    await dispatcher.runOnce();
    expect(released).toEqual(["transient"]);
    expect(failed).toEqual([]);
    expect(dispatched).toEqual([]);

    // Round 2: handler throws, attempts=2 >= maxAttempts=2 → failed.
    await dispatcher.runOnce();
    expect(failed).toEqual(["transient again"]);
  });

  it("invokes runDispatch wrapper exactly once per row", async () => {
    const queue = new InMemorySagaCommandQueue();
    const calls: string[] = [];
    const observer: SagaObserver = {
      runDispatch: async (send, info) => {
        calls.push(info.commandType);
        return send();
      },
    };
    const dispatcher = new SagaCommandDispatcher(
      new NoOpUow(),
      queue,
      buildBus(async () => ({})),
      { observer }
    );

    await queue.enqueue({} as Transaction, {
      tenantId: "default",
      sagaName: "S",
      instanceId: "i-1",
      command: cmd("a"),
    });
    await queue.enqueue({} as Transaction, {
      tenantId: "default",
      sagaName: "S",
      instanceId: "i-1",
      command: cmd("b"),
    });

    await dispatcher.runOnce();
    expect(calls).toEqual(["DoThing", "DoThing"]);
  });

  it("stamps the saga's tenantId onto the dispatched command's metadata when unset", async () => {
    const queue = new InMemorySagaCommandQueue();
    let seenTenantId: string | undefined;
    const bus = buildBus(async (c) => {
      seenTenantId = c.metadata.tenantId;
      return null;
    });
    const dispatcher = new SagaCommandDispatcher(new NoOpUow(), queue, bus);

    // Enqueue with explicit tenantId on the queue row, but no tenantId on
    // the command's own metadata — author forgot to thread it through.
    await queue.enqueue({} as Transaction, {
      tenantId: "acme",
      sagaName: "FundsTransfer",
      instanceId: "i-1",
      command: cmd("a"),
    });

    await dispatcher.runOnce();
    expect(seenTenantId).toBe("acme");
  });

  it("row's tenantId ALWAYS wins over an author-supplied metadata.tenantId — sagas cannot escape their tenant", async () => {
    const queue = new InMemorySagaCommandQueue();
    let seenTenantId: string | undefined;
    const bus = buildBus(async (c) => {
      seenTenantId = c.metadata.tenantId;
      return null;
    });
    const dispatcher = new SagaCommandDispatcher(new NoOpUow(), queue, bus);

    // The author tries to pivot: command metadata says "contoso" but the
    // saga's instance runs in "acme". The dispatcher rewrites tenantId
    // to the row's value so the bus opens contoso's transaction is
    // impossible from inside a saga.
    const cmdWithPivot: DoThing = {
      ...cmd("a"),
      metadata: { ...cmd("a").metadata, tenantId: "contoso" },
    };

    await queue.enqueue({} as Transaction, {
      tenantId: "acme",   // row's tenant — the source of truth
      sagaName: "FundsTransfer",
      instanceId: "i-1",
      command: cmdWithPivot,
    });

    await dispatcher.runOnce();
    expect(seenTenantId).toBe("acme");
  });
});
