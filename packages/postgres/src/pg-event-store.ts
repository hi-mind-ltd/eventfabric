import { randomUUID } from "crypto";
import type { AnyEvent, EventEnvelope, EventUpcaster } from "@eventfabric/core";
import type { PgTx } from "./unitofwork/pg-transaction";

export class ConcurrencyError extends Error {
  constructor(message: string) { super(message); this.name = "ConcurrencyError"; }
}

/**
 * Thrown when a SQL row fails shape validation at the DB→domain boundary.
 * Signals schema drift, query typos, or database corruption — not a business
 * error. Surfacing this as a distinct class prevents malformed envelopes from
 * flowing into projections or aggregates.
 */
export class RowShapeError extends Error {
  constructor(message: string) { super(message); this.name = "RowShapeError"; }
}

/** Shape of an `eventfabric.events` row as returned by pg. Everything is still stringy
 *  or unknown — parsing happens in `mapRow` after validation. */
type PgEventRow = {
  event_id: string;
  aggregate_name: string;
  aggregate_id: string;
  aggregate_version: number | string;
  global_position: number | string | bigint;
  occurred_at: Date | string;
  payload: unknown;
  dismissed_at: Date | string | null;
  dismissed_reason: string | null;
  dismissed_by: string | null;
  correlation_id: string | null;
  causation_id: string | null;
};

function assertEventRow(r: unknown): asserts r is PgEventRow {
  if (r === null || typeof r !== "object") {
    throw new RowShapeError("eventfabric.events row is not an object");
  }
  const o = r as Record<string, unknown>;
  const required = [
    "event_id",
    "aggregate_name",
    "aggregate_id",
    "aggregate_version",
    "global_position",
    "occurred_at",
    "payload"
  ] as const;
  for (const field of required) {
    if (o[field] === undefined || o[field] === null) {
      throw new RowShapeError(`eventfabric.events row missing required field '${field}'`);
    }
  }
  // Payload must at least satisfy AnyEvent ({ type: string; version: number }).
  // We can't validate the full E union at runtime — TypeScript types are erased —
  // but we can catch the common failure modes (null payload, wrong JSON shape,
  // missing discriminator) cheaply.
  const payload = o.payload;
  if (typeof payload !== "object" || payload === null) {
    throw new RowShapeError("eventfabric.events row.payload is not an object");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.type !== "string" || typeof p.version !== "number") {
    throw new RowShapeError(
      "eventfabric.events row.payload is missing 'type' (string) or 'version' (number)"
    );
  }
}

export type LoadGlobalParams = {
  fromGlobalPositionExclusive: bigint;
  limit: number;
  includeDismissed?: boolean;
};

export type PgEventStoreOptions<E extends AnyEvent> = {
  /** Schema-qualified events table name. Default: "eventfabric.events" */
  eventsTable?: string;
  /** Schema-qualified outbox table name. Default: "eventfabric.outbox" */
  outboxTable?: string;
  /** Schema-qualified stream_versions table name. Default: "eventfabric.stream_versions" */
  streamVersionsTable?: string;
  /**
   * Optional transform applied to every loaded event payload after shape
   * validation. Use this to migrate historical events to the current schema
   * when you ship a new event version, so replay keeps working without
   * rewriting the event log. Fast-path pass-through for current-shape events
   * is the caller's responsibility — the upcaster runs on every load.
   */
  upcaster?: EventUpcaster<E>;
};

export class PgEventStore<E extends AnyEvent> {
  private readonly eventsTable: string;
  private readonly outboxTable: string;
  private readonly upcaster?: EventUpcaster<E>;
  private readonly streamVersionsTable: string;

  constructor(opts?: PgEventStoreOptions<E>) {
    this.eventsTable = opts?.eventsTable ?? "eventfabric.events";
    this.outboxTable = opts?.outboxTable ?? "eventfabric.outbox";
    this.streamVersionsTable = opts?.streamVersionsTable ?? "eventfabric.stream_versions";
    this.upcaster = opts?.upcaster;
  }

