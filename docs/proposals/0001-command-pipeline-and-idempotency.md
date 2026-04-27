# Proposal 0001 — Command pipeline & idempotency

**Status:** Draft
**Author:** Architecture
**Target package:** `@eventfabric/core` (new module), `@eventfabric/postgres` (storage)
**Depends on:** Existing `Session`, `Repository`, `EventStore`, outbox

## 1. Problem

Today, callers go straight from HTTP/transport into `session.loadAggregateAsync(...)` followed by an aggregate domain method, then `session.saveChangesAsync()`. There is no `Command` concept anywhere in the framework.

Two consequences:

1. **No command-level idempotency.** Outbox/async projectors guarantee at-least-once *event* delivery, so duplicate event publication is handled. But a retried `POST /accounts/123/deposit` with the same client request — caused by a flaky network, a load-balancer retry, or a user double-click — runs the aggregate method twice and produces two `AccountDeposited` events. The aggregate has no way to know the second call is a retry of the first.
2. **Cross-cutting concerns leak into HTTP handlers.** Validation, authorization, tracing context (correlation/causation), retry on `ConcurrencyError`, and command logging live in route handlers today. They are reimplemented per route.

The first is a correctness gap. The second is a code-organization gap that gets worse as the surface grows.

## 2. Goals & non-goals

**Goals**

- A typed `Command` envelope with explicit `idempotencyKey`.
- A `CommandBus` that routes commands to handlers, with middleware for validation, auth, tracing, retry, and idempotency dedup.
- **Exactly-once command effects** within an idempotency window: a retried command with the same `idempotencyKey` returns the original result without re-executing the handler.
- Automatic correlation/causation propagation so emitted events carry the originating command's IDs.
- No breaking changes to `Session` / `Repository`. Existing callers keep working; the command bus sits in front.

**Non-goals**

- No command-bus transport over the network (no Kafka commands, no RPC). Commands stay in-process.
- No CQRS read-model framework. Queries remain free-form (`PgQueryBuilder` is the read side).
- No saga / process manager. Tracked separately in proposal 0002.
- No schema validation framework (Zod, etc.). Middleware contract is open; consumers plug in what they want.

## 3. Design

### 3.1 Command envelope

```ts
// packages/core/src/commands/command.ts
export interface Command<TPayload = unknown> {
  readonly type: string;          // e.g. "DepositToAccount"
  readonly version: number;       // schema version, mirrors event versioning
  readonly payload: TPayload;
  readonly metadata: CommandMetadata;
}

export interface CommandMetadata {
  readonly commandId: string;          // ULID/UUID, generated at command construction
  readonly idempotencyKey: string;     // caller-supplied OR derived; see §3.4
  readonly correlationId?: string;     // optional, propagated to emitted events
  readonly causationId?: string;       // optional, propagated to emitted events
  readonly issuedAt: string;           // ISO timestamp
  readonly tenantId?: string;          // for multi-tenant routing
  readonly principalId?: string;       // optional — auth subject
}
```

`Command<T>` mirrors the structure of `EventEnvelope<E>` so operators learn one mental model. `version` allows command schema evolution with the same upcaster pattern as events (out of scope here, but the field is reserved).

### 3.2 Handler shape

```ts
export interface CommandHandler<TCmd extends Command, TResult = void> {
  readonly commandType: TCmd["type"];
  handle(cmd: TCmd, ctx: CommandContext): Promise<TResult>;
}

export interface CommandContext {
  readonly session: Session<any>;     // pre-created, tenant-scoped
  readonly metadata: CommandMetadata; // available for logging/causation
}
```

A typical handler loads an aggregate, calls a domain method, calls `session.saveChangesAsync()`, returns a result. The `Repository.save` path is updated to read `metadata.correlationId` / `causationId` from the ambient context if present (see §3.6).

### 3.3 Command bus

```ts
export interface CommandBus {
  register<TCmd extends Command, TResult>(
    handler: CommandHandler<TCmd, TResult>
  ): void;

  send<TCmd extends Command, TResult>(
    cmd: TCmd
  ): Promise<TResult>;
}
```

Implementation is a thin dispatch loop:

1. Look up handler by `cmd.type`.
2. Build a `CommandContext` (resolve `tenantId`, create a `Session`).
3. Run middleware chain → final step invokes `handler.handle(cmd, ctx)`.

### 3.4 Middleware chain

Middleware is the standard `(cmd, ctx, next) => Promise<TResult>` shape. Default chain order — outermost first:

```
tracing → logging → auth → validation → idempotency → retry → handler
```

Each layer's responsibility:

| Layer | Responsibility | Failure mode |
|---|---|---|
| `tracing` | Start span, attach `commandId`/`correlationId` to context | n/a |
| `logging` | Structured log of command in/out | n/a |
| `auth` | Verify `principalId` is allowed for `cmd.type` + payload | throw `UnauthorizedError` |
| `validation` | User-pluggable schema check | throw `ValidationError` |
| `idempotency` | Dedup on `idempotencyKey` (see §3.5) | return prior result, skip handler |
| `retry` | Wrap handler in `withConcurrencyRetry` (existing helper) | re-throw on max attempts |

