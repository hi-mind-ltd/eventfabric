import type { AnyEvent, EventEnvelope } from "@eventfabric/core";
import type { AggregateRoot } from "@eventfabric/core";
import type { InlineProjector } from "@eventfabric/core";
import type { PgTx } from "./unitofwork/pg-transaction";
import { PgEventStore } from "./pg-event-store";
import { PgUnitOfWork } from "./unitofwork/pg-unit-of-work";
import type { Pool } from "pg";

/**
 * Type-safe mapping from event types to aggregate classes.
 * This allows TypeScript to infer the aggregate from the event type.
 */
type EventToAggregateMap = {
  [K in string]?: { aggregateName: string; new (...args: any[]): any };
};

/**
 * Pending operation to be executed when saveChangesAsync is called.
 */
type PendingOperation<E extends AnyEvent> =
  | { type: "startStream"; aggregateId: string; events: E[]; aggregateName: string }
  | { type: "append"; aggregateId: string; expectedVersion: number; events: E[]; aggregateName: string };

export type SnapshotPolicy = { everyNEvents: number };

/**
 * Compile-time exhaustiveness check for event type tuples passed to
 * `registerAggregate`. If the tuple `T` doesn't cover every variant of the
 * aggregate's event union `EAgg`, TypeScript rejects the call and the error
 * message names the missing variants in `__missingEventTypes`.
 *
 * Example: if `AccountEvent["type"]` is `"Opened" | "Deposited"` and the
 * caller passes `["Opened"]`, the required type becomes
 * `readonly ["Opened"] & { __missingEventTypes: "Deposited" }` — the compiler
 * then reports "Property '__missingEventTypes' is missing".
 */
type ExhaustiveEventTypes<EAgg extends AnyEvent, T extends readonly EAgg["type"][]> =
  [Exclude<EAgg["type"], T[number]>] extends [never]
    ? T
    : T & { readonly __missingEventTypes: Exclude<EAgg["type"], T[number]> };

/**
 * Session configuration that holds aggregate and snapshot store registrations.
 * This configuration is shared across all sessions created from the same factory.
 */
class SessionConfig<E extends AnyEvent> {
  readonly eventTypeRegistry: EventToAggregateMap = {};
  readonly aggregateClassRegistry: Map<string, { aggregateName: string; new (...args: any[]): any }> = new Map();
  readonly snapshotStoreRegistry: Map<string, { load(tx: PgTx, aggregateName: string, aggregateId: string): Promise<{ state: any; aggregateVersion: number } | null>; save(tx: PgTx, snapshot: any): Promise<void> }> = new Map();
  readonly snapshotPolicyRegistry: Map<string, SnapshotPolicy> = new Map();
  readonly snapshotSchemaVersionRegistry: Map<string, number> = new Map();
  inlineProjector?: InlineProjector<E, PgTx>;
}

/**
 * Factory for creating Session instances with shared configuration.
 * Configure once, create sessions per request.
 * 
 * @example
 * const factory = new SessionFactory(pool, store);
 * factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited", ...]);
 * 
 * // In each request handler:
 * const session = factory.createSession();
 * const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
 */
export class SessionFactory<E extends AnyEvent> {
  private readonly config: SessionConfig<E>;

  constructor(
    private readonly pool: Pool,
    private readonly store: PgEventStore<E>
  ) {
    this.config = new SessionConfig<E>();
  }

