# Mediator (Commands)

The mediator family ships a typed `CommandBus`, a middleware framework, and
first-class idempotency. The [roadmap](#roadmap) below outlines candidate
extensions (queries, notifications) — these are planned shapes, not commitments
for a specific beta.

| Package | Contains |
|---|---|
| `@eventfabric/mediator` | `Command` envelope, `CommandBus`, `CommandHandler`, middleware composition, `IdempotencyStore` interface, `InMemoryIdempotencyStore`, `commandContextToEventMeta`. Backend-agnostic. |
| `@eventfabric/mediator-postgres` | `PgIdempotencyStore` + watchdog, `commandsMigrations` (migration 010). |
| `@eventfabric/mediator-opentelemetry` | `createCommandBusObserver` middleware (tracing + counters + histograms), `createCommandIdempotencyGauges` (observable gauges for the idempotency table). |

## When to use a command bus

Use commands when you need any of:

- **Idempotency on retry.** A retried HTTP request, a duplicated SQS message, a
  double-click — the second call must return the result of the first without
  re-executing the handler. The bus owns the dedup slot; you write business
  logic.
- **Cross-cutting concerns in one place.** Tracing, logging, authorization,
  validation, retry-on-conflict — these belong outside the handler, not
  smeared across every service method.
- **Atomic effects + audit row.** The handler's work (event-append, read-model
  write, outbox enqueue) and the idempotency record commit together. There is
  no "events were appended but the slot is still pending" half-state.
- **Decoupling caller from handler.** Senders only know the command shape;
  registering handlers is independent of issuing them.