  /** The schema-qualified table name for events (e.g. "eventfabric.events"). */
  get tableName(): string {
    return this.eventsTable;
  }

  /** The schema-qualified table name for stream versions. */
  get streamVersionsTableName(): string {
    return this.streamVersionsTable;
  }

  async append(
    tx: PgTx,
    params: {
      aggregateName: string;
      aggregateId: string;
      expectedAggregateVersion: number;
      events: E[];
      meta?: { correlationId?: string; causationId?: string };
      enqueueOutbox?: boolean;
      outboxTopic?: string | null;
    }
  ): Promise<{ appended: EventEnvelope<E>[]; nextAggregateVersion: number }> {
    if (params.events.length === 0) return { appended: [], nextAggregateVersion: params.expectedAggregateVersion };

    const { aggregateName, aggregateId, expectedAggregateVersion } = params;
    const eventCount = params.events.length;
    const newVersion = expectedAggregateVersion + eventCount;

    // Atomic concurrency gate via stream_versions table.
    // This replaces the previous SELECT MAX + UNIQUE constraint approach.
    // A single UPDATE ... WHERE current_version = expected is atomic — no
    // TOCTOU race, no need for a UNIQUE constraint on the events table.
    // Pattern: Marten DB (mt_streams), SQLStreamStore (Streams), EventStoreDB.
    const tenantId = tx.tenantId;

    if (expectedAggregateVersion === 0) {
      // New stream — INSERT into stream_versions. PK violation = stream already exists.
      try {
        await tx.client.query(
          `INSERT INTO ${this.streamVersionsTable} (tenant_id, aggregate_name, aggregate_id, current_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, now(), now())`,
          [tenantId, aggregateName, aggregateId, eventCount]
        );
      } catch (err: any) {
        if (err?.code === "23505") {
          throw new ConcurrencyError(
            `Cannot start stream: ${aggregateName}:${aggregateId} already exists`
          );
        }
        throw err;
      }
    } else {
      // Existing stream — atomic version bump. 0 rows updated = someone else moved the version.
      const result = await tx.client.query(
        `UPDATE ${this.streamVersionsTable}
         SET current_version = $4, updated_at = now()
         WHERE tenant_id = $1 AND aggregate_name = $2 AND aggregate_id = $3 AND current_version = $5`,
        [tenantId, aggregateName, aggregateId, newVersion, expectedAggregateVersion]
      );
      if (result.rowCount === 0) {
        // Fetch actual version for a helpful error message
        const actual = await tx.client.query(
          `SELECT current_version FROM ${this.streamVersionsTable}
           WHERE tenant_id = $1 AND aggregate_name = $2 AND aggregate_id = $3`,
          [tenantId, aggregateName, aggregateId]
        );
        const actualVersion = actual.rows[0]?.current_version ?? "(stream not found)";
        throw new ConcurrencyError(
          `Expected version ${expectedAggregateVersion} but stream ${aggregateName}:${aggregateId} is at ${actualVersion}`
        );
      }
    }

    // Build and insert events
    const base = expectedAggregateVersion;
    const values: any[] = [];
    const rowsSql = params.events.map((evt, i) => {
      const idx = i * 10;
      const eventId = randomUUID();
      values.push(
        eventId,
        tenantId,
        aggregateName,
        aggregateId,
        base + i + 1,
        evt.type,
        evt.version,
        JSON.stringify(evt),
        params.meta?.correlationId ?? null,
        params.meta?.causationId ?? null
      );
      return `($${idx+1}::uuid,$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8}::jsonb,now(),$${idx+9},$${idx+10})`;
    }).join(",");

    const ins = await tx.client.query(
      `INSERT INTO ${this.eventsTable}
        (event_id, tenant_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at, correlation_id, causation_id)
       VALUES ${rowsSql}
       RETURNING global_position, event_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at,
                 dismissed_at, dismissed_reason, dismissed_by, correlation_id, causation_id`,
      values
    );

    const appended = ins.rows.map((r) => this.mapRow(r));

    if (params.enqueueOutbox) {
      const topic = params.outboxTopic ?? null;
      const gps = appended.map((env) => env.globalPosition.toString());
      const tenantParamIndex = gps.length + 1;
      const topicParamIndex = gps.length + 2;
      const valuesSql2 = gps.map((_, i) => `($${i+1}, $${tenantParamIndex}, $${topicParamIndex})`).join(",");
      await tx.client.query(
        `INSERT INTO ${this.outboxTable} (global_position, tenant_id, topic)
         VALUES ${valuesSql2}
         ON CONFLICT (global_position) DO NOTHING`,
        [...gps, tenantId, topic]
      );
    }

    return { appended, nextAggregateVersion: newVersion };
  }