  /**
   * Register an aggregate class with its event types and optional snapshot store.
   * This configuration is shared across all sessions created from this factory.
   * 
   * @param AggregateClass - The aggregate class to register
   * @param eventTypes - Array of event type strings that belong to this aggregate
   * @param snapshotStore - Optional snapshot store for this aggregate (for performance)
   * @param snapshotPolicy - Optional snapshot policy (e.g., { everyNEvents: 50 })
   * @param snapshotSchemaVersion - Optional snapshot schema version (defaults to 1)
   */
  registerAggregate<
    EAgg extends E,
    const TTypes extends readonly EAgg["type"][]
  >(
    AggregateClass: { aggregateName: string } & (new (...args: any[]) => AggregateRoot<any, EAgg>),
    eventTypes: ExhaustiveEventTypes<EAgg, TTypes>,
    snapshotStore?: { load(tx: PgTx, aggregateName: string, aggregateId: string): Promise<{ state: any; aggregateVersion: number } | null>; save(tx: PgTx, snapshot: any): Promise<void> },
    snapshotPolicy?: SnapshotPolicy,
    snapshotSchemaVersion?: number
  ): void {
    if (!AggregateClass || !AggregateClass.aggregateName) {
      throw new Error(`AggregateClass must have a static aggregateName property`);
    }
    
    // Store aggregate class in registry
    this.config.aggregateClassRegistry.set(AggregateClass.aggregateName, AggregateClass);
    
    // Map event types to aggregate class
    for (const eventType of eventTypes) {
      this.config.eventTypeRegistry[eventType] = AggregateClass;
    }

    // Register snapshot store if provided
    if (snapshotStore) {
      this.config.snapshotStoreRegistry.set(AggregateClass.aggregateName, snapshotStore);
    }

    // Register snapshot policy if provided
    if (snapshotPolicy) {
      this.config.snapshotPolicyRegistry.set(AggregateClass.aggregateName, snapshotPolicy);
    }

    // Register snapshot schema version if provided
    if (snapshotSchemaVersion !== undefined) {
      this.config.snapshotSchemaVersionRegistry.set(AggregateClass.aggregateName, snapshotSchemaVersion);
    }
  }

  /**
   * Register an inline projector that runs within the same transaction as event appends.
   * This is useful for maintaining read models that must be consistent with events.
   * 
   * @param projector - The inline projector to run for all events
   */
  registerInlineProjector(projector: InlineProjector<E, PgTx>): void {
    this.config.inlineProjector = projector;
  }

  /**
   * Create a new Session instance with shared configuration but isolated state.
   * Each session tracks its own loaded aggregates and pending operations.
   */
  createSession(): Session<E> {
    return new Session(this.pool, this.store, this.config);
  }
}

/**
 * Marten-style session that provides a fluent API for event sourcing operations.
 * The session manages transactions and infers aggregate types from events using TypeScript types.
 * Operations are batched and committed when saveChangesAsync() is called.
 * 
 * Sessions should be created from a SessionFactory, not directly instantiated.
 * Each session has isolated state (loaded aggregates, pending operations) but shares configuration.
 * 
 * @example
 * const factory = new SessionFactory(pool, store);
 * factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited", ...]);
 * 
 * const session = factory.createSession();
 * const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
 * account.deposit(100);
 * await session.saveChangesAsync();
 */
export class Session<E extends AnyEvent> {
  private pendingOperations: Array<PendingOperation<E>> = [];
  private loadedAggregates: Map<string, AggregateRoot<any, E>> = new Map();

  constructor(
    private readonly pool: Pool,
    private readonly store: PgEventStore<E>,
    private readonly config: SessionConfig<E>
  ) {}

  /**
   * Infer aggregate class from event type.
   * Uses the registered event type mapping to find the aggregate.
   */
  private inferAggregateFromEvent(event: E): { aggregateName: string; new (...args: any[]): any } | null {
    const eventType = event.type;
    return this.config.eventTypeRegistry[eventType] || null;
  }