Do **not** use commands for pure reads or queries. Reads don't need a slot,
don't open a transaction, don't carry causation. Use the read side directly
(e.g. `@eventfabric/postgres`'s query builder). Queries as a first-class
primitive are planned for a future beta.

## The command envelope

```ts
import type { Command } from "@eventfabric/mediator";

interface DepositToAccount extends Command<{ accountId: string; amount: number }> {
  type: "DepositToAccount";
}

const cmd: DepositToAccount = {
  type: "DepositToAccount",
  version: 1,
  payload: { accountId: "a-1", amount: 50 },
  metadata: {
    commandId: crypto.randomUUID(),
    idempotencyKey: req.header("Idempotency-Key") ?? crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    tenantId: req.tenant.id,
    principalId: req.user.id,
    correlationId: req.header("X-Correlation-Id"),
  },
};
```

`commandId` and `idempotencyKey` are required. The bus uses `commandId` as the
`causationId` stamped on events emitted by the handler, and `idempotencyKey`
as the dedup slot. If you don't have an upstream idempotency key, generate
one per command — `idempotencyKey === commandId` is a valid "every attempt
is a new attempt" pattern.

`version` is reserved for command schema evolution and should be set to `1`
today.

## Writing a handler

```ts
import type { CommandHandler } from "@eventfabric/mediator";
import type { PgTx } from "@eventfabric/postgres";

const handler: CommandHandler<DepositToAccount, { newBalance: number }, PgTx> = {
  commandType: "DepositToAccount",
  async handle(cmd, ctx) {
    // ctx.tx is the open transaction the bus already started.
    // Use it to construct a Session, call Repository.save, etc.
    const session = sessionFactory.createSession(ctx.tx);
    const account = await session.loadAggregateAsync<AccountAggregate>(
      cmd.payload.accountId
    );
    account.deposit(cmd.payload.amount);
    await session.saveChangesAsync({
      // Stamp causation/correlation on emitted events.
      meta: commandContextToEventMeta(ctx),
    });
    return { newBalance: account.balance };
  },
};
```

The handler runs **inside the bus's transaction**. Its writes, the
idempotency slot insert, and the slot's `completed` update all commit
together. If the handler throws, everything rolls back — including the
slot — so the next retry of the same key claims afresh.

## Wiring a bus

```ts
import { CommandBus } from "@eventfabric/mediator";
import { PgUnitOfWork } from "@eventfabric/postgres";
import { PgIdempotencyStore } from "@eventfabric/mediator-postgres";

const bus = new CommandBus<PgTx>({
  uow: new PgUnitOfWork(pool),
  idempotencyStore: new PgIdempotencyStore(),
});
bus.register(handler);

const result = await bus.send<{ newBalance: number }>(cmd);
```

In tests, swap PG storage for the in-memory store — same interface, no DB
required:

```ts
import { InMemoryIdempotencyStore } from "@eventfabric/mediator";

const bus = new CommandBus({
  uow: inMemoryUow,
  idempotencyStore: new InMemoryIdempotencyStore(),
});
```

## Idempotency, in detail

The default is `idempotency: "required"` — every command must carry an
`idempotencyKey` and the bus enforces the slot. Behavior per claim outcome:

| Claim outcome | What the bus does |
|---|---|
| `claimed` (no prior row) | Runs the handler. On success, marks the slot `completed` with the stored result and returns it. On failure, the tx rolls back; the slot vanishes; the next retry of the same key claims afresh. |
| `completed` (prior row with stored result) | Returns the stored result. Handler is **not** invoked. This is the exactly-once-effect path. |
| `in_flight` (another worker holds the slot) | Default: wait-and-retry for up to 5 seconds (`inFlightWaitMs`), polling every 50ms (`pollIntervalMs`). If still in flight, throws `ConcurrentCommandInFlightError`. Alternative strategy: `conflictStrategy: "reject"` — throws immediately. |

To opt a specific handler out of idempotency:

```ts
bus.register(rotateApiKeyHandler, { idempotency: "off" });
```

Use sparingly — typically for commands that **must** run on every call,
like `RotateApiKey` or `RecordAuditPing`.

### Failed-slot recovery

When the watchdog (see [operational runbook](./operational-runbook.md)) flips
an `in_flight` row to `failed` after a worker crash, the next `claim` for
the same key recovers it atomically. Clients see a normal retry; the
watchdog is invisible to them.

## Middleware

Middleware wraps the rest of the chain in onion order:

```ts
import type { CommandMiddleware } from "@eventfabric/mediator";

const logging: CommandMiddleware = async (cmd, ctx, next) => {
  console.log("→", cmd.type, cmd.metadata.commandId);
  try {
    const result = await next();
    console.log("✓", cmd.type);
    return result;
  } catch (err) {
    console.error("✗", cmd.type, err);
    throw err;
  }
};

bus.use(logging);
```

User-supplied middleware runs **outside** the built-in idempotency middleware.
Order matters — register tracing first (the span covers everything),
authorization second (block early), validation third, etc. The idempotency
middleware is the innermost layer before the handler.

### Built-in logging middleware

For a quick-start observability story without OTel infrastructure:

```ts
import { createLoggingMiddleware } from "@eventfabric/mediator";

bus.use(createLoggingMiddleware());
// → command Deposit (id=cmd-xyz tenant=acme)
// ✓ command Deposit (7ms)
```

It emits a start line, a success or failure line with duration, and
includes `tenantId` when set. Pass `{ logger: pinoInstance }` to swap
`console` for any object with `log` and `error` methods, or
`{ prefix: "[svc-a] " }` to disambiguate logs when one process hosts
multiple buses.

Register it before any other middleware so the log lines cover the
full pipeline:

```ts
bus.use(createLoggingMiddleware());                          // outermost
bus.use(createCommandBusObserver({ tracer, meter }));        // OTel span/metrics
// idempotency middleware is added internally — innermost
```

## Causation & correlation

The bus exposes `cmd.metadata` to the handler context. To stamp emitted
events with `causationId = commandId` and `correlationId = cmd.correlationId
?? cmd.commandId`, use the helper:

```ts
import { commandContextToEventMeta } from "@eventfabric/mediator";

await session.saveChangesAsync({ meta: commandContextToEventMeta(ctx) });
```

The shape returned by `commandContextToEventMeta` matches what
`Session.saveChangesAsync({ meta })` and `PgEventStore.append({ meta })` both
expect. Every event your handler emits will land with `causationId` pointing
back to the command that caused it, and `correlationId` propagating across
the chain.

When a saga emits a command, the dispatcher stamps the saga's instance id
as the command's `correlationId` (unless already set), so the whole flow —
upstream command → event → saga reaction → downstream command → events —
shares one correlation thread.

## OpenTelemetry

Add tracing + metrics for every command with a single middleware:

```ts
import { trace, metrics } from "@opentelemetry/api";
import { createCommandBusObserver } from "@eventfabric/mediator-opentelemetry";

bus.use(createCommandBusObserver({
  tracer: trace.getTracer("my-app"),
  meter: metrics.getMeter("my-app"),
}));
```

Spans are named `command:${cmd.type}` and carry attributes
`eventfabric.command_type`, `eventfabric.command_id`,
`eventfabric.idempotency_key`, plus `tenant_id` / `principal_id` /
`correlation_id` when set on the command. Downstream OTel-instrumented
libraries (pg, http, fetch) automatically attach their spans as children.

Metrics emitted when `meter` is set:

- `eventfabric.command.sent_total{command_type, result}` — counter
- `eventfabric.command.duration_ms{command_type, result}` — histogram

`result` is `"ok"` on success or the error's class name on failure
(`ConcurrentCommandInFlightError`, `NoHandlerRegisteredError`,
`ConcurrencyError`, or whatever the handler threw) — so you can alert on
specific failure modes by label dimension.

### Idempotency gauges

Observable gauges for the `command_idempotency` table:

```ts
import { Pool } from "pg";
import { createCommandIdempotencyGauges } from "@eventfabric/mediator-opentelemetry";

createCommandIdempotencyGauges({
  meter: metrics.getMeter("my-app"),
  inFlightCount: async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM eventfabric.command_idempotency
        WHERE status = 'in_flight'`
    );
    return r.rows[0]?.n ?? 0;
  },
  oldestInFlightSeconds: async () => {
    const r = await pool.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::float8 AS v
         FROM eventfabric.command_idempotency
        WHERE status = 'in_flight'`
    );
    return r.rows[0]?.v ?? 0;
  },
});
```

The gauge package stays free of `pg` — you supply the queries. Two gauges:

- `eventfabric.command.idempotency_in_flight_count` — sanity check (should
  hover near your in-flight command concurrency)
- `eventfabric.command.idempotency_oldest_in_flight_seconds` — **the alert**.
  Sustained growth past your slowest legitimate handler runtime means
  worker crashes are leaking slots; the `resetStaleInFlight` watchdog
  needs to fire.

## Multi-tenancy

The bus is multi-tenant aware out of the box, and the model aligns with
the rest of the framework:

- The **command envelope** carries `metadata.tenantId` (optional).
- The **bus** auto-narrows its UoW per call when both (a) the command
  has a `tenantId` and (b) the configured UoW exposes `forTenant`
  (the [`TenantScopedUnitOfWorkFactory`](https://hi-mind-ltd.github.io/eventfabric/)
  interface). `PgUnitOfWork` is already a `TenantScopedUnitOfWorkFactory`,
  so the typical setup just works.
- The **idempotency slot** is keyed by `(tenant_id, idempotency_key)` in
  `command_idempotency` — same key in different tenants does not collide.

```ts
// One bus, many tenants — no per-call API change.
const bus = new CommandBus<PgTx>({
  uow: new PgUnitOfWork(pool),       // tenant-scoped factory
  idempotencyStore: new PgIdempotencyStore(),
});
bus.register(depositHandler);

// Per-request: stamp tenantId on the command from req.tenant.
await bus.send({
  type: "DepositToAccount",
  version: 1,
  payload: { accountId: "a-1", amount: 50 },
  metadata: {
    commandId: ulid(),
    idempotencyKey: req.header("Idempotency-Key") ?? ulid(),
    issuedAt: new Date().toISOString(),
    tenantId: req.tenant.id,        // ← bus uses this to narrow the UoW
    principalId: req.user.id,
  },
});
```

The handler's `ctx.tx` already has the right tenant context — anything
the handler does (load aggregates, save sessions, append events) commits
under that tenant's scope.

### What happens when the UoW is not tenant-aware

If you configure a plain `UnitOfWork` (no `forTenant` method — e.g., a
custom test fixture or a backend that doesn't model tenancy), the bus
runs the command in the configured UoW's scope regardless of
`metadata.tenantId`. The idempotency slot is **still** keyed correctly by
tenant in the store; only the transactional isolation is not narrowed.
This is the documented behavior of the
`TenantScopedUnitOfWorkFactory` contract — backends that ignore
`tenantId` "return the same UoW; the orchestrators still work correctly."

### Sagas + commands

When a saga emits commands, the `SagaCommandDispatcher` stamps the
saga's `tenantId` onto each dispatched command (overridable by the
saga author). The bus then auto-narrows as above. Cross-tenant flows
need no special handling — one dispatcher process can serve all
tenants, and each command lands under the right tenant's transaction.

## Operational concerns

Both built into `PgIdempotencyStore` and called on a cron:

- `cleanup({ olderThan })` — prune `completed`/`failed` rows past your
  retention window (default 24h).
- `resetStaleInFlight({ olderThan })` — flip `in_flight` rows older than
  your handler-runtime SLO (typical: 5 minutes) to `failed`. The next
  `claim` for the same key recovers atomically.

See the [operational runbook](./operational-runbook.md) for cadences,
sample cron wiring, and triage steps for persistent `failed` rows.

## Errors thrown by the bus

| Error class | When |
|---|---|
| `NoHandlerRegisteredError` | `bus.send()` for a command type with no registered handler. |
| `ConcurrentCommandInFlightError` | Another worker holds the slot and `conflictStrategy === "reject"`, or the wait budget elapsed under the default `"wait"` strategy. |
| `CommandValidationError` | Thrown by user-supplied validation middleware. The bus does not retry on this. |
| `CommandUnauthorizedError` | Thrown by user-supplied auth middleware. The bus does not retry on this. |

The handler can throw whatever it wants; the bus catches it, rolls the
transaction back, and re-throws. OTel observer records the failure with
`result = error.name` for label-based alerting.

## Schema

The PG package ships one table — see the
[schema reference](./schema-reference.md) for column-level detail.

| Table | Migration | Purpose |
|---|---|---|
| `eventfabric.command_idempotency` | `010_command_idempotency.sql` | Dedup slot per `(tenant_id, idempotency_key)` with status `in_flight` / `completed` / `failed`. |

Apply via:

```ts
import { migrate } from "@eventfabric/postgres";
import { commandsMigrations } from "@eventfabric/mediator-postgres";

await migrate(pool, { extensions: [commandsMigrations] });
```

## Roadmap

This release is the **command** half of a mediator. Future betas extend
with:

- **Queries.** `Query<TPayload, TResult>` + `QueryBus` for the read side.
  Same middleware composition + tracing story, no transaction or
  idempotency overhead. Pairs cleanly with the existing
  `@eventfabric/postgres` query builder.
- **Notifications.** `Notification<TPayload>` + fan-out to multiple
  handlers, in-process. Useful for after-the-fact side effects that
  don't need outbox durability (cache invalidation, in-memory state
  refresh).

## See also

- [Sagas](./sagas.md) — sagas emit commands via the mediator; this is how
  the saga's command queue actually executes work.
- [Operational runbook](./operational-runbook.md) — watchdog cadences,
  cleanup, triage for persistent `failed` rows.
- [Schema reference](./schema-reference.md) — column-level reference for
  the `command_idempotency` table.
- [`examples/banking-api-saga`](../examples/banking-api-saga) — runnable
  end-to-end example using mediator + sagas together.
