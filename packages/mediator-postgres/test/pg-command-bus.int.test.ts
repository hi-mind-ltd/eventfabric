import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  CommandBus,
  NoHandlerRegisteredError,
  type Command,
  type CommandHandler,
} from "@eventfabric/mediator";
import { PgIdempotencyStore, commandsMigrations } from "../src";
import { PgUnitOfWork, migrate, type PgTx } from "@eventfabric/postgres";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool, { extensions: [commandsMigrations] });
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

interface DepositCommand extends Command<{ accountId: string; amount: number }> {
  type: "Deposit";
}

const makeCommand = (overrides: {
  commandId?: string;
  idempotencyKey?: string;
  tenantId?: string;
  amount?: number;
} = {}): DepositCommand => ({
  type: "Deposit",
  version: 1,
  payload: { accountId: "a1", amount: overrides.amount ?? 100 },
  metadata: {
    commandId: overrides.commandId ?? `cmd-${Math.random()}`,
    idempotencyKey: overrides.idempotencyKey ?? `key-${Math.random()}`,
    issuedAt: new Date().toISOString(),
    tenantId: overrides.tenantId,
  },
});

describe("CommandBus + PgIdempotencyStore", () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM eventfabric.command_idempotency`);
  });

  it("runs the handler once and persists the slot in 'completed' status", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgIdempotencyStore();
    const bus = new CommandBus<PgTx>({ uow, idempotencyStore: store });

    const handle = vi.fn(async () => ({ ok: true }));
    bus.register({
      commandType: "Deposit",
      handle,
    } as CommandHandler<DepositCommand, { ok: boolean }, PgTx>);

    const cmd = makeCommand({ idempotencyKey: "k1" });
    const result = await bus.send(cmd);
    expect(result).toEqual({ ok: true });
    expect(handle).toHaveBeenCalledTimes(1);

    const row = await pool.query(
      `SELECT status, result FROM eventfabric.command_idempotency WHERE idempotency_key = 'k1'`
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.status).toBe("completed");
    expect(row.rows[0]!.result).toEqual({ ok: true });
  });

  it("returns the cached result on retry without re-invoking the handler", async () => {
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });

    const handle = vi.fn(async () => ({ newBalance: 250 }));
    bus.register({
      commandType: "Deposit",
      handle,
    } as CommandHandler<DepositCommand, { newBalance: number }, PgTx>);

    const cmd = makeCommand({ idempotencyKey: "k-retry" });
    const first = await bus.send(cmd);
    const second = await bus.send(cmd);

    expect(first).toEqual({ newBalance: 250 });
    expect(second).toEqual({ newBalance: 250 });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("rolls back the slot when the handler throws so a retry re-runs it", async () => {
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });

    const handle = vi
      .fn()
      .mockRejectedValueOnce(new Error("first attempt fails"))
      .mockResolvedValueOnce({ ok: true });
    bus.register({
      commandType: "Deposit",
      handle,
    } as CommandHandler<DepositCommand, { ok: boolean }, PgTx>);

    const cmd = makeCommand({ idempotencyKey: "k-fail" });
    await expect(bus.send(cmd)).rejects.toThrow("first attempt fails");

    const slotAfterFail = await pool.query(
      `SELECT status FROM eventfabric.command_idempotency WHERE idempotency_key = 'k-fail'`
    );
    // Tx rollback should have removed the row.
    expect(slotAfterFail.rowCount).toBe(0);

    const second = await bus.send(cmd);
    expect(second).toEqual({ ok: true });
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("scopes idempotency by tenant — same key in different tenants both run", async () => {
    const acmeUow = new PgUnitOfWork(pool, "acme");
    const contosoUow = new PgUnitOfWork(pool, "contoso");
    const store = new PgIdempotencyStore();

    const acmeBus = new CommandBus<PgTx>({ uow: acmeUow, idempotencyStore: store });
    const contosoBus = new CommandBus<PgTx>({ uow: contosoUow, idempotencyStore: store });

    const handle = vi.fn(async () => ({ ran: true }));
    acmeBus.register({
      commandType: "Deposit",
      handle,
    } as CommandHandler<DepositCommand, { ran: boolean }, PgTx>);
    contosoBus.register({
      commandType: "Deposit",
      handle,
    } as CommandHandler<DepositCommand, { ran: boolean }, PgTx>);

    await acmeBus.send(makeCommand({ idempotencyKey: "shared", tenantId: "acme" }));
    await contosoBus.send(makeCommand({ idempotencyKey: "shared", tenantId: "contoso" }));

    expect(handle).toHaveBeenCalledTimes(2);

    const rows = await pool.query(
      `SELECT tenant_id FROM eventfabric.command_idempotency WHERE idempotency_key = 'shared' ORDER BY tenant_id`
    );
    expect(rows.rows.map((r: any) => r.tenant_id)).toEqual(["acme", "contoso"]);
  });

  it("throws NoHandlerRegisteredError for unknown command types", async () => {
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    await expect(bus.send(makeCommand())).rejects.toBeInstanceOf(NoHandlerRegisteredError);
  });

  it("blocks-then-deduplicates concurrent commands with the same idempotency key", async () => {
    // Two parallel sends with the same key. PG's unique-constraint serialization
    // makes the second send block on the first transaction, then either see the
    // completed row (and return the cached result) or — if the first rolled back —
    // claim afresh. Either way the handler must run exactly once for a successful
    // run.
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });

    let inFlight = 0;
    let maxConcurrent = 0;
    const handle = vi.fn(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 100));
      inFlight--;
      return { ok: true };
    });
    bus.register({
      commandType: "Deposit",
      handle,
    } as CommandHandler<DepositCommand, { ok: boolean }, PgTx>);

    const cmd = makeCommand({ idempotencyKey: "k-concurrent" });
    const [a, b] = await Promise.all([bus.send(cmd), bus.send(cmd)]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
  }, 15000);

  it("resetStaleInFlight() flips leaked rows to failed and lets retries reclaim", async () => {
    const uow = new PgUnitOfWork(pool);
    const store = new PgIdempotencyStore();

    // Simulate a worker that crashed mid-handler: an in_flight row whose
    // owning transaction never rolled back. We bypass the bus to write
    // the row directly, then backdate it past the watchdog window.
    await pool.query(
      `INSERT INTO eventfabric.command_idempotency
         (tenant_id, idempotency_key, command_type, command_id, status, created_at)
       VALUES ('default', 'k-stuck', 'Deposit', 'cmd-stuck', 'in_flight',
               NOW() - INTERVAL '10 minutes')`
    );

    const reset = await uow.withTransaction((tx) =>
      store.resetStaleInFlight(tx, {
        olderThan: new Date(Date.now() - 5 * 60 * 1000),
      })
    );
    expect(reset).toBe(1);

    const after = await pool.query(
      `SELECT status, error_message FROM eventfabric.command_idempotency WHERE idempotency_key = 'k-stuck'`
    );
    expect(after.rows[0]!.status).toBe("failed");
    expect(after.rows[0]!.error_message).toBe("watchdog: stale in_flight");

    // A retry of the same key must claim the slot again — recovery path.
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    const handle = vi.fn(async () => ({ recovered: true }));
    bus.register({
      commandType: "Deposit",
      handle,
    } as CommandHandler<DepositCommand, { recovered: boolean }, PgTx>);

    const result = await bus.send(makeCommand({ idempotencyKey: "k-stuck" }));
    expect(result).toEqual({ recovered: true });
    expect(handle).toHaveBeenCalledTimes(1);

    const final = await pool.query(
      `SELECT status FROM eventfabric.command_idempotency WHERE idempotency_key = 'k-stuck'`
    );
    expect(final.rows[0]!.status).toBe("completed");
  });

  it("resetStaleInFlight() leaves fresh rows and completed rows untouched", async () => {
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({
      commandType: "Deposit",
      handle: async () => ({ ok: true }),
    } as CommandHandler<DepositCommand, { ok: boolean }, PgTx>);

    // Completed row, recent.
    await bus.send(makeCommand({ idempotencyKey: "k-done" }));
    // Fresh in_flight row written directly (no recent crash).
    await pool.query(
      `INSERT INTO eventfabric.command_idempotency
         (tenant_id, idempotency_key, command_type, command_id, status)
       VALUES ('default', 'k-fresh-inflight', 'Deposit', 'cmd-x', 'in_flight')`
    );

    const uow = new PgUnitOfWork(pool);
    const store = new PgIdempotencyStore();
    const reset = await uow.withTransaction((tx) =>
      store.resetStaleInFlight(tx, {
        olderThan: new Date(Date.now() - 5 * 60 * 1000),
      })
    );
    expect(reset).toBe(0);

    const rows = await pool.query(
      `SELECT idempotency_key, status FROM eventfabric.command_idempotency ORDER BY idempotency_key`
    );
    expect(rows.rows).toEqual([
      { idempotency_key: "k-done", status: "completed" },
      { idempotency_key: "k-fresh-inflight", status: "in_flight" },
    ]);
  });

  it("resetStaleInFlight() honours the tenantId filter when provided", async () => {
    await pool.query(
      `INSERT INTO eventfabric.command_idempotency
         (tenant_id, idempotency_key, command_type, command_id, status, created_at)
       VALUES ('acme',    'k', 'Deposit', 'c1', 'in_flight', NOW() - INTERVAL '10 minutes'),
              ('contoso', 'k', 'Deposit', 'c2', 'in_flight', NOW() - INTERVAL '10 minutes')`
    );

    const uow = new PgUnitOfWork(pool);
    const store = new PgIdempotencyStore();
    const reset = await uow.withTransaction((tx) =>
      store.resetStaleInFlight(tx, {
        olderThan: new Date(Date.now() - 5 * 60 * 1000),
        tenantId: "acme",
      })
    );
    expect(reset).toBe(1);

    const rows = await pool.query(
      `SELECT tenant_id, status FROM eventfabric.command_idempotency
        WHERE idempotency_key = 'k' ORDER BY tenant_id`
    );
    expect(rows.rows).toEqual([
      { tenant_id: "acme", status: "failed" },
      { tenant_id: "contoso", status: "in_flight" },
    ]);
  });

  it("cleanup() prunes rows older than the cutoff", async () => {
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });
    bus.register({
      commandType: "Deposit",
      handle: async () => ({ ok: true }),
    } as CommandHandler<DepositCommand, { ok: boolean }, PgTx>);

    await bus.send(makeCommand({ idempotencyKey: "old-row" }));
    // Backdate the row to simulate age.
    await pool.query(
      `UPDATE eventfabric.command_idempotency SET created_at = NOW() - INTERVAL '7 days' WHERE idempotency_key = 'old-row'`
    );
    await bus.send(makeCommand({ idempotencyKey: "fresh-row" }));

    const uow = new PgUnitOfWork(pool);
    const store = new PgIdempotencyStore();
    const deleted = await uow.withTransaction((tx) =>
      store.cleanup(tx, { olderThan: new Date(Date.now() - 24 * 60 * 60 * 1000) })
    );
    expect(deleted).toBe(1);

    const remaining = await pool.query(
      `SELECT idempotency_key FROM eventfabric.command_idempotency ORDER BY idempotency_key`
    );
    expect(remaining.rows.map((r: any) => r.idempotency_key)).toEqual(["fresh-row"]);
  });
});
