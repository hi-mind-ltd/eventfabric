# Low-Level Design (LLD)

## 1. Core Type System

### Event Types

```typescript
// The minimal contract every event must satisfy.
type AnyEvent = { type: string; version: number };

// Discriminated union — each variant has a literal `type` and `version`.
type AccountEvent =
  | { type: "AccountOpened"; version: 2; accountId: string; customerId: string; initialBalance: number; currency: string; region: string }
  | { type: "AccountDeposited"; version: 1; accountId: string; amount: number; balance: number; transactionId?: string }
  | { type: "AccountWithdrawn"; version: 1; accountId: string; amount: number; balance: number; transactionId?: string }
  | { type: "AccountClosed"; version: 1; accountId: string; reason: string };

// The envelope wraps every stored event with metadata.
type EventEnvelope<E extends AnyEvent> = {
  eventId: string;            // UUID, generated on append
  aggregateName: string;      // e.g., "Account"
  aggregateId: string;        // e.g., "acc-123"
  aggregateVersion: number;   // monotonic per stream (1, 2, 3, ...)
  globalPosition: bigint;     // monotonic across all streams (BIGSERIAL)
  occurredAt: string;         // ISO 8601 timestamp
  payload: E;                 // the event data
  dismissed?: { at: string; reason?: string; by?: string };
  correlationId?: string;
  causationId?: string;
};
```

### Operator Type Constraints (Query Builder)

```typescript
// Maps a value type to its legal comparison operators.
type OperatorFor<V> =
  V extends number | bigint  ? "=" | "!=" | ">" | ">=" | "<" | "<=" | "IN" | "NOT IN" | "IS" | "IS NOT" :
  V extends string           ? "=" | "!=" | "LIKE" | "ILIKE" | "IN" | "NOT IN" | "IS" | "IS NOT" :
  V extends boolean          ? "=" | "!=" | "IS" | "IS NOT" :
  "=" | "!=";

// Forces correct value types per operator.
type ValueFor<V, Op extends string> =
  Op extends "IN" | "NOT IN" ? V[] :      // IN/NOT IN require arrays
  Op extends "IS" | "IS NOT" ? null :      // IS/IS NOT require null
  V;                                        // everything else: the field type
```

### Exhaustive Event Registration

```typescript
// Used by SessionFactory.registerAggregate to verify all event types are listed.
type ExhaustiveEventTypes<EAgg extends AnyEvent, T extends readonly EAgg["type"][]> =
  [Exclude<EAgg["type"], T[number]>] extends [never]
    ? T                                                 // all variants covered
    : T & { readonly __missingEventTypes: Exclude<EAgg["type"], T[number]> };
    //      ↑ compiler error names the missing variant(s)
```

## 2. AggregateRoot — Internal State Machine

```typescript
abstract class AggregateRoot<S, E extends AnyEvent> {
  public version = 0;         // last persisted version
  public state: S;            // current in-memory state
  private pending: E[] = [];  // uncommitted events

  protected abstract handlers: HandlerMap<E, S>;

  // Replay historical events (called by Session on load)
  loadFromHistory(history: { payload: E; aggregateVersion: number }[]) {
    for (const h of history) {
      this.apply(h.payload, false);   // apply but don't add to pending
      this.version = h.aggregateVersion;
    }
  }

  // Command methods call this to record new events
  protected raise(...events: E[]) {
    for (const e of events) {
      this.apply(e, true);  // apply AND add to pending
    }
  }

  // Dispatch to the correct handler, mutate state
  private apply(event: E, isNew: boolean) {
    const handler = this.handlers[event.type as E["type"]];
    if (!handler) throw new Error(`No handler for event type: ${event.type}`);
    handler(this.state, event);
    if (isNew) this.pending.push(event);
  }

  // Called by Session.saveChangesAsync() — drains pending events
  pullPendingEvents(): E[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
```

### State Lifecycle