  /**
   * Marten-style API: Start a new event stream with initial events.
   * Infers the aggregate class from the first event's type using TypeScript types.
   * Queues the operation to be executed when saveChangesAsync() is called.
   * Similar to: session.Events.StartStream(questId, started, joined1)
   * 
   * @param aggregateId - The aggregate ID for the new stream
   * @param events - The initial events to start the stream with
   * 
   * @example
   * const accountOpened: AccountOpenedV1 = { type: "AccountOpened", version: 1, ... };
   * const accountDeposited: AccountDepositedV1 = { type: "AccountDeposited", version: 1, ... };
   * session.startStream(accountId, accountOpened, accountDeposited);
   * await session.saveChangesAsync();
   */
  startStream(
    aggregateId: string,
    ...events: E[]
  ): void {
    if (events.length === 0) {
      throw new Error("At least one event is required to start a stream");
    }

    // Infer aggregate from first event's type
    const firstEvent = events[0]!;
    const AggregateClass = this.inferAggregateFromEvent(firstEvent);
    
    if (!AggregateClass) {
      throw new Error(
        `Cannot infer aggregate class from event type "${firstEvent.type}". ` +
        `Please register the event type using session.registerAggregate(). ` +
        `For example: session.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited", ...]);`
      );
    }

    // Validate all events belong to the same aggregate
    for (const event of events) {
      const eventAggregate = this.inferAggregateFromEvent(event);
      if (!eventAggregate || eventAggregate.aggregateName !== AggregateClass.aggregateName) {
        throw new Error(
          `Event type "${event.type}" does not belong to aggregate "${AggregateClass.aggregateName}". ` +
          `All events in startStream must belong to the same aggregate.`
        );
      }
    }

    // Queue the operation to be executed when saveChangesAsync is called
    this.pendingOperations.push({
      type: "startStream",
      aggregateId,
      events,
      aggregateName: AggregateClass.aggregateName
    });
  }

  /**
   * Load an aggregate stream by ID.
   * Infers the aggregate class from the first event type if available.
   */
  async loadStream(
    aggregateId: string,
    AggregateClass?: { aggregateName: string } & (new (...args: any[]) => any)
  ): Promise<EventEnvelope<E>[]> {
    const uow = new PgUnitOfWork(this.pool);
    return uow.withTransaction(async (tx: PgTx) => {
      if (AggregateClass) {
        return this.store.loadStream(tx, aggregateId, AggregateClass);
      }
      
      // Try to load and infer from first event
      // This is a fallback - ideally AggregateClass should be provided
      throw new Error("AggregateClass is required for loadStream. Use store.loadStream() directly or provide AggregateClass.");
    });
  }

  /**
   * Get aggregate class from registry by aggregate name.
   * Used internally to resolve aggregate classes.
   */
  private getAggregateClass(aggregateName: string): { aggregateName: string; new (...args: any[]): any } | null {
    return this.config.aggregateClassRegistry.get(aggregateName) || null;
  }

  /**
   * Load an aggregate by ID, reconstructing it from events and optional snapshot.
   * The aggregate class is inferred from existing events in the database.
   * The snapshot store is automatically resolved from the registry if registered.
   * The aggregate is tracked by the session and will be automatically saved when saveChangesAsync() is called.
   * Similar to Marten DB's LoadAsync<T>().
   * 
   * @param aggregateId - The aggregate ID
   * 
   * @example
   * // First register the aggregate with optional snapshot store:
   * const snapshotStore = new PgSnapshotStore<AccountState>("eventfabric.snapshots", 1);
   * factory.registerAggregate(AccountAggregate, ["AccountOpened", "AccountDeposited", ...], snapshotStore);
   * 
   * // Then load:
   * const session = factory.createSession();
   * const account = await session.loadAggregateAsync<AccountAggregate>("acc-1");
   * account.deposit(100);
   * await session.saveChangesAsync(); // Automatically saves pending events
   */
  async loadAggregateAsync<TAgg extends AggregateRoot<any, E>>(
    aggregateId: string
  ): Promise<TAgg> {
    // Identity map: if this session already loaded the aggregate, return the
    // same instance. Otherwise a second load creates a fresh instance, the
    // first instance's pending events become unreachable, and saveChangesAsync
    // silently drops them.
    const existing = this.loadedAggregates.get(aggregateId);
    if (existing) return existing as TAgg;

    const uow = new PgUnitOfWork(this.pool);
    const agg = await uow.withTransaction(async (tx: PgTx) => {
      // Try to load events to infer aggregate class
      // We'll query for any events for this aggregate ID
      const result = await tx.client.query(
        `SELECT aggregate_name FROM ${this.store.streamVersionsTableName} WHERE aggregate_id = $1 LIMIT 1`,
        [aggregateId]
      );

      let aggregateName: string | null = null;
      let AggregateClass: { aggregateName: string; new (...args: any[]): any } | null = null;

      if (result.rows.length > 0) {
        aggregateName = result.rows[0].aggregate_name;
        if (aggregateName) {
          AggregateClass = this.getAggregateClass(aggregateName);
        }
      }

      if (!AggregateClass || !aggregateName) {
        throw new Error(
          `Cannot load aggregate ${aggregateId}: aggregate class not found. ` +
          `Make sure to register the aggregate using session.registerAggregate() before loading. ` +
          `If this is a new aggregate, use session.startStream() to create it first.`
        );
      }

      // Get snapshot store from registry if available
      const snapshotStore = this.config.snapshotStoreRegistry.get(aggregateName);

      // Load full history for live aggregate state
      const history = await this.store.loadStream(tx, aggregateId, AggregateClass);

      // Reconstruct aggregate
      const aggregate = new AggregateClass(aggregateId) as TAgg;
      aggregate.version = 0;

      // Apply all events in order to ensure live state
      aggregate.loadFromHistory(
        history.map((h) => ({
          payload: h.payload,
          aggregateVersion: h.aggregateVersion
        }))
      );

      // After live replay, also stash snapshot store and policy info on session so that saveChangesAsync can still use snapshots/policies for future calls
      return aggregate;
    });

    // Track the aggregate so we can save it when saveChangesAsync is called
    this.loadedAggregates.set(aggregateId, agg);
    
    return agg;
  }