The middleware list is configurable. Bus exposes `bus.use(middleware)` for app-specific layers (rate limiting, feature flags).

### 3.5 Idempotency middleware

This is the core correctness piece. The middleware consults a new `IdempotencyStore`:

```ts
export interface IdempotencyStore<TTx extends Transaction = Transaction> {
  // Atomic claim: returns either { state: "claimed" } meaning we own the slot,
  // or { state: "completed", result } returning the stored prior result.
  // Implementations use INSERT ... ON CONFLICT to make this atomic.
  claim(
    tx: TTx,
    key: string,
    commandType: string,
    tenantId?: string
  ): Promise<
    | { state: "claimed" }
    | { state: "completed"; result: unknown }
    | { state: "in_flight" }   // another worker holds the slot
  >;

  // Called after handler success — stores the result for future retries.
  complete(tx: TTx, key: string, result: unknown): Promise<void>;

  // Called after handler failure — releases the slot so client retries can re-enter.
  // Optional: implementations may also choose to record the failure for poison-message detection.
  release(tx: TTx, key: string, error: Error): Promise<void>;
}
```

Why a store rather than a deterministic in-memory dedup? Because retries can hit different process replicas. The slot needs to be globally consistent.

#### Claim semantics

- `claimed` → middleware proceeds to the handler. Wraps the handler call: success → `complete()`, failure → `release()`.
- `completed` → middleware returns the stored result without invoking the handler. **This is the exactly-once-effect path.**
- `in_flight` → another worker is currently executing this command. Two strategies:
  - **Wait-and-retry** (default): poll with backoff for ~5s, then return `409 Conflict` upstream.
  - **Reject-immediately**: throw `ConcurrentCommandInFlightError`. Faster, less user-friendly.

The choice is per-handler, configured at registration.

#### Result storage

Stored results are JSON-serialized. Handlers that return non-serializable objects (class instances, streams) must declare an explicit serializer. This is a documented constraint, not a runtime check — keep it simple.

#### Idempotency window

Idempotency rows are not retained forever. Default TTL is 24h, configurable. A scheduled cleanup deletes rows where `created_at < NOW() - INTERVAL '<ttl>'`. Documented trade-off: if a client retries a command after the TTL window, the handler re-executes. This is acceptable — clients should never retry a write hours later.

### 3.6 Causation propagation

When a command handler calls `session.saveChangesAsync()`, the `Repository.save` path picks up `correlationId` / `causationId` from the `CommandContext` ambient. Concretely:

- `CommandBus.send` sets a `commandContext` on a `Session` field (`session.setCommandContext(metadata)`).
- `Session.saveChangesAsync` reads it and passes `meta: { correlationId, causationId: commandId }` through to `store.append`.
- All events emitted from a command carry that command's `commandId` as their `causationId`. The `correlationId` flows transitively: a command produced by a saga reacting to an event inherits the originating event's `correlationId`.