```
  new AggregateRoot(id, initialState)
  │
  ▼  version=0, state=initial, pending=[]
  │
  loadFromHistory([{v:1, e1}, {v:2, e2}, {v:3, e3}])
  │  apply(e1) → handlers["EventType"](state, e1) → state mutated, version=1
  │  apply(e2) → state mutated, version=2
  │  apply(e3) → state mutated, version=3
  │
  ▼  version=3, state=current, pending=[]
  │
  command method: deposit(100)
  │  raise({ type: "AccountDeposited", ... })
  │  apply(e4) → state mutated, pending=[e4]
  │
  ▼  version=3, state=latest, pending=[e4]
  │
  pullPendingEvents() → returns [e4], pending=[]
  │
  ▼  store.append(expectedVersion=3, events=[e4])
     → new event at version 4
```

## 3. PgEventStore — Append Sequence

```
  append(tx, { aggregateName, aggregateId, expectedAggregateVersion, events, ... })
  │
  ├─ Step 1: SELECT COALESCE(MAX(aggregate_version), 0) FROM eventfabric.events
  │           WHERE aggregate_name = $1 AND aggregate_id = $2
  │           → currentVersion
  │
  ├─ Step 2: if (currentVersion !== expectedAggregateVersion)
  │           throw ConcurrencyError("Expected X but stream is at Y")
  │
  ├─ Step 3: INSERT INTO eventfabric.events (...) VALUES (...)
  │           RETURNING global_position, ...
  │         ┌─ try
  │         │    execute INSERT
  │         ├─ catch (err.code === "23505" && constraint includes "aggregate_version")
  │         │    throw ConcurrencyError("Concurrent append...")
  │         └─ catch (other)
  │              rethrow
  │
  ├─ Step 4: mapRow(row) for each RETURNING row
  │           → assertEventRow(row)     // validate shape
  │           → upcaster?.(row.payload) // transform if configured
  │           → EventEnvelope<E>
  │
  ├─ Step 5: if (enqueueOutbox)
  │           INSERT INTO eventfabric.outbox (global_position, topic)
  │           ON CONFLICT DO NOTHING
  │
  └─ Return { appended: EventEnvelope<E>[], nextAggregateVersion }
```

### Concurrency Detection — Two Paths

```
  Path A: Read-time check (SELECT then compare)
  ┌──────────────────────────────────────────┐
  │ Tx1: SELECT MAX → 50                     │
  │ Tx2: SELECT MAX → 51 (Tx1 committed)     │
  │ Tx2: 51 !== 50 → ConcurrencyError        │
  │ Result: clean error, no INSERT attempted  │
  └──────────────────────────────────────────┘

  Path B: Insert-time collision (UNIQUE constraint)
  ┌──────────────────────────────────────────┐
  │ Tx1: SELECT MAX → 50                     │
  │ Tx2: SELECT MAX → 50 (concurrent)        │
  │ Tx1: INSERT version 51 → success         │
  │ Tx2: INSERT version 51 → pg error 23505  │
  │      → caught and wrapped as             │
  │        ConcurrencyError                  │
  │ Result: same error class for caller      │
  └──────────────────────────────────────────┘
```

## 4. Session — Identity Map and Unit of Work

```typescript
class Session<E extends AnyEvent> {
  private pendingOperations: PendingOperation<E>[] = [];
  private loadedAggregates: Map<string, AggregateRoot<any, E>> = new Map();
  // ↑ identity map: key = aggregateId, value = aggregate instance

  async loadAggregateAsync<TAgg>(aggregateId: string): Promise<TAgg> {
    // Identity map check — prevents double-load data loss
    const existing = this.loadedAggregates.get(aggregateId);
    if (existing) return existing as TAgg;

    // Load from DB, reconstruct, cache
    const agg = await uow.withTransaction(async (tx) => {
      const history = await store.loadStream(tx, ...);
      const aggregate = new AggregateClass(aggregateId);
      aggregate.loadFromHistory(history);
      return aggregate;
    });

    this.loadedAggregates.set(aggregateId, agg);
    return agg;
  }

  async saveChangesAsync(): Promise<void> {
    // 1. Collect pending events from ALL tracked aggregates
    for (const [id, aggregate] of this.loadedAggregates) {
      const events = aggregate.pullPendingEvents();
      if (events.length > 0) {
        this.pendingOperations.push({ type: "append", aggregateId: id, events, ... });
      }
    }

    // 2. Execute ALL operations in a SINGLE transaction
    await uow.withTransaction(async (tx) => {
      for (const op of this.pendingOperations) {
        await store.append(tx, op);  // or startStream
      }
      // Run inline projections if registered
      if (inlineProjector) {
        for (const env of allAppendedEvents) {
          await inlineProjector.handle(tx, env);
        }
      }
      // Save snapshots if policy triggers
      // ...
    });
  }
}
```