  /**
   * Load only the latest snapshot for an aggregate (no event replay).
   * Useful for diagnostics or when you explicitly want snapshot state.
   */
  async loadSnapshotAsync<TAgg extends AggregateRoot<any, E>>(
    aggregateId: string
  ): Promise<TAgg> {
    const uow = new PgUnitOfWork(this.pool);
    const agg = await uow.withTransaction(async (tx: PgTx) => {
      // Infer aggregate name
      const result = await tx.client.query(
        `SELECT aggregate_name FROM ${this.store.streamVersionsTableName} WHERE aggregate_id = $1 LIMIT 1`,
        [aggregateId]
      );

      let aggregateName: string | null = null;
      let AggregateClass: { aggregateName: string; new (...args: any[]): any } | null = null;

      if (result.rows.length > 0) {
        aggregateName = result.rows[0].aggregate_name;
        if (aggregateName) {
          AggregateClass = this.getAggregateClass(aggregateName);
        }
      }

      if (!AggregateClass || !aggregateName) {
        throw new Error(
          `Cannot load aggregate ${aggregateId}: aggregate class not found. ` +
          `Make sure to register the aggregate using session.registerAggregate() before loading.`
        );
      }

      const snapshotStore = this.config.snapshotStoreRegistry.get(aggregateName);
      if (!snapshotStore) {
        throw new Error(`No snapshot store registered for aggregate ${aggregateName}`);
      }

      const snapshot = await snapshotStore.load(tx, aggregateName, aggregateId);
      if (!snapshot) {
        throw new Error(`No snapshot found for aggregate ${aggregateName}:${aggregateId}`);
      }

      const aggregate = new AggregateClass(aggregateId, snapshot.state) as TAgg;
      aggregate.version = snapshot.aggregateVersion;
      return aggregate;
    });

    // Track aggregate for later saveChangesAsync if needed (though this path is primarily diagnostic)
    this.loadedAggregates.set(aggregateId, agg);
    return agg;
  }

