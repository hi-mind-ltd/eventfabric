import { randomUUID } from "crypto";
import type {
  AnyEvent,
  EventEnvelope,
  EventUpcaster,
  ChainVerificationResult,
  TamperEvidentEventStore,
} from "@eventfabric/core";
import { computeEventHash, streamGenesis, hashesEqual, toSecret } from "@eventfabric/core";
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
  tenant_id: string;
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
  /**
   * Optional tenant filter. When set, only events from this tenant are
   * returned. When omitted, events are returned across all tenants — caller
   * must handle the cross-tenant case responsibly (e.g. for ops tooling).
   * The catch-up projector always sets this.
   */
  tenantId?: string;
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
  /**
   * Enables tamper-evident hash chaining (requires migration 015). `secret` is
   * the HMAC key — keep it in env/KMS, never in the database; without it an
   * attacker who can write the DB could forge the chain. `enabledAggregates`
   * lists the aggregate names to chain; you can also enable them later via
   * {@link PgEventStore.enableHashChainFor} (which is what
   * `SessionFactory.registerAggregate` calls for aggregates that declare
   * `static tamperEvident = true`).
   *
   * When this option is absent the feature is fully dormant: `append` runs the
   * original SQL with no reference to the hash columns, so stores that never
   * opt in don't even need migration 015.
   */
  hashChain?: {
    secret: string | Buffer;
    enabledAggregates?: Iterable<string>;
  };
};

export class PgEventStore<E extends AnyEvent> implements TamperEvidentEventStore<E, PgTx> {
  private readonly eventsTable: string;
  private readonly outboxTable: string;
  private readonly upcaster?: EventUpcaster<E>;
  private readonly streamVersionsTable: string;
  /** HMAC key for hash chaining, or undefined when the feature is off. */
  private readonly hashSecret?: Buffer;
  /** Aggregate names whose streams are hash-chained. Mutable so registration
   *  (registerAggregate) can add to it after construction. */
  private readonly hashEnabled: Set<string>;

  constructor(opts?: PgEventStoreOptions<E>) {
    this.eventsTable = opts?.eventsTable ?? "eventfabric.events";
    this.outboxTable = opts?.outboxTable ?? "eventfabric.outbox";
    this.streamVersionsTable = opts?.streamVersionsTable ?? "eventfabric.stream_versions";
    this.upcaster = opts?.upcaster;
    this.hashSecret = opts?.hashChain ? toSecret(opts.hashChain.secret) : undefined;
    this.hashEnabled = new Set(opts?.hashChain?.enabledAggregates ?? []);
  }

  /**
   * Mark an aggregate's streams as tamper-evident (hash-chained). Requires the
   * store to have been constructed with `hashChain.secret`. Called by
   * `SessionFactory.registerAggregate` when an aggregate declares
   * `static tamperEvident = true`.
   */
  enableHashChainFor(aggregateName: string): void {
    if (this.hashSecret === undefined) {
      throw new Error(
        `Cannot enable tamper-evidence for "${aggregateName}": PgEventStore was constructed ` +
        `without hashChain.secret. Pass { hashChain: { secret } } to the PgEventStore constructor.`
      );
    }
    this.hashEnabled.add(aggregateName);
  }

  /** True when the chaining feature is configured at all (secret present). */
  private get hashFeatureOn(): boolean {
    return this.hashSecret !== undefined;
  }

  /** True when this specific aggregate's streams should be chained. */
  private isChained(aggregateName: string): boolean {
    return this.hashSecret !== undefined && this.hashEnabled.has(aggregateName);
  }