  /**
   * Marten-style API: Start a new event stream with initial events.
   * Similar to Marten's StartStream(questId, started, joined1)
   * 
   * @example
   * await eventStore.startStream(tx, accountId, AccountAggregate, 
   *   { type: "AccountOpened", version: 1, accountId, customerId, initialBalance: 100, currency: "USD" },
   *   { type: "AccountDeposited", version: 1, accountId, amount: 50, balance: 150 }
   * );
   */
  async startStream(
    tx: PgTx,
    aggregateId: string,
    AggregateClass: { aggregateName: string } & (new (...args: any[]) => any),
    ...events: E[]
  ): Promise<{ appended: EventEnvelope<E>[]; nextAggregateVersion: number }>;
  async startStream(
    tx: PgTx,
    aggregateId: string,
    AggregateClass: { aggregateName: string } & (new (...args: any[]) => any),
    ...events: E[]
  ): Promise<{ appended: EventEnvelope<E>[]; nextAggregateVersion: number }> {
    if (!AggregateClass || !AggregateClass.aggregateName) {
      throw new Error("AggregateClass with aggregateName static property is required");
    }

    if (events.length === 0) {
      throw new Error("At least one event is required to start a stream");
    }

    const aggregateName = AggregateClass.aggregateName;

    // Delegate to append with expectedVersion=0. The stream_versions INSERT
    // in append() catches "stream already exists" via PK violation.
    return this.append(tx, {
      aggregateName,
      aggregateId,
      expectedAggregateVersion: 0,
      events,
      enqueueOutbox: false,
      outboxTopic: null
    });
  }

  async loadStream(
    tx: PgTx,
    params: { aggregateName: string; aggregateId: string; fromVersion?: number; includeDismissed?: boolean }
  ): Promise<EventEnvelope<E>[]>;
  // Marten-style API: loadStream(tx, aggregateId, AggregateClass)
  // Similar to Marten's AggregateStreamAsync<Invoice>(invoiceId)
  async loadStream(
    tx: PgTx,
    aggregateId: string,
    AggregateClass: { aggregateName: string } & (new (...args: any[]) => any)
  ): Promise<EventEnvelope<E>[]>;
  async loadStream(
    tx: PgTx,
    paramsOrAggregateId: { aggregateName: string; aggregateId: string; fromVersion?: number; includeDismissed?: boolean } | string,
    AggregateClass?: { aggregateName?: string } & (new (...args: any[]) => any)
  ): Promise<EventEnvelope<E>[]> {
    let aggregateName: string;
    let aggregateId: string;
    let fromVersion: number | undefined;
    let includeDismissed: boolean | undefined;

    if (typeof paramsOrAggregateId === "string") {
      // Marten-style overload: loadStream(tx, aggregateId, AggregateClass)
      // Similar to Marten's AggregateStreamAsync<Invoice>(invoiceId)
      if (!AggregateClass || !AggregateClass.aggregateName) {
        throw new Error("AggregateClass with aggregateName static property is required");
      }
      aggregateName = AggregateClass.aggregateName;
      aggregateId = paramsOrAggregateId;
    } else {
      // Original overload: loadStream(tx, { aggregateName, aggregateId, ... })
      aggregateName = paramsOrAggregateId.aggregateName;
      aggregateId = paramsOrAggregateId.aggregateId;
      fromVersion = paramsOrAggregateId.fromVersion;
      includeDismissed = paramsOrAggregateId.includeDismissed;
    }

    const from = fromVersion ?? 1;
    const res = await tx.client.query(
      `SELECT global_position, event_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at,
              dismissed_at, dismissed_reason, dismissed_by, correlation_id, causation_id
       FROM ${this.eventsTable}
       WHERE tenant_id = $1 AND aggregate_name = $2 AND aggregate_id = $3 AND aggregate_version >= $4
       ORDER BY aggregate_version ASC`,
      [tx.tenantId, aggregateName, aggregateId, from]
    );

    const envs = res.rows.map((r) => this.mapRow(r));
    return includeDismissed ? envs : envs.filter(e => !e.dismissed);
  }

