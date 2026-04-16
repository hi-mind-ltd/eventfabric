# High-Level Design (HLD)

## 1. System Overview

EventFabric is a TypeScript event-sourcing library designed around three principles: **easy usage**, **small footprint**, and **resilience**. It provides the primitives for building event-sourced applications on PostgreSQL, with a clear separation between the **write side** (commands → events → aggregates) and the **read side** (projections → read models → queries).

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Application Layer                            │
│  (Express, Fastify, NestJS, background workers, CLI tools)          │
├─────────────┬───────────────────────────────────┬───────────────────┤
│  Write Side │         Projection Pipeline       │    Read Side      │
│             │                                   │                   │
│  Commands   │  Inline    Catch-up    Async      │  Query Builder    │
│  ↓          │  Projector Projector   Runner     │  (fluent + SQL)   │
│  Aggregates │  (same tx) (checkpoint) (outbox)  │       ↓           │
│  ↓          │     ↓         ↓          ↓        │  Read Models      │
│  Events     │  Read      Read       External    │  (flat tables,    │
│  ↓          │  Models    Models     Delivery    │   JSONB snapshots)│
│  Event Store│                                   │                   │
├─────────────┴───────────────────────────────────┴───────────────────┤
│                     @eventfabric/postgres                           │
│  PgEventStore · PgSnapshotStore · Session · PgQueryBuilder          │
│  PgOutboxStore · PgProjectionCheckpointStore · PgDlqService         │
├─────────────────────────────────────────────────────────────────────┤
│                     @eventfabric/core                               │
│  AggregateRoot · EventStore (interface) · QueryBuilder (interface)  │
│  AsyncProjectionRunner · CatchUpProjector · InlineProjector         │
│  EventUpcaster · withConcurrencyRetry · forEventType                │
│  AsyncRunnerObserver · CatchUpProjectorObserver                     │
├─────────────────────────────────────────────────────────────────────┤
│                     @eventfabric/opentelemetry                      │
│  createAsyncRunnerObserver · createCatchUpObserver                  │
│  (spans, metrics, context propagation)                              │
├─────────────────────────────────────────────────────────────────────┤
│                        PostgreSQL                                   │
│  eventfabric.events · eventfabric.outbox · eventfabric.snapshots    │
│  eventfabric.projection_checkpoints · eventfabric.outbox_dead_letters│
│  + application read-model tables (account_read, customer_read, etc.)│
└─────────────────────────────────────────────────────────────────────┘
```

## 2. Package Architecture

### Dependency Graph

```
@eventfabric/opentelemetry
    │ peer: @opentelemetry/api
    │ peer: @eventfabric/core
    │
@eventfabric/postgres
    │ peer: @eventfabric/core
    │ dep:  pg
    │
@eventfabric/core  ← no external runtime dependencies
```

### Separation of Concerns

| Package | Responsibility | Dependencies |
|---|---|---|
| **core** | Interfaces, types, DB-agnostic orchestration logic | None |
| **postgres** | PostgreSQL-specific implementations, SQL generation, Session/UoW | `pg` |
| **opentelemetry** | OTel adapter for runner observers | `@opentelemetry/api` |

Core defines contracts (what an EventStore looks like, what a QueryBuilder does, what observer hooks exist). Postgres implements those contracts for PostgreSQL. A future `@eventfabric/mongodb` would implement the same interfaces for MongoDB. The application code programs against core interfaces where possible.

## 3. Write Path

```
   HTTP Request
        │
        ▼
   ┌─────────┐
   │ Session  │  ← Unit of Work + Identity Map
   │ Factory  │
   └────┬─────┘
        │ createSession()
        ▼
   ┌─────────┐     loadAggregateAsync(id)      ┌──────────────┐
   │ Session  │ ──────────────────────────────► │ PgEventStore │
   │          │ ◄────────────────────────────── │  loadStream  │
   │          │     EventEnvelope<E>[]          └──────────────┘
   │          │                                        │
   │          │     replay events onto:                │
   │          │                                        ▼
   │          │  ┌──────────────────┐           ┌────────────┐
   │          │  │ AggregateRoot<S,E>│           │ eventfabric│
   │          │  │  .state (current) │           │  .events   │
   │          │  │  .version         │           │  (table)   │
   │          │  │  .pending[]       │           └────────────┘
   │          │  └──────────────────┘
   │          │         │
   │          │    command method (e.g., deposit())
   │          │         │ raise(event)
   │          │         ▼
   │          │    pending events accumulate
   │          │
   │          │  saveChangesAsync()
   │          │         │
   │          │         ▼
   │          │  ┌────────────────────────────────────────┐
   │          │  │ Single PostgreSQL Transaction           │
   │          │  │                                        │
   │          │  │  1. Concurrency check (SELECT MAX)     │
   │          │  │  2. INSERT events (+ UNIQUE guard)     │
   │          │  │  3. INSERT outbox rows (optional)      │
   │          │  │  4. Run inline projections (optional)  │
   │          │  │  5. Save snapshot (if policy triggers)  │
   │          │  │  6. COMMIT                             │
   │          │  └────────────────────────────────────────┘
   └─────────┘
