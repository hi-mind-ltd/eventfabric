export type AnyEvent = { type: string; version: number };

/**
 * Transforms a stored event payload into the current-shape event.
 *
 * Called by an event store on every loaded event payload after basic shape
 * validation (type + version present). The upcaster decides, based on
 * `raw.type` and `raw.version`, whether to rewrite the payload to the current
 * schema. Events already in the current shape should be returned as-is —
 * the upcaster runs on every load, so the fast path must be cheap.
 *
 * Writers are always current-shape; upcasting only matters on reads of
 * historical events after a schema bump.
 */
export type EventUpcaster<E extends AnyEvent> = (raw: AnyEvent) => E;

export type EventEnvelope<E extends AnyEvent> = {
  eventId: string;
  tenantId: string;
  aggregateName: string;
  aggregateId: string;
  aggregateVersion: number;
  globalPosition: bigint;
  occurredAt: string;
  payload: E;
  dismissed?: { at: string; reason?: string; by?: string };
  correlationId?: string;
  causationId?: string;
};

export interface Transaction {}

export interface UnitOfWork<TTx extends Transaction = Transaction> {
  withTransaction<T>(fn: (tx: TTx) => Promise<T>): Promise<T>;
}

export interface EventStore<E extends AnyEvent, TTx extends Transaction = Transaction> {
  append(
    tx: TTx,
    params: {
      aggregateName: string;
      aggregateId: string;
      expectedAggregateVersion: number;
      events: E[];
      meta?: { correlationId?: string; causationId?: string };
      enqueueOutbox?: boolean;
      outboxTopic?: string | null;
    }
  ): Promise<{ appended: EventEnvelope<E>[]; nextAggregateVersion: number }>;

  startStream?(
    tx: TTx,
    aggregateId: string,
    AggregateClass: { aggregateName: string } & (new (...args: any[]) => any),
    ...events: E[]
  ): Promise<{ appended: EventEnvelope<E>[]; nextAggregateVersion: number }>;

  loadStream(
    tx: TTx,
    params: {
      aggregateName: string;
      aggregateId: string;
      fromVersion?: number;
      includeDismissed?: boolean;
    }
  ): Promise<EventEnvelope<E>[]>;

  loadGlobal(
    tx: TTx,
    params: {
      fromGlobalPositionExclusive: bigint;
      limit: number;
      includeDismissed?: boolean;
      /**
       * Optional tenant filter. When set, only events with this tenant_id are
       * returned. When omitted, events are returned across all tenants — used
       * by cross-tenant tooling (ops dashboards, migrations). The catch-up
       * projector always sets this so each projection round is single-tenant.
       */
      tenantId?: string;
    }
  ): Promise<EventEnvelope<E>[]>;

  loadByGlobalPositions(
    tx: TTx,
    positions: bigint[]
  ): Promise<EventEnvelope<E>[]>;

  /**
   * Returns the set of tenant ids that have events at `global_position` >
   * `fromGlobalPositionExclusive`. Used by the catch-up projector to discover
   * which tenants have work pending this round, so it can fan out a single
   * round into one transaction per active tenant.
   *
   * A fresh query is done every round (no caching) so tenants onboarded at
   * runtime are picked up with no extra coordination.
   */
  discoverActiveTenants(
    tx: TTx,
    params: { fromGlobalPositionExclusive: bigint; limit?: number }
  ): Promise<string[]>;

  dismiss(tx: TTx, eventId: string, info?: { reason?: string; by?: string; at?: string }): Promise<void>;
}