Today `meta` is already plumbed through `repository.save({ meta })` ([repository.ts:52](packages/core/src/repository.ts#L52)) — this proposal just makes it automatic.

### 3.7 Idempotency key derivation

Three modes, in order of preference:

1. **Caller-supplied** — HTTP layer reads an `Idempotency-Key` header and stamps it on the command. Standard practice (Stripe-style). This is the recommended default.
2. **Hash-derived** — bus computes `sha256(commandType + tenantId + canonical(payload))`. Useful when a caller can't supply a key but the payload is stable. Risk: legitimate "same payload, different intent" calls dedupe wrongly. Off by default.
3. **Disabled** — handler opts out (e.g., a `RotateApiKey` command that *should* run on every call). Configured at registration: `bus.register(handler, { idempotency: "off" })`.

Modes 1 and 2 should not be mixed for the same command type.

### 3.8 Postgres storage

New table, migration `010_command_idempotency.sql`:

```sql
CREATE TABLE eventfabric.command_idempotency (
  idempotency_key  TEXT        NOT NULL,
  command_type     TEXT        NOT NULL,
  tenant_id        TEXT        NOT NULL DEFAULT 'default',
  status           TEXT        NOT NULL CHECK (status IN ('in_flight','completed','failed')),
  result           JSONB,
  error_message    TEXT,
  command_id       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE INDEX command_idempotency_created_at_idx
  ON eventfabric.command_idempotency (created_at);
```

`PgIdempotencyStore.claim` uses:

```sql
INSERT INTO eventfabric.command_idempotency
  (idempotency_key, command_type, tenant_id, status, command_id)
VALUES ($1, $2, $3, 'in_flight', $4)
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
RETURNING xmax;  -- xmax = 0 means we inserted; otherwise row already existed
```

If insert succeeded → `claimed`. If conflict → SELECT the existing row:
- `status = 'completed'` → return `{ completed, result }`.
- `status = 'in_flight'` → return `{ in_flight }`.
- `status = 'failed'` → treat as `claimed` after re-INSERT (retry-after-failure semantics).

The claim runs **inside the same transaction as the handler's `saveChangesAsync`**. This is the critical guarantee: either the events *and* the idempotency row both commit, or both roll back. No "events appended but idempotency not recorded" half-state. To support this, `CommandBus.send` opens the transaction first, runs middleware inside it, and commits at the end.

This couples the bus to a `UnitOfWork` — acceptable, since commands are inherently transactional.

### 3.9 Cleanup job

A new `eventfabric.cleanupIdempotency(olderThan: string)` SQL function plus a doc snippet showing how to wire it to a cron (pg_cron, k8s CronJob, or whatever the user prefers). Framework does not start a daemon — this is an ops choice.

## 4. API sketch

```ts
// Setup
const bus = new CommandBus({
  sessionFactory,
  idempotencyStore: new PgIdempotencyStore(),
  defaultIdempotency: "required",
});

bus.register({
  commandType: "DepositToAccount",
  async handle(cmd: DepositToAccount, ctx) {
    const account = await ctx.session.loadAggregateAsync<AccountAggregate>(cmd.payload.accountId);
    account.deposit(cmd.payload.amount);
    await ctx.session.saveChangesAsync();
    return { newBalance: account.state.balance };
  },
});

// Express handler
app.post("/accounts/:id/deposit", async (req, res) => {
  const result = await bus.send<DepositToAccount, { newBalance: number }>({
    type: "DepositToAccount",
    version: 1,
    payload: { accountId: req.params.id, amount: req.body.amount },
    metadata: {
      commandId: ulid(),
      idempotencyKey: req.header("Idempotency-Key") ?? ulid(),
      correlationId: req.header("X-Correlation-Id"),
      issuedAt: new Date().toISOString(),
      tenantId: req.tenant.id,
      principalId: req.user.id,
    },
  });
  res.json(result);
});
```

## 5. Migration & compatibility

- **Zero break** for current users. `Session` / `Repository` keep their existing API. The bus is additive.
- New migration `010_command_idempotency.sql` applied via existing `migrate()`.
- New core export: `CommandBus`, `Command`, `CommandHandler`, `IdempotencyStore`.
- New postgres export: `PgIdempotencyStore`.
- Existing examples (`banking-api`, `nestjs-api`) gain a "command pipeline" variant rather than a rewrite — both styles supported in docs.

## 6. Risks & open questions

1. **Result-storage size.** Large handler results stored as JSONB bloat the table. Mitigation: docs recommend returning only IDs + version numbers, not full aggregate snapshots. Optionally cap stored result to N KB and elide.
2. **Failed-command retry semantics.** If a handler fails with a domain error (e.g., insufficient funds), should the next retry with the same key re-execute? Current proposal: yes — `release()` clears the slot. Alternative: store the error and replay it. Pick "replay error for hard validation failures, re-execute for transient" — but distinguishing them is brittle. Default to "always re-execute on failure"; let handlers opt into "replay error" via a returned sentinel.
3. **In-flight stuck rows.** A process that crashes mid-handler leaves an `in_flight` row. Cleanup job must also reset stale `in_flight` rows older than a watchdog window (e.g., 5 min) back to `failed`.
4. **Fairness with the outer transaction.** A long-running handler holds the idempotency row's lock for the full duration. For typical write paths (tens of ms) this is fine. For batch commands, document that they should not use idempotency middleware.
5. **Hash-derived keys + `ON CONFLICT DO NOTHING` race.** Two concurrent identical commands both compute the same hash; one wins claim, the other sees `in_flight`. Wait-and-retry strategy works but introduces tail latency. Acceptable; documented.

## 7. Phasing

- **Phase 1** — `Command`, `CommandHandler`, `CommandBus`, in-memory `IdempotencyStore`, middleware chain. No PG yet. Ship with unit tests.
- **Phase 2** — `PgIdempotencyStore`, migration 010, integration with `Session.saveChangesAsync` for atomic commit.
- **Phase 3** — Causation auto-propagation in `Repository.save` ([repository.ts:71](packages/core/src/repository.ts#L71)) via ambient command context.
- **Phase 4** — Banking example refactored to use the bus; docs page added under [docs/](docs/).
- **Phase 5** — Cleanup SQL function + ops doc.

Phase 1 + 2 unblock the correctness gap. Phases 3–5 are quality of life.

## 8. Out of scope, tracked elsewhere

- Saga / process manager → proposal 0002.
- Command schema registry / cross-language validation → proposal 0003.
- GDPR field-level encryption → proposal 0004.