```

### Key Write-Path Properties

- **Optimistic concurrency**: version check + UNIQUE constraint. Both read-time and insert-time conflicts surface as `ConcurrencyError`.
- **Identity map**: loading the same aggregate twice in one session returns the same instance. Prevents silent data loss from overwritten pending events.
- **Atomic writes**: events + outbox + inline projection + snapshot all commit in one transaction. No partial state.
- **Exhaustive registration**: `registerAggregate` uses a compile-time type check (`ExhaustiveEventTypes`) to reject incomplete event type lists.

## 4. Read Path — Projections

### Three Tiers

```
                    eventfabric.events
                    (global_position order)
                           │
              ┌────────────┼────────────────┐
              │            │                │
              ▼            ▼                ▼
        ┌──────────┐ ┌──────────┐    ┌──────────────┐
        │  Inline   │ │ Catch-up │    │ Async/Outbox │
        │ Projector │ │ Projector│    │   Runner     │
        └──────────┘ └──────────┘    └──────────────┘
              │            │                │
        Same tx as    Reads events     Claims from
        event write   table directly   eventfabric.outbox
              │            │                │
              ▼            ▼                ▼
        Read model    Read model      External system
        (consistent)  (eventual)      (email, webhook)
```

### Projection Selection Guide

| Question | Answer → Tier |
|---|---|
| Must the read model be consistent with the write? | Yes → **Inline** |
| Is the handler doing internal state work (no external calls)? | Yes → **Catch-up** |
| Does the handler call an external service (email, API, queue)? | Yes → **Async/Outbox** |
| Do I need per-message retry and DLQ? | Yes → **Async/Outbox** |
| Might I need to rebuild from scratch? | Yes → **Catch-up** |

### Async Runner — Transaction Modes

The async runner supports two transaction modes for processing claimed outbox rows:

```
       batch mode                          perRow mode
  ┌─────────────────────┐            ┌──────────────────────┐
  │ BEGIN                │            │ For each row:        │
  │  process row 1      │            │   BEGIN              │
  │  process row 2      │            │     process row      │
  │  process row 3      │            │   COMMIT (or ROLLBACK│
  │ COMMIT (all or none)│            │     + release)       │
  └─────────────────────┘            └──────────────────────┘
  Failure → rollback all,            Failure → only failing
  release all rows in                row is released; others
  fresh tx for retry                 are unaffected
```

- **batch**: fewer DB round-trips, all-or-nothing atomicity. Best for high-throughput idempotent handlers.
- **perRow**: failure isolation per message. Best for external delivery where one poison message shouldn't stall siblings.

## 5. Read Path — Query Builder

```
  Application
      │
      │  query<T>(pool, "account_read")
      │    .where("balance", ">", 100)
      │    .orderBy("balance", "desc")
      │    .toList()
      │
      ▼
  ┌──────────────────┐
  │  PgQueryBuilder   │  ← implements core QueryBuilder<T>
  │                   │
  │  Two modes:       │
  │  • Fluent builder │──► SELECT * FROM account_read WHERE balance > $1 ...
  │  • Raw SQL (.sql) │──► User's tagged template → parameterized SQL
  └───────┬───────────┘
          │ pool.query(text, values)
          ▼
     PostgreSQL
  (read-model tables)
```

The query builder is read-only (uses `pool.query`, not a transaction). It does not participate in the write path's unit of work.

## 6. Observability

```
  ┌─────────────────────┐
  │  AsyncProjection     │
  │  Runner / CatchUp    │
  │  Projector           │
  │                      │
  │  Lifecycle hooks:    │
  │  • onBatchClaimed    │──────┐
  │  • onEventHandled    │      │
  │  • onEventFailed     │      │  Observer interface
  │  • onMessageAcked    │      │  (vendor-neutral)
  │  • onMessageDLQ'd    │      │
  │  • runHandler(wrap)  │      │
  └──────────────────────┘      │
                                ▼
              ┌─────────────────────────────────┐
              │  Observer Implementation         │
              │                                 │
              │  Console     New Relic    OTel   │
              │  observer    observer    adapter │
              │  (dev)       (custom)    (pkg)   │
              └─────────────────────────────────┘
                                │
                         @eventfabric/opentelemetry
                                │
                    ┌───────────┴───────────┐
                    │ Traces (spans)        │
                    │ Metrics (counters,    │
                    │   histograms)         │
                    │ Context propagation   │
                    │ (startActiveSpan)     │
                    └───────────────────────┘