### Identity Map — Why It Matters

```
  Without identity map (BUG):             With identity map (CORRECT):
  ────────────────────────                ────────────────────────
  a = load("acc-1") → instance1          a = load("acc-1") → instance1
  a.deposit(100)    → pending: [Dep100]  a.deposit(100)    → pending: [Dep100]
  b = load("acc-1") → instance2 (NEW!)   b = load("acc-1") → instance1 (SAME!)
  b.withdraw(50)    → pending: [Wit50]   b.withdraw(50)    → pending: [Dep100, Wit50]
  save()            → saves instance2    save()            → saves instance1
                       ONLY [Wit50]                           BOTH [Dep100, Wit50]
                       Dep100 is LOST!                        Nothing lost
```

## 5. Async Projection Runner — Claim/Process/Ack Loop

```
  start(signal):
  ┌──────────────────────────────────────────┐
  │ while (!signal.aborted):                  │
  │   │                                       │
  │   ├─ Tx1: claimBatch(batchSize, workerId) │
  │   │   UPDATE eventfabric.outbox            │
  │   │   SET locked_at=now(), attempts++      │
  │   │   WHERE locked_at IS NULL              │
  │   │   FOR UPDATE SKIP LOCKED              │
  │   │   RETURNING id, global_position, ...   │
  │   │   → COMMIT (claim is durable)         │
  │   │                                       │
  │   ├─ if (claimed.length === 0):           │
  │   │     sleep(idleSleepMs)                │
  │   │     continue                          │
  │   │                                       │
  │   ├─ observer?.onBatchClaimed(...)        │
  │   │                                       │
  │   ├─ if (txMode === "batch"):             │
  │   │     processBatch(claimed)             │
  │   │   else:                               │
  │   │     for each row: processOne(row)     │
  │   │                                       │
  │   └─ on error: backoff + retry            │
  │       observer?.onRunnerError(...)        │
  └──────────────────────────────────────────┘
```

### processBatch — Internal Sequence

```
  Tx2: BEGIN
  │
  ├─ For rows with attempts > maxAttempts:
  │    deadLetter(row, reason)
  │    observer?.onMessageDeadLettered(...)
  │
  ├─ loadByGlobalPositions(remaining positions)
  │
  ├─ For each event:
  │    For each projection:
  │      if (!matchesTopic) skip
  │      if (globalPosition <= checkpoint) skip
  │      observer?.runHandler?.(handle, info) OR handle(tx, env)
  │      observer?.onEventHandled(durationMs) OR onEventFailed(error)
  │      checkpoint.set(projectionName, globalPosition)
  │    ack(row.id)  // DELETE from outbox
  │    observer?.onMessageAcked(...)
  │
  ├─ COMMIT
  │
  └─ On ERROR:
       Tx2 ROLLS BACK (all acks, checkpoints undone)
       Tx3: BEGIN
         For each claimed row: releaseWithError(row.id, errorMsg)
         observer?.onMessageReleased(...)
       Tx3: COMMIT
       → rows are unlocked, can be reclaimed on next iteration
       throw (runner's outer catch handles backoff)
```

### processOne — Internal Sequence

```
  Tx2: BEGIN
  │
  ├─ if (attempts > maxAttempts): deadLetter, return
  ├─ loadByGlobalPositions([position])
  ├─ if (!env): deadLetter("Event not found"), return
  ├─ if (dismissed && !includeDismissed): ack, return
  │
  ├─ For each projection:
  │    observer?.runHandler?.(handle, info) OR handle(tx, env)
  │    checkpoint.set(...)
  │
  ├─ ack(row.id)
  ├─ COMMIT
  │
  └─ On ERROR:
       Tx2 ROLLS BACK
       Tx3: releaseWithError(row.id, msg)  // separate tx, always commits
       throw
```

## 6. Catch-Up Projector — Checkpoint-Based Loop