  async loadGlobal(tx: PgTx, p: LoadGlobalParams): Promise<EventEnvelope<E>[]> {
    const res = await tx.client.query(
      `SELECT global_position, event_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at,
              dismissed_at, dismissed_reason, dismissed_by, correlation_id, causation_id
       FROM ${this.eventsTable}
       WHERE tenant_id = $1 AND global_position > $2
       ORDER BY global_position ASC
       LIMIT $3`,
      [tx.tenantId, p.fromGlobalPositionExclusive.toString(), p.limit]
    );
    const envs = res.rows.map((r) => this.mapRow(r));
    return p.includeDismissed ? envs : envs.filter(e => !e.dismissed);
  }

  async loadByGlobalPositions(tx: PgTx, positions: bigint[]): Promise<EventEnvelope<E>[]> {
    if (positions.length === 0) return [];
    const params: any[] = [tx.tenantId];
    const placeholders = positions.map((p, i) => {
      params.push(p.toString());
      return `$${i+2}`;
    }).join(",");
    const res = await tx.client.query(
      `SELECT global_position, event_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at,
              dismissed_at, dismissed_reason, dismissed_by, correlation_id, causation_id
       FROM ${this.eventsTable}
       WHERE tenant_id = $1 AND global_position IN (${placeholders})
       ORDER BY global_position ASC`,
      params
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async dismiss(tx: PgTx, eventId: string, info?: { reason?: string; by?: string; at?: string }): Promise<void> {
    const at = info?.at ?? new Date().toISOString();
    await tx.client.query(
      `UPDATE ${this.eventsTable}
       SET dismissed_at = $3::timestamptz,
           dismissed_reason = $4,
           dismissed_by = $5
       WHERE tenant_id = $1 AND event_id = $2::uuid`,
      [tx.tenantId, eventId, at, info?.reason ?? null, info?.by ?? null]
    );
  }

  private mapRow(r: unknown): EventEnvelope<E> {
    assertEventRow(r);
    // After assertEventRow, r.payload is known to satisfy { type: string; version: number }.
    // Run the upcaster (if configured) to migrate historical payloads to the current shape.
    const payload = this.upcaster
      ? this.upcaster(r.payload as AnyEvent)
      : (r.payload as E);
    return {
      eventId: r.event_id,
      aggregateName: r.aggregate_name,
      aggregateId: r.aggregate_id,
      aggregateVersion: Number(r.aggregate_version),
      globalPosition: BigInt(r.global_position as string | number | bigint),
      occurredAt: new Date(r.occurred_at).toISOString(),
      payload,
      dismissed: r.dismissed_at ? {
        at: new Date(r.dismissed_at).toISOString(),
        reason: r.dismissed_reason ?? undefined,
        by: r.dismissed_by ?? undefined
      } : undefined,
      correlationId: r.correlation_id ?? undefined,
      causationId: r.causation_id ?? undefined
    };
  }
}