  /**
   * Append events directly to a stream.
   * Queues the operation to be executed when saveChangesAsync() is called.
   * Similar to Marten DB's Append().
   * 
   * @param aggregateId - The aggregate ID
   * @param expectedVersion - The expected current version of the aggregate
   * @param events - The events to append
   * 
   * @example
   * session.append(accountId, 1, { type: "AccountDeposited", version: 1, accountId, amount: 100, balance: 200 });
   * await session.saveChangesAsync();
   */
  append(
    aggregateId: string,
    expectedVersion: number,
    ...events: E[]
  ): void {
    if (events.length === 0) {
      throw new Error("At least one event is required");
    }

    // Infer aggregate from first event
    const firstEvent = events[0]!;
    const AggregateClass = this.inferAggregateFromEvent(firstEvent);
    
    if (!AggregateClass) {
      throw new Error(
        `Cannot infer aggregate class from event type "${firstEvent.type}". ` +
        `Please register the event type using session.registerAggregate().`
      );
    }

    // Queue the operation to be executed when saveChangesAsync is called
    this.pendingOperations.push({
      type: "append",
      aggregateId,
      expectedVersion,
      events,
      aggregateName: AggregateClass.aggregateName
    });
  }

  /**
   * Convenience helper: append without providing an expected version.
   * WARNING: This is race-prone if multiple writers append concurrently.
   * It fetches the current MAX(aggregate_version) inside a transaction and appends after that.
   */
  appendUnsafe(
    aggregateId: string,
    ...events: E[]
  ): void {
    if (events.length === 0) {
      throw new Error("At least one event is required");
    }

    const firstEvent = events[0]!;
    const AggregateClass = this.inferAggregateFromEvent(firstEvent);

    if (!AggregateClass) {
      throw new Error(
        `Cannot infer aggregate class from event type "${firstEvent.type}". ` +
        `Please register the event type using session.registerAggregate().`
      );
    }

    // Mark as "append" but with a sentinel expectedVersion of -1 so saveChangesAsync knows to fetch it.
    this.pendingOperations.push({
      type: "append",
      aggregateId,
      expectedVersion: -1, // will be resolved at commit time
      events,
      aggregateName: AggregateClass.aggregateName
    });
  }