```
  catchUpProjection(projection, options):
  ┌─────────────────────────────────────────┐
  │ loop:                                    │
  │   Tx: BEGIN                              │
  │   │                                      │
  │   ├─ checkpoint = get(projectionName)    │
  │   │  → { lastGlobalPosition: N }        │
  │   │                                      │
  │   ├─ events = loadGlobal(               │
  │   │    fromExclusive: N,                │
  │   │    limit: batchSize                 │
  │   │  )                                  │
  │   │                                      │
  │   ├─ if (events.length === 0):          │
  │   │    COMMIT, return (nothing to do)   │
  │   │                                      │
  │   ├─ observer?.onBatchLoaded(...)       │
  │   │                                      │
  │   ├─ For each event:                    │
  │   │    observer?.runHandler?. OR handle  │
  │   │    observer?.onEventHandled/Failed  │
  │   │                                      │
  │   ├─ checkpoint.set(projectionName,     │
  │   │    lastEvent.globalPosition)        │
  │   │  observer?.onCheckpointAdvanced(...)│
  │   │                                      │
  │   ├─ COMMIT                             │
  │   │                                      │
  │   └─ continue loop (more batches?)      │
  │                                          │
  │ On ERROR:                                │
  │   Tx ROLLS BACK (checkpoint not advanced)│
  │   observer?.onProjectorError(...)       │
  │   throw (caller handles retry)          │
  └─────────────────────────────────────────┘
```

## 7. Query Builder — SQL Generation

### Fluent Mode

```
  query<T>(pool, "account_read")        state: table="account_read"
    .where("balance", ">", 100)         clauses: [{ AND, "balance", ">", 100 }]
    .where("currency", "=", "USD")      clauses: [{ AND, "balance", ... }, { AND, "currency", "=", "USD" }]
    .orWhere("active", "=", false)      clauses: [..., { OR, "active", "=", false }]
    .orderBy("balance", "desc")         orders: [{ "balance", DESC }]
    .limit(10)                          limitVal: 10
    .offset(20)                         offsetVal: 20
    .toList()
      │
      ▼
  buildSelectSql():
    SELECT * FROM account_read
    WHERE balance > $1 AND currency = $2 OR active = $3
    ORDER BY balance DESC
    LIMIT 10 OFFSET 20
    values: [100, "USD", false]
      │
      ▼
  pool.query(text, values) → rows as T[]
```

### JSONB Mode

```
  query<T>(pool, "es_snapshots", { jsonb: "state" })
    .where("balance", ">", 100)         → WHERE (state->>'balance')::numeric > $1
    .orderBy("balance", "desc")         → ORDER BY state->'balance' DESC
                                                    ↑ single arrow preserves numeric sort
    .toList()
      │
      ▼
  SELECT state FROM es_snapshots WHERE ... ORDER BY ...
    │
    ▼
  unwrapRows(rows) → rows.map(r => r.state) → T[]
```

### Raw SQL Mode — Tagged Template Mechanics

```typescript
  .sql`SELECT * FROM accounts WHERE balance > ${minBalance} AND name = ${name}`

  // JS runtime calls: sql(strings, ...values) where:
  //   strings = ["SELECT * FROM accounts WHERE balance > ", " AND name = ", ""]
  //   values  = [minBalance, name]
  //
  // Tag function assembles:
  //   text = "SELECT * FROM accounts WHERE balance > $1 AND name = $2"
  //   params = [minBalance, name]
  //
  // pool.query(text, params) → parameterized query, injection impossible
```

## 8. Event Upcaster — Load-Time Transform

```
  PgEventStore.mapRow(row):
  │
  ├─ assertEventRow(row)              // validate { type, version, ... } present
  │   → throws RowShapeError if invalid
  │
  ├─ if (this.upcaster):
  │    payload = upcaster(row.payload as AnyEvent)
  │    // e.g., { type: "AccountOpened", version: 1, ... }
  │    //     → { type: "AccountOpened", version: 2, ..., region: "unknown" }
  │  else:
  │    payload = row.payload as E
  │
  └─ return EventEnvelope<E> { ..., payload }
```

### Upcaster Dispatch Patterns