```

The `runHandler` hook is special: it wraps handler execution (not just observes it). This enables OTel's `startActiveSpan`, so any instrumented library inside the handler (pg, http, fetch, redis) automatically attaches child spans to the handler's parent span.

## 7. Data Flow — End-to-End Example

A bank transfer using the eventual-consistency pattern:

```
1. POST /transfers/eventual
   │
   ▼
2. Session: transaction.initiate() + transaction.start()
   → saveChangesAsync()
   → INSERT TransactionInitiated + TransactionStarted into eventfabric.events
   │
   ▼
3. Catch-up Projector (withdrawal-handler):
   reads TransactionStarted → loads Account → account.withdraw()
   → INSERT AccountWithdrawn + WithdrawalCompleted into eventfabric.events
   │
   ▼
4. Catch-up Projector (deposit-handler):
   reads WithdrawalCompleted → loads Account → account.deposit()
   → INSERT AccountDeposited + DepositCompleted into eventfabric.events
   │
   ▼
5. Catch-up Projector (transaction-completion-handler):
   reads DepositCompleted → loads Transaction → transaction.complete()
   → INSERT TransactionCompleted into eventfabric.events
   │
   ▼
6. Outbox Runner (email-notifications):
   claims TransactionCompleted from eventfabric.outbox → sends email → ACK
```

Steps 3–5 run as catch-up projections (internal state transitions, no external side effects). Step 6 runs as an outbox projection (external delivery with retry/DLQ guarantee).

## 8. Schema Evolution

```
  Day 1: AccountOpenedV1 { type, version:1, accountId, customerId, ... }
         ▼ stored in eventfabric.events forever

  Day N: Ship AccountOpenedV2 { ..., region: string }
         ▼ new writes emit V2

  On load:
  ┌─────────────────┐     assertEventRow()     ┌──────────────┐
  │ eventfabric.events│ ──────────────────────► │ EventUpcaster │
  │ (raw JSONB)      │     validate shape       │ (V1 → V2)    │
  └─────────────────┘                          └──────┬───────┘
                                                      │
                                               EventEnvelope<E>
                                               (always V2 shape)
                                                      │
                                    ┌─────────────────┼──────────────┐
                                    ▼                 ▼              ▼
                              Aggregate         Projection      Read model
                              handlers          handlers         queries
                              (see V2)          (see V2)         (see V2)
```

The upcaster runs in `PgEventStore.mapRow()`, so every consumer — aggregates, projections, query builder — sees current-shape events. One upcaster, DRY across all readers.

## 9. Security Boundaries

| Boundary | Protection |
|---|---|
| SQL injection (query builder) | Tagged template literals → parameterized queries. Values never touch the SQL string. |
| SQL injection (event store) | All queries use `$N` parameterized placeholders via `pg` driver. |
| Concurrency conflicts | Optimistic concurrency (version check + UNIQUE constraint) → `ConcurrencyError`. |
| Schema drift | `assertEventRow` / `assertOutboxRow` validate required fields at the DB→domain boundary before any cast. `RowShapeError` surfaces corruption loudly. |
| Observer safety | `fireHook` wraps every lifecycle callback in try/catch. A buggy observer can never crash the runner. |

## 10. Failure Modes and Recovery

| Failure | Mechanism | Recovery |
|---|---|---|
| Concurrent write to same aggregate | ConcurrencyError | Caller retries (optionally via `withConcurrencyRetry`) |
| Projection handler throws (batch mode) | Tx rolls back, rows released in fresh tx | Runner retries on next iteration; DLQ after maxAttempts |
| Projection handler throws (perRow mode) | Only failing row released in fresh tx | Other rows unaffected; failing row retries; DLQ after maxAttempts |
| Poison message in outbox | attempts > maxAttempts | Moved to `eventfabric.outbox_dead_letters`; operator inspects via DLQ service |
| Catch-up projection fails | Tx rolls back, checkpoint not advanced | Same events re-processed on next tick |
| Database connection lost | `pg` driver errors propagate | Runner's outer catch + backoff loop retries |
| Observer throws | `fireHook` swallows the error | Runner continues unaffected |