  /**
   * Compute the chain hash for each event in a batch, in version order, linking
   * the first to `prev` (the stream's current head or genesis). Returns the
   * per-event hashes and the new head (the last event's hash).
   */
  private chainBatch(
    prev: Buffer,
    tenantId: string,
    aggregateName: string,
    aggregateId: string,
    base: number,
    eventIds: string[],
    events: E[],
    meta?: { correlationId?: string; causationId?: string }
  ): { hashes: Buffer[]; head: Buffer } {
    const secret = this.hashSecret!;
    const hashes: Buffer[] = [];
    let p = prev;
    for (let i = 0; i < events.length; i++) {
      const evt = events[i]!;
      const h = computeEventHash(secret, p, {
        tenantId,
        aggregateName,
        aggregateId,
        aggregateVersion: base + i + 1,
        eventId: eventIds[i]!,
        type: evt.type,
        version: evt.version,
        payload: evt,
        correlationId: meta?.correlationId ?? null,
        causationId: meta?.causationId ?? null,
      });
      hashes.push(h);
      p = h;
    }
    return { hashes, head: p };
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
    const base = expectedAggregateVersion;
    const chained = this.isChained(aggregateName);

    // Event ids are generated up front so chained hashes can incorporate them.
    const eventIds = params.events.map(() => randomUUID());
    // Per-event chain hashes — null for unchained aggregates. Filled in once we
    // know the stream's previous head (genesis for a new stream, head_hash for
    // an existing one).
    let eventHashes: (Buffer | null)[] = params.events.map(() => null);

    if (expectedAggregateVersion === 0) {
      // New stream — INSERT into stream_versions. PK violation = stream already exists.
      let head: Buffer | null = null;
      if (chained) {
        const genesis = streamGenesis(this.hashSecret!, tenantId, aggregateName, aggregateId);
        const r = this.chainBatch(genesis, tenantId, aggregateName, aggregateId, base, eventIds, params.events, params.meta);
        eventHashes = r.hashes;
        head = r.head;
      }
      try {
        if (this.hashFeatureOn) {
          await tx.client.query(
            `INSERT INTO ${this.streamVersionsTable} (tenant_id, aggregate_name, aggregate_id, current_version, head_hash, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, now(), now())`,
            [tenantId, aggregateName, aggregateId, eventCount, head]
          );
        } else {
          await tx.client.query(
            `INSERT INTO ${this.streamVersionsTable} (tenant_id, aggregate_name, aggregate_id, current_version, created_at, updated_at)
             VALUES ($1, $2, $3, $4, now(), now())`,
            [tenantId, aggregateName, aggregateId, eventCount]
          );
        }
      } catch (err: any) {
        if (err?.code === "23505") {
          throw new ConcurrencyError(
            `Cannot start stream: ${aggregateName}:${aggregateId} already exists`
          );
        }
        throw err;
      }
    } else if (chained) {
      // Chained existing stream — lock the row to read the current head atomically,
      // then bump version + head together. Same isolation outcome as the blind
      // UPDATE below, with one extra round-trip to fetch the prev hash.
      const locked = await tx.client.query(
        `SELECT current_version, head_hash FROM ${this.streamVersionsTable}
         WHERE tenant_id = $1 AND aggregate_name = $2 AND aggregate_id = $3
         FOR UPDATE`,
        [tenantId, aggregateName, aggregateId]
      );
      const row = locked.rows[0];
      const actualVersion = row ? Number(row.current_version) : undefined;
      if (actualVersion !== expectedAggregateVersion) {
        throw new ConcurrencyError(
          `Expected version ${expectedAggregateVersion} but stream ${aggregateName}:${aggregateId} is at ${actualVersion ?? "(stream not found)"}`
        );
      }
      // head_hash is NULL when the stream predates tamper-evidence being enabled;
      // start the chain from genesis so events from here forward are protected.
      const prev: Buffer =
        (row.head_hash as Buffer | null) ?? streamGenesis(this.hashSecret!, tenantId, aggregateName, aggregateId);
      const r = this.chainBatch(prev, tenantId, aggregateName, aggregateId, base, eventIds, params.events, params.meta);
      eventHashes = r.hashes;
      await tx.client.query(
        `UPDATE ${this.streamVersionsTable}
         SET current_version = $4, head_hash = $5, updated_at = now()
         WHERE tenant_id = $1 AND aggregate_name = $2 AND aggregate_id = $3`,
        [tenantId, aggregateName, aggregateId, newVersion, r.head]
      );
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
    const values: any[] = [];
    const perRow = this.hashFeatureOn ? 11 : 10;
    const rowsSql = params.events.map((evt, i) => {
      const idx = i * perRow;
      values.push(
        eventIds[i],
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
      if (this.hashFeatureOn) {
        values.push(eventHashes[i]);
        return `($${idx+1}::uuid,$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8}::jsonb,now(),$${idx+9},$${idx+10},$${idx+11})`;
      }
      return `($${idx+1}::uuid,$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8}::jsonb,now(),$${idx+9},$${idx+10})`;
    }).join(",");

    const columns = this.hashFeatureOn
      ? "(event_id, tenant_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at, correlation_id, causation_id, event_hash)"
      : "(event_id, tenant_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at, correlation_id, causation_id)";

    const ins = await tx.client.query(
      `INSERT INTO ${this.eventsTable}
        ${columns}
       VALUES ${rowsSql}
       RETURNING global_position, event_id, tenant_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at,
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
      `SELECT global_position, event_id, tenant_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at,
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
    // Tenant filter lives in the SQL (not post-filtered in JS) so the
    // catch-up projector can read a batch of one tenant's events without
    // pulling other tenants' rows over the wire. Index
    // `events_stream_covering_idx` leads with tenant_id.
    const res = p.tenantId === undefined
      ? await tx.client.query(
          `SELECT global_position, event_id, tenant_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at,
                  dismissed_at, dismissed_reason, dismissed_by, correlation_id, causation_id
           FROM ${this.eventsTable}
           WHERE global_position > $1
           ORDER BY global_position ASC
           LIMIT $2`,
          [p.fromGlobalPositionExclusive.toString(), p.limit]
        )
      : await tx.client.query(
          `SELECT global_position, event_id, tenant_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at,
                  dismissed_at, dismissed_reason, dismissed_by, correlation_id, causation_id
           FROM ${this.eventsTable}
           WHERE tenant_id = $1 AND global_position > $2
           ORDER BY global_position ASC
           LIMIT $3`,
          [p.tenantId, p.fromGlobalPositionExclusive.toString(), p.limit]
        );
    const envs = res.rows.map((r) => this.mapRow(r));
    return p.includeDismissed ? envs : envs.filter(e => !e.dismissed);
  }

  /**
   * Return the distinct tenant ids with events at `global_position` greater
   * than the given bound. Used by the catch-up projector to discover which
   * tenants have pending work to fan out each round.
   *
   * Re-queried every round (no caching) so tenants onboarded at runtime are
   * picked up without extra coordination. The scan is bounded by the
   * tenant_id leading index on `events`, and in practice the result set is
   * small (active tenant count, not row count).
   */
  async discoverActiveTenants(
    tx: PgTx,
    params: { fromGlobalPositionExclusive: bigint; limit?: number }
  ): Promise<string[]> {
    const limit = params.limit ?? 10_000;
    const res = await tx.client.query(
      `SELECT DISTINCT tenant_id
       FROM ${this.eventsTable}
       WHERE global_position > $1
       ORDER BY tenant_id ASC
       LIMIT $2`,
      [params.fromGlobalPositionExclusive.toString(), limit]
    );
    return res.rows.map((r: any) => r.tenant_id as string);
  }

  async loadByGlobalPositions(tx: PgTx, positions: bigint[]): Promise<EventEnvelope<E>[]> {
    if (positions.length === 0) return [];
    const params = positions.map(p => p.toString());
    const placeholders = params.map((_, i) => `$${i+1}`).join(",");
    const res = await tx.client.query(
      `SELECT global_position, event_id, tenant_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload, occurred_at,
              dismissed_at, dismissed_reason, dismissed_by, correlation_id, causation_id
       FROM ${this.eventsTable}
       WHERE global_position IN (${placeholders})
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

  /**
   * Walk a single stream's hash chain and report whether it is intact. Reads
   * the raw stored payload (NOT upcasted — the hash is over the stored bytes),
   * including dismissed events (a soft-dismiss does not remove an event from
   * the chain). Detects payload/metadata mutation, event removal (version gap
   * or NULL hash inside the chain), and tail removal (head mismatch).
   *
   * Streams that began chaining mid-life (tamper-evidence enabled after some
   * events already existed) are verified from their first protected event
   * onward; earlier NULL-hash events are out of scope.
   */
  async verifyStream(
    tx: PgTx,
    params: { aggregateName: string; aggregateId: string }
  ): Promise<ChainVerificationResult> {
    if (this.hashSecret === undefined) {
      throw new Error("verifyStream requires the store to be constructed with hashChain.secret");
    }
    const secret = this.hashSecret;
    const tenantId = tx.tenantId;
    const { aggregateName, aggregateId } = params;
    const base: ChainVerificationResult = {
      ok: true, tenantId, aggregateName, aggregateId, eventsChecked: 0, firstBrokenAt: null,
    };

    const res = await tx.client.query(
      `SELECT aggregate_version, event_id, type, version, payload, correlation_id, causation_id, event_hash
       FROM ${this.eventsTable}
       WHERE tenant_id = $1 AND aggregate_name = $2 AND aggregate_id = $3
       ORDER BY aggregate_version ASC`,
      [tenantId, aggregateName, aggregateId]
    );
    const rows = res.rows;

    const headRes = await tx.client.query(
      `SELECT head_hash FROM ${this.streamVersionsTable}
       WHERE tenant_id = $1 AND aggregate_name = $2 AND aggregate_id = $3`,
      [tenantId, aggregateName, aggregateId]
    );
    const storedHead: Buffer | null = headRes.rows[0]?.head_hash ?? null;

    const chainStart = rows.findIndex((r: any) => r.event_hash !== null);
    if (chainStart === -1) {
      // No protected events. Consistent only if there is no stored head either.
      if (storedHead) {
        return { ...base, ok: false, firstBrokenAt: rows.length ? Number(rows[rows.length - 1].aggregate_version) : 0,
          reason: "stream_versions.head_hash is set but the stream has no protected events" };
      }
      return base;
    }

    let prev = streamGenesis(secret, tenantId, aggregateName, aggregateId);
    let checked = 0;
    let expectedVersion = Number(rows[chainStart].aggregate_version);
    for (let i = chainStart; i < rows.length; i++) {
      const r: any = rows[i];
      const version = Number(r.aggregate_version);
      if (r.event_hash === null) {
        return { ...base, ok: false, eventsChecked: checked, firstBrokenAt: version,
          reason: "NULL event_hash inside the protected chain (event removed or never chained)" };
      }
      if (version !== expectedVersion) {
        return { ...base, ok: false, eventsChecked: checked, firstBrokenAt: expectedVersion,
          reason: `version gap: expected ${expectedVersion}, found ${version} (event removed)` };
      }
      const recomputed = computeEventHash(secret, prev, {
        tenantId,
        aggregateName,
        aggregateId,
        aggregateVersion: version,
        eventId: r.event_id,
        type: r.type,
        version: Number(r.version),
        payload: r.payload,
        correlationId: r.correlation_id ?? null,
        causationId: r.causation_id ?? null,
      });
      if (!hashesEqual(recomputed, r.event_hash as Buffer)) {
        return { ...base, ok: false, eventsChecked: checked, firstBrokenAt: version,
          reason: "event_hash mismatch (payload or metadata altered)" };
      }
      prev = recomputed;
      checked++;
      expectedVersion = version + 1;
    }

    if (!hashesEqual(prev, storedHead)) {
      return { ...base, ok: false, eventsChecked: checked, firstBrokenAt: expectedVersion - 1,
        reason: "head_hash mismatch (tail event(s) removed or head tampered)" };
    }
    return { ...base, eventsChecked: checked };
  }

  /**
   * Verify every stream of the given aggregate for the transaction's tenant.
   * Returns one result per stream; callers typically filter on `!r.ok`.
   */
  async verifyAggregate(
    tx: PgTx,
    params: { aggregateName: string }
  ): Promise<ChainVerificationResult[]> {
    const res = await tx.client.query(
      `SELECT aggregate_id FROM ${this.streamVersionsTable}
       WHERE tenant_id = $1 AND aggregate_name = $2
       ORDER BY aggregate_id ASC`,
      [tx.tenantId, params.aggregateName]
    );
    const out: ChainVerificationResult[] = [];
    for (const row of res.rows) {
      out.push(await this.verifyStream(tx, { aggregateName: params.aggregateName, aggregateId: row.aggregate_id }));
    }
    return out;
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
      tenantId: r.tenant_id ?? "default",
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