```typescript
// Pattern A: inline switch
const upcaster: EventUpcaster<MyEvent> = (raw) => {
  if (raw.type === "AccountOpened" && raw.version === 1) {
    return { ...(raw as V1), version: 2, region: "unknown" };
  }
  return raw as MyEvent; // fast path for current-shape events
};

// Pattern B: dispatch table
const migrations: Record<string, (raw: any) => MyEvent> = {
  "AccountOpened:v1": (r) => ({ ...r, version: 2, region: "unknown" }),
};
const upcaster: EventUpcaster<MyEvent> = (raw) =>
  (migrations[`${raw.type}:v${raw.version}`] ?? ((e) => e))(raw) as MyEvent;

// Pattern C: per-event file (recommended for large codebases)
// See docs/schema-evolution.md for full example
```

## 9. Observer Hook Execution

```typescript
// Lifecycle hooks: sync, fire-and-forget, never throw
private fireHook<I>(hook: ((info: I) => void) | undefined, info: I): void {
  if (!hook) return;       // no observer or hook not set → zero cost
  try {
    hook(info);            // call the hook
  } catch {
    // swallow — observer errors NEVER affect runtime behavior
  }
}

// Handler wrapping: async, error propagation preserved
private async runProjectionHandler(projection, tx, env, attempts): Promise<void> {
  const info = { projection: projection.name, eventType: env.payload.type, ... };
  const start = Date.now();
  try {
    if (observer?.runHandler) {
      await observer.runHandler(() => projection.handle(tx, env), info);
      //     ↑ OTel adapter: tracer.startActiveSpan(name, async (span) => { ... })
      //       sets active span → pg/http child spans auto-attach
    } else {
      await projection.handle(tx, env);
    }
    fireHook(observer?.onEventHandled, { ...info, durationMs: Date.now() - start });
  } catch (err) {
    fireHook(observer?.onEventFailed, { ...info, durationMs: Date.now() - start, error });
    throw err;  // re-throw — the runner's own error handling takes over
  }
}
```

## 10. Database Table Relationships

```
  eventfabric.events
  ┌──────────────────────────────────┐
  │ global_position BIGSERIAL PK     │
  │ event_id UUID UNIQUE             │
  │ aggregate_name TEXT               │──┐
  │ aggregate_id TEXT                 │  │ UNIQUE(name, id, version)
  │ aggregate_version INT             │──┘
  │ type TEXT                         │
  │ version INT                       │
  │ payload JSONB                     │
  │ occurred_at TIMESTAMPTZ           │
  │ dismissed_at TIMESTAMPTZ NULL     │
  │ correlation_id TEXT NULL          │
  │ causation_id TEXT NULL            │
  └────────────┬─────────────────────┘
               │ global_position
               ▼
  eventfabric.outbox
  ┌──────────────────────────────────┐
  │ id BIGSERIAL PK                  │
  │ global_position BIGINT UNIQUE ───│──→ FK to events
  │ topic TEXT NULL                   │
  │ locked_at TIMESTAMPTZ NULL       │
  │ locked_by TEXT NULL               │
  │ attempts INT DEFAULT 0           │
  │ last_error TEXT NULL              │
  │ dead_lettered_at TIMESTAMPTZ NULL│
  └────────────┬─────────────────────┘
               │ on dead-letter
               ▼
  eventfabric.outbox_dead_letters
  ┌──────────────────────────────────┐
  │ id BIGSERIAL PK                  │
  │ outbox_id BIGINT                 │
  │ global_position BIGINT           │
  │ topic TEXT NULL                   │
  │ attempts INT                     │
  │ last_error TEXT NULL              │
  │ dead_lettered_at TIMESTAMPTZ     │
  └──────────────────────────────────┘

  eventfabric.projection_checkpoints
  ┌──────────────────────────────────┐
  │ projection_name TEXT PK          │
  │ last_global_position BIGINT      │──→ references events.global_position
  │ updated_at TIMESTAMPTZ           │
  └──────────────────────────────────┘

  eventfabric.snapshots
  ┌──────────────────────────────────┐
  │ aggregate_name TEXT              │──┐
  │ aggregate_id TEXT                │──┘ PK(name, id)
  │ aggregate_version INT            │
  │ snapshot_schema_version INT      │
  │ state JSONB                      │
  │ created_at TIMESTAMPTZ           │
  └──────────────────────────────────┘
```