  /**
   * Saves all pending operations and tracked aggregates in a single transaction.
   * All events are automatically enqueued to outbox for async processing.
   * Similar to Marten DB's SaveChangesAsync().
   * 
   * @example
   * const account = await session.loadAggregateAsync<AccountAggregate>("acc-1", AccountAggregate);
   * account.deposit(100);
   * await session.saveChangesAsync(); // Automatically saves account's pending events
   * 
   * @example
   * session.startStream(accountId, accountOpened);
   * session.append(accountId, 1, accountDeposited);
   * await session.saveChangesAsync(); // Commits everything in one transaction
   */
  async saveChangesAsync(): Promise<void> {
    // First, collect pending events from all tracked aggregates
    for (const [aggregateId, aggregate] of this.loadedAggregates.entries()) {
      const events = aggregate.pullPendingEvents();
      if (events.length === 0) continue;

      // Infer aggregate class from first event
      const firstEvent = events[0]!;
      const AggregateClass = this.inferAggregateFromEvent(firstEvent);
      
      if (!AggregateClass) {
        throw new Error(
          `Cannot infer aggregate class from event type "${firstEvent.type}". ` +
          `Please register the event type using session.registerAggregate().`
        );
      }

      // Queue the operation
      this.pendingOperations.push({
        type: "append",
        aggregateId,
        expectedVersion: aggregate.version,
        events,
        aggregateName: AggregateClass.aggregateName
      });
    }

    if (this.pendingOperations.length === 0) {
      return; // Nothing to save
    }

    const uow = new PgUnitOfWork(this.pool);
    await uow.withTransaction(async (tx: PgTx) => {
      const allAppendedEvents: EventEnvelope<E>[] = [];
      const aggregateVersions: Map<string, number> = new Map();
      const aggregateEvents: Map<string, EventEnvelope<E>[]> = new Map();

      for (const op of this.pendingOperations) {
        if (op.type === "startStream") {
          // Append with expectedVersion=0. The stream_versions INSERT in
          // store.append() catches "already exists" via PK violation.
          const result = await this.store.append(tx, {
            aggregateName: op.aggregateName,
            aggregateId: op.aggregateId,
            expectedAggregateVersion: 0,
            events: op.events,
            enqueueOutbox: true,
            outboxTopic: null
          });

          allAppendedEvents.push(...result.appended);
          aggregateVersions.set(op.aggregateId, result.nextAggregateVersion);
          const arr = aggregateEvents.get(op.aggregateId) || [];
          arr.push(...result.appended);
          aggregateEvents.set(op.aggregateId, arr);
        } else if (op.type === "append") {
          // Resolve expected version when -1 (appendUnsafe)
          let expectedVersion = op.expectedVersion;
          if (expectedVersion === -1) {
            const cur = await tx.client.query(
              `SELECT COALESCE(current_version, 0) AS v
               FROM ${this.store.streamVersionsTableName}
               WHERE aggregate_name = $1 AND aggregate_id = $2`,
              [op.aggregateName, op.aggregateId]
            );
            expectedVersion = Number(cur.rows[0]?.v ?? 0);
          }

          const result = await this.store.append(tx, {
            aggregateName: op.aggregateName,
            aggregateId: op.aggregateId,
            expectedAggregateVersion: expectedVersion,
            events: op.events,
            enqueueOutbox: true,
            outboxTopic: null
          });
          
          allAppendedEvents.push(...result.appended);
          aggregateVersions.set(op.aggregateId, result.nextAggregateVersion);
          const arr = aggregateEvents.get(op.aggregateId) || [];
          arr.push(...result.appended);
          aggregateEvents.set(op.aggregateId, arr);
          
          // Update tracked aggregate version after successful append
          const trackedAggregate = this.loadedAggregates.get(op.aggregateId);
          if (trackedAggregate) {
            trackedAggregate.version = result.nextAggregateVersion;
          }
        }
      }

      // Run inline projections if registered
      if (this.config.inlineProjector && allAppendedEvents.length > 0) {
        await this.config.inlineProjector.run(tx, allAppendedEvents);
      }

      // Create snapshots based on snapshot policy
      for (const [aggregateId, newVersion] of aggregateVersions.entries()) {
        // Find aggregate name for this aggregate ID
        const op = this.pendingOperations.find(p => p.aggregateId === aggregateId);
        if (!op) continue;

        const aggregateName = op.aggregateName;
        const snapshotStore = this.config.snapshotStoreRegistry.get(aggregateName);
        const snapshotPolicy = this.config.snapshotPolicyRegistry.get(aggregateName);
        const snapshotSchemaVersion = this.config.snapshotSchemaVersionRegistry.get(aggregateName) ?? 1;

        if (snapshotStore && snapshotPolicy && snapshotPolicy.everyNEvents > 0) {
          const shouldSnapshot = newVersion % snapshotPolicy.everyNEvents === 0;
          
          if (shouldSnapshot) {
            // Get the aggregate to snapshot its current state
            let aggregate = this.loadedAggregates.get(aggregateId);

            // If not tracked (e.g., startStream), reconstruct from appended events
            if (!aggregate) {
              const AggregateClass = this.getAggregateClass(aggregateName);
              const eventsForAgg = (aggregateEvents.get(aggregateId) || []).sort(
                (a, b) => Number(a.aggregateVersion) - Number(b.aggregateVersion)
              );
              if (AggregateClass && eventsForAgg.length > 0) {
                const aggInstance = new AggregateClass(aggregateId);
                aggInstance.version = 0;
                aggInstance.loadFromHistory(
                  eventsForAgg.map((e) => ({
                    payload: e.payload as any,
                    aggregateVersion: Number(e.aggregateVersion)
                  }))
                );
                aggregate = aggInstance;
              }
            }

            if (!aggregate) {
              continue;
            }

            const agg = aggregate;

            await snapshotStore.save(tx, {
              aggregateName,
              aggregateId,
              aggregateVersion: newVersion,
              snapshotSchemaVersion,
              createdAt: new Date().toISOString(),
              state: agg.state
            });
          }
        }
      }
    });

    // Clear pending operations after successful commit
    this.pendingOperations = [];
  }
}
