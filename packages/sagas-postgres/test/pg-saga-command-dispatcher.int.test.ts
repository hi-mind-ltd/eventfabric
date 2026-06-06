import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  CommandBus,
  type Command,
  type CommandHandler,
} from "@eventfabric/mediator";
import { PgIdempotencyStore, commandsMigrations } from "@eventfabric/mediator-postgres";
import { SagaCommandDispatcher } from "@eventfabric/sagas";
import { PgSagaCommandQueue, sagasMigrations } from "../src";
import { PgUnitOfWork, migrate, type PgTx } from "@eventfabric/postgres";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool, { extensions: [commandsMigrations, sagasMigrations] });
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM eventfabric.saga_pending_commands`);
  await pool.query(`DELETE FROM eventfabric.command_idempotency`);
});

interface Greet extends Command<{ to: string }> {
  type: "Greet";
}

const enqueueGreet = async (
  pool: Pool,
  args: { sagaName: string; instanceId: string; to: string; commandId?: string; tenantId?: string }
) => {
  const command: Greet = {
    type: "Greet",
    version: 1,
    payload: { to: args.to },
    metadata: {
      commandId: args.commandId ?? `cmd-${Math.random()}`,
      idempotencyKey: `saga-emitted-${Math.random()}`,
      issuedAt: new Date().toISOString(),
    },
  };
  await pool.query(
    `INSERT INTO eventfabric.saga_pending_commands (tenant_id, saga_name, instance_id, command, status)
     VALUES ($1, $2, $3, $4::jsonb, 'pending')`,
    [args.tenantId ?? "default", args.sagaName, args.instanceId, JSON.stringify(command)]
  );
};

describe("PgSagaCommandQueue + SagaCommandDispatcher (integration)", () => {
  it("dispatches all pending rows through the bus and DELETEs them on success", async () => {
    const handle = vi.fn(async (c: Greet) => `Hello ${c.payload.to}`);
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({
      commandType: "Greet",
      handle,
    } as CommandHandler<Greet, string, PgTx>);

    const queue = new PgSagaCommandQueue();
    const dispatcher = new SagaCommandDispatcher(new PgUnitOfWork(pool), queue, bus);

    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-1", to: "Ada" });
    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-1", to: "Bob" });

    const round = await dispatcher.runOnce();
    expect(round).toEqual({ claimed: 2, dispatched: 2, failed: 0, released: 0 });
    expect(handle).toHaveBeenCalledTimes(2);

    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS n FROM eventfabric.saga_pending_commands`
    );
    expect(remaining.rows[0]!.n).toBe(0);
  });

  it("releases the row on transient failure with attempts < max, then succeeds on retry", async () => {
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({
      commandType: "Greet",
      handle,
    } as CommandHandler<Greet, string, PgTx>);

    const queue = new PgSagaCommandQueue();
    const dispatcher = new SagaCommandDispatcher(new PgUnitOfWork(pool), queue, bus, {
      maxAttempts: 5,
      // Disable retry backoff for this test — the second runOnce must
      // re-claim the row immediately. (Backoff is exercised separately.)
      retryBackoffMs: () => 0,
    });

    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-1", to: "Ada" });

    const first = await dispatcher.runOnce();
    expect(first).toMatchObject({ released: 1, dispatched: 0 });

    const afterFirst = await pool.query(
      `SELECT status, attempts, last_error FROM eventfabric.saga_pending_commands`
    );
    expect(afterFirst.rows[0]!.status).toBe("pending");
    expect(afterFirst.rows[0]!.attempts).toBe(1);
    expect(afterFirst.rows[0]!.last_error).toBe("transient");

    const second = await dispatcher.runOnce();
    expect(second).toMatchObject({ dispatched: 1 });

    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS n FROM eventfabric.saga_pending_commands`
    );
    expect(remaining.rows[0]!.n).toBe(0);
  });

  it("flips a row to 'failed' after maxAttempts using markFailed", async () => {
    const handle = vi.fn().mockRejectedValue(new Error("permanent"));
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({
      commandType: "Greet",
      handle,
    } as CommandHandler<Greet, string, PgTx>);

    const queue = new PgSagaCommandQueue();
    const dispatcher = new SagaCommandDispatcher(new PgUnitOfWork(pool), queue, bus, {
      maxAttempts: 1,
    });

    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-1", to: "Ada" });

    const round = await dispatcher.runOnce();
    expect(round).toMatchObject({ failed: 1 });

    const row = await pool.query(
      `SELECT status, last_error FROM eventfabric.saga_pending_commands`
    );
    expect(row.rows[0]!.status).toBe("failed");
    expect(row.rows[0]!.last_error).toBe("permanent");
  });

  it("dispatch writes an idempotency slot keyed by saga:<name>:<instance>:<rowId>", async () => {
    // Verifies the row-id-based key rewrite is in place — this is what
    // makes a re-dispatch of the same row (e.g. after a watchdog
    // releases a stuck 'claimed' row) deduplicate against the bus's
    // completed slot.
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({
      commandType: "Greet",
      handle: async (c: Greet) => `Hello ${c.payload.to}`,
    } as CommandHandler<Greet, string, PgTx>);

    const queue = new PgSagaCommandQueue();
    const dispatcher = new SagaCommandDispatcher(new PgUnitOfWork(pool), queue, bus);

    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-dup", to: "Ada" });

    const before = await pool.query(`SELECT id FROM eventfabric.saga_pending_commands`);
    const rowId = String(before.rows[0]!.id);

    await dispatcher.runOnce();

    const slots = await pool.query(
      `SELECT idempotency_key FROM eventfabric.command_idempotency`
    );
    expect(slots.rows.map((r: any) => r.idempotency_key)).toContain(`saga:S:i-dup:${rowId}`);
  });

  it("supports concurrent dispatcher workers via FOR UPDATE SKIP LOCKED", async () => {
    const handle = vi.fn(async () => "ok");
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({
      commandType: "Greet",
      handle,
    } as CommandHandler<Greet, string, PgTx>);

    const queue = new PgSagaCommandQueue();
    const d1 = new SagaCommandDispatcher(new PgUnitOfWork(pool), queue, bus, { batchSize: 50 });
    const d2 = new SagaCommandDispatcher(new PgUnitOfWork(pool), queue, bus, { batchSize: 50 });

    for (let i = 0; i < 30; i++) {
      await enqueueGreet(pool, { sagaName: "S", instanceId: `i-${i}`, to: `t-${i}` });
    }

    const [r1, r2] = await Promise.all([d1.runOnce(), d2.runOnce()]);
    expect(r1.dispatched + r2.dispatched).toBe(30);
    expect(handle).toHaveBeenCalledTimes(30);

    // Both dispatchers must have claimed disjoint subsets — neither should
    // see negative or duplicate counts.
    expect(r1.claimed + r2.claimed).toBe(30);

    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS n FROM eventfabric.saga_pending_commands`
    );
    expect(remaining.rows[0]!.n).toBe(0);
  }, 30000);

  it("resetStaleClaimed() returns leaked claimed rows to pending so a fresh dispatcher picks them up", async () => {
    const handle = vi.fn(async (c: Greet) => `Hello ${c.payload.to}`);
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({
      commandType: "Greet",
      handle,
    } as CommandHandler<Greet, string, PgTx>);

    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-stuck", to: "Cleo" });

    // Simulate a dispatcher that crashed mid-dispatch: take the row to
    // claimed (bumping attempts), then backdate claimed_at past the
    // watchdog window.
    const queue = new PgSagaCommandQueue();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx: PgTx) => queue.claimBatch(tx, { batchSize: 10 }));
    await pool.query(
      `UPDATE eventfabric.saga_pending_commands
          SET claimed_at = NOW() - INTERVAL '10 minutes'
        WHERE status = 'claimed'`
    );

    const reset = await uow.withTransaction((tx: PgTx) =>
      queue.resetStaleClaimed(tx, {
        olderThan: new Date(Date.now() - 5 * 60 * 1000),
      })
    );
    expect(reset).toBe(1);

    const after = await pool.query(
      `SELECT status, claimed_at, attempts, last_error FROM eventfabric.saga_pending_commands`
    );
    expect(after.rows[0]!.status).toBe("pending");
    expect(after.rows[0]!.claimed_at).toBeNull();
    expect(after.rows[0]!.attempts).toBe(1);
    expect(after.rows[0]!.last_error).toBe("watchdog: stale claimed");

    // Fresh dispatcher round must now pick up and complete the work.
    const dispatcher = new SagaCommandDispatcher(new PgUnitOfWork(pool), queue, bus);
    const round = await dispatcher.runOnce();
    expect(round.dispatched).toBe(1);
    expect(handle).toHaveBeenCalledTimes(1);

    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS n FROM eventfabric.saga_pending_commands`
    );
    expect(remaining.rows[0]!.n).toBe(0);
  });

  it("resetStaleClaimed() leaves fresh claimed rows alone", async () => {
    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-fresh", to: "Dee" });

    const queue = new PgSagaCommandQueue();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx: PgTx) => queue.claimBatch(tx, { batchSize: 10 }));
    // claimed_at is "just now" — well within the watchdog window.

    const reset = await uow.withTransaction((tx: PgTx) =>
      queue.resetStaleClaimed(tx, {
        olderThan: new Date(Date.now() - 5 * 60 * 1000),
      })
    );
    expect(reset).toBe(0);

    const after = await pool.query(
      `SELECT status FROM eventfabric.saga_pending_commands`
    );
    expect(after.rows[0]!.status).toBe("claimed");
  });

  it("scopes idempotency rows per-tenant and stamps cmd.metadata.tenantId from the queue row", async () => {
    const seenTenants: string[] = [];
    const handle = vi.fn(async (c: Greet) => {
      seenTenants.push(c.metadata.tenantId ?? "<missing>");
      return `Hello ${c.payload.to}`;
    });
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({
      commandType: "Greet",
      handle,
    } as CommandHandler<Greet, string, PgTx>);

    const queue = new PgSagaCommandQueue();
    const dispatcher = new SagaCommandDispatcher(new PgUnitOfWork(pool), queue, bus);

    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-acme", to: "Ada", tenantId: "acme" });
    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-contoso", to: "Bob", tenantId: "contoso" });

    const round = await dispatcher.runOnce();
    expect(round.dispatched).toBe(2);

    // Each handler invocation must have observed its row's tenant_id stamped
    // on the command metadata — the bus's auto-narrow only works if this is
    // set correctly by the dispatcher.
    expect(seenTenants.sort()).toEqual(["acme", "contoso"]);

    // Each tenant's idempotency slot must live under its own tenant_id, so
    // a redeliver of the same key in the other tenant cannot dedup against it.
    const idem = await pool.query(
      `SELECT tenant_id, status FROM eventfabric.command_idempotency ORDER BY tenant_id`
    );
    expect(idem.rows.map((r: any) => r.tenant_id)).toEqual(["acme", "contoso"]);
    expect(idem.rows.every((r: any) => r.status === "completed")).toBe(true);
  });

  it("requeue() flips a failed row back to pending with attempts reset to 0", async () => {
    const queue = new PgSagaCommandQueue();
    const uow = new PgUnitOfWork(pool);

    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-bad", to: "X" });
    // Force the row to 'failed' with non-zero attempts, mimicking the
    // dispatcher having exhausted retries.
    const rowQ = await pool.query(
      `SELECT id FROM eventfabric.saga_pending_commands WHERE instance_id = 'i-bad'`
    );
    const failedId = String(rowQ.rows[0]!.id);
    await pool.query(
      `UPDATE eventfabric.saga_pending_commands
          SET status='failed', attempts=5, last_error='downstream broken'
        WHERE id=$1`,
      [failedId]
    );

    const ok = await uow.withTransaction((tx: PgTx) =>
      queue.requeue(tx, { id: failedId })
    );
    expect(ok).toBe(true);

    const after = await pool.query(
      `SELECT status, attempts, last_error, next_attempt_at
         FROM eventfabric.saga_pending_commands WHERE id=$1`,
      [failedId]
    );
    expect(after.rows[0]!.status).toBe("pending");
    expect(after.rows[0]!.attempts).toBe(0);
    expect(after.rows[0]!.last_error).toBeNull();
    expect(after.rows[0]!.next_attempt_at).toBeNull();
  });

  it("requeue() returns false for a row that doesn't exist or isn't failed", async () => {
    const queue = new PgSagaCommandQueue();
    const uow = new PgUnitOfWork(pool);
    const missing = await uow.withTransaction((tx: PgTx) =>
      queue.requeue(tx, { id: "999999" })
    );
    expect(missing).toBe(false);

    // Pending row — also not requeueable.
    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-pending", to: "Y" });
    const rowQ = await pool.query(
      `SELECT id FROM eventfabric.saga_pending_commands WHERE instance_id = 'i-pending'`
    );
    const notFailed = await uow.withTransaction((tx: PgTx) =>
      queue.requeue(tx, { id: String(rowQ.rows[0]!.id) })
    );
    expect(notFailed).toBe(false);
  });

  it("claimStrategy='fair-by-tenant' picks one row per tenant per batch", async () => {
    // Load 5 rows for acme and 5 for contoso. With FIFO, the first batch
    // of 2 takes the 2 oldest (both acme). With fair-by-tenant, the
    // first batch of 2 takes 1 acme + 1 contoso.
    for (let i = 0; i < 5; i++) {
      await enqueueGreet(pool, { sagaName: "S", instanceId: `acme-${i}`, to: `a${i}`, tenantId: "acme" });
    }
    for (let i = 0; i < 5; i++) {
      await enqueueGreet(pool, { sagaName: "S", instanceId: `contoso-${i}`, to: `c${i}`, tenantId: "contoso" });
    }

    const queue = new PgSagaCommandQueue({ claimStrategy: "fair-by-tenant" });
    const uow = new PgUnitOfWork(pool);
    const claimed = await uow.withTransaction((tx: PgTx) =>
      queue.claimBatch(tx, { batchSize: 2 })
    );
    const tenants = claimed.map((c) => c.tenantId).sort();
    expect(tenants).toEqual(["acme", "contoso"]);
  });

  it("retry backoff: releaseWithError with delayUntil holds the row from re-claim until the deadline", async () => {
    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-backoff", to: "B" });

    const queue = new PgSagaCommandQueue();
    const uow = new PgUnitOfWork(pool);

    // Claim, then release with a 200ms backoff.
    const claimed = await uow.withTransaction((tx: PgTx) =>
      queue.claimBatch(tx, { batchSize: 10 })
    );
    expect(claimed).toHaveLength(1);
    await uow.withTransaction((tx: PgTx) =>
      queue.releaseWithError(tx, {
        id: claimed[0]!.id,
        error: new Error("transient"),
        delayUntil: new Date(Date.now() + 200),
      })
    );

    // Immediate re-claim must skip the row.
    const immediate = await uow.withTransaction((tx: PgTx) =>
      queue.claimBatch(tx, { batchSize: 10 })
    );
    expect(immediate).toHaveLength(0);

    // After the backoff window, the row is claimable again.
    await new Promise((r) => setTimeout(r, 250));
    const later = await uow.withTransaction((tx: PgTx) =>
      queue.claimBatch(tx, { batchSize: 10 })
    );
    expect(later).toHaveLength(1);
    expect(later[0]!.id).toBe(claimed[0]!.id);
  });

  it("stamps causationId from row.causation_event_id onto the dispatched command", async () => {
    let seenCausation: string | undefined;
    const handle = vi.fn(async (c: Greet) => {
      seenCausation = c.metadata.causationId;
      return "ok";
    });
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({ commandType: "Greet", handle } as CommandHandler<Greet, string, PgTx>);

    const queue = new PgSagaCommandQueue();
    const uow = new PgUnitOfWork(pool);
    await uow.withTransaction((tx: PgTx) =>
      queue.enqueue(tx, {
        tenantId: "default",
        sagaName: "S",
        instanceId: "i-causation",
        command: {
          type: "Greet",
          version: 1,
          payload: { to: "Ada" },
          metadata: {
            commandId: "cmd-c1",
            idempotencyKey: "saga-c1",
            issuedAt: new Date().toISOString(),
          },
        } as Greet,
        causationEventId: "event-12345",
      })
    );

    const dispatcher = new SagaCommandDispatcher(new PgUnitOfWork(pool), queue, bus);
    await dispatcher.runOnce();
    expect(seenCausation).toBe("event-12345");
  });

  it("row.tenantId wins over a saga-author-supplied metadata.tenantId — sagas cannot escape their tenant", async () => {
    let seenTenant: string | undefined;
    const handle = vi.fn(async (c: Greet) => {
      seenTenant = c.metadata.tenantId;
      return "ok";
    });
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({ commandType: "Greet", handle } as CommandHandler<Greet, string, PgTx>);

    const queue = new PgSagaCommandQueue();
    const uow = new PgUnitOfWork(pool);
    // Row's tenant is "acme". Author tries to escape by stamping "victim".
    await uow.withTransaction((tx: PgTx) =>
      queue.enqueue(tx, {
        tenantId: "acme",
        sagaName: "S",
        instanceId: "i-pivot",
        command: {
          type: "Greet",
          version: 1,
          payload: { to: "X" },
          metadata: {
            commandId: "cmd-pivot",
            idempotencyKey: "saga-pivot",
            issuedAt: new Date().toISOString(),
            tenantId: "victim",       // attempted pivot
          },
        } as Greet,
      })
    );

    const dispatcher = new SagaCommandDispatcher(new PgUnitOfWork(pool), queue, bus);
    await dispatcher.runOnce();

    expect(seenTenant).toBe("acme");
  });

  it("cleanupFailed() deletes failed rows past the cutoff, leaves pending + claimed alone", async () => {
    const queue = new PgSagaCommandQueue();
    const uow = new PgUnitOfWork(pool);

    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-failed-old", to: "A" });
    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-failed-fresh", to: "B" });
    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-pending", to: "C" });
    await enqueueGreet(pool, { sagaName: "S", instanceId: "i-claimed", to: "D" });

    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await pool.query(
      `UPDATE eventfabric.saga_pending_commands
          SET status='failed', enqueued_at=$1::timestamptz
        WHERE instance_id='i-failed-old'`,
      [old]
    );
    await pool.query(
      `UPDATE eventfabric.saga_pending_commands SET status='failed' WHERE instance_id='i-failed-fresh'`
    );
    await pool.query(
      `UPDATE eventfabric.saga_pending_commands SET status='claimed' WHERE instance_id='i-claimed'`
    );
    // i-pending stays pending.

    const deleted = await uow.withTransaction((tx: PgTx) =>
      queue.cleanupFailed(tx, {
        olderThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      })
    );
    expect(deleted).toBe(1);

    const remaining = await pool.query(
      `SELECT instance_id FROM eventfabric.saga_pending_commands ORDER BY instance_id`
    );
    expect(remaining.rows.map((r: any) => r.instance_id).sort()).toEqual(
      ["i-claimed", "i-failed-fresh", "i-pending"]
    );
  });
});
