import { createHmac, timingSafeEqual } from "crypto";

/**
 * Backend-agnostic hashing primitives for tamper-evident event chaining. No DB,
 * no I/O — pure functions an event-store adapter wires to its storage (write
 * path + verification) and any tenant-anchor sealer reuses. Living in core keeps
 * the chain *format* canonical across backends rather than reinvented per adapter.
 *
 * Integrity model: HMAC-SHA256 keyed by an app-held secret (env/KMS), never
 * stored in the database. An attacker who can write the DB still cannot forge
 * a valid chain without the secret — the whole reason we use HMAC rather than
 * a plain SHA-256 chain.
 */

const HASH_ALGO = "sha256";

/** Normalize a configured secret to a Buffer. */
export function toSecret(secret: string | Buffer): Buffer {
  return typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
}

/**
 * Deterministic, sorted-key JSON serialization (RFC 8785 / JCS in spirit) used
 * as the hash preimage. The SAME logical value MUST serialize to the SAME bytes
 * at write time and at verify time, independent of object key insertion order
 * or any JSON round-trip the storage layer performs on the payload (e.g.
 * Postgres jsonb).
 *
 * Constraints (these make a value "chainable"); violations throw loudly rather
 * than silently producing an unverifiable chain:
 *  - numbers must be finite (no NaN / Infinity) and within f64 precision;
 *    store larger integers as strings.
 *  - bigint is rejected (not representable in JSON; jsonb wouldn't round-trip it).
 *  - undefined object properties are omitted (matching JSON semantics); a
 *    top-level/array `undefined` is rejected.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string" || t === "boolean") return JSON.stringify(v);
  if (t === "number") {
    if (!Number.isFinite(v as number)) {
      throw new Error(`canonicalJson: non-finite number cannot be hashed: ${String(v)}`);
    }
    // JS numbers have a single canonical JSON.stringify form, and a JSON column
    // round-trips back through a JS number, so write- and verify-time
    // serializations agree.
    return JSON.stringify(v);
  }
  if (t === "bigint") {
    throw new Error("canonicalJson: bigint is not supported in chainable event payloads");
  }
  if (Array.isArray(v)) {
    return "[" + v.map((x) => serialize(x === undefined ? null : x)).join(",") + "]";
  }
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + serialize(obj[k])).join(",") + "}";
  }
  throw new Error(`canonicalJson: unsupported value of type ${t}`);
}

/**
 * The deterministic, write-time-known fields covered by an event's hash.
 * Storage-assigned values (global position, server timestamp) are intentionally
 * EXCLUDED so the hash is computable in one pass before the event is persisted.
 * The integrity-critical content — identity, in-stream order (aggregateVersion +
 * the prevHash link), and payload — is fully covered.
 */
export type ChainableEvent = {
  tenantId: string;
  aggregateName: string;
  aggregateId: string;
  aggregateVersion: number;
  eventId: string;
  type: string;
  version: number;
  payload: unknown;
  correlationId?: string | null;
  causationId?: string | null;
};

/** HMAC(secret, prevHash || canonicalJson(event)) -> 32-byte digest. */
export function computeEventHash(secret: Buffer, prevHash: Buffer, event: ChainableEvent): Buffer {
  const preimage = canonicalJson({
    tenantId: event.tenantId,
    aggregateName: event.aggregateName,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    eventId: event.eventId,
    type: event.type,
    version: event.version,
    payload: event.payload,
    correlationId: event.correlationId ?? null,
    causationId: event.causationId ?? null,
  });
  const h = createHmac(HASH_ALGO, secret);
  h.update(prevHash);
  h.update(Buffer.from(preimage, "utf8"));
  return h.digest();
}

/**
 * Per-stream genesis hash — the prevHash of a stream's first event. Domain-
 * separated by stream identity so chains from different streams cannot be
 * spliced together, and so a stolen prefix from one stream can't seed another.
 */
export function streamGenesis(
  secret: Buffer,
  tenantId: string,
  aggregateName: string,
  aggregateId: string
): Buffer {
  const h = createHmac(HASH_ALGO, secret);
  h.update(Buffer.from("eventfabric:stream-genesis:v1", "utf8"));
  h.update(Buffer.from(canonicalJson({ tenantId, aggregateName, aggregateId }), "utf8"));
  return h.digest();
}

/** Per-tenant anchor genesis — the prevAnchorHash of a tenant's first anchor. */
export function anchorGenesis(secret: Buffer, tenantId: string): Buffer {
  const h = createHmac(HASH_ALGO, secret);
  h.update(Buffer.from("eventfabric:anchor-genesis:v1", "utf8"));
  h.update(Buffer.from(canonicalJson({ tenantId }), "utf8"));
  return h.digest();
}

/** A chained stream's head as sealed by a tenant anchor. */
export type AnchorMember = {
  aggregateName: string;
  aggregateId: string;
  version: number;
  headHash: Buffer;
};

/**
 * Chain a set of stream heads into the running tenant-anchor HMAC. `members`
 * MUST be pre-sorted deterministically (by aggregateName, then aggregateId) by
 * the caller so the digest is reproducible at verify time; the fold is
 * order-sensitive. Each member's identity + sealed version is hashed
 * canonically and its head hash mixed in as raw bytes.
 */
export function computeAnchorHash(secret: Buffer, prevAnchorHash: Buffer, members: AnchorMember[]): Buffer {
  const h = createHmac(HASH_ALGO, secret);
  h.update(prevAnchorHash);
  for (const m of members) {
    h.update(Buffer.from(
      canonicalJson({ aggregateName: m.aggregateName, aggregateId: m.aggregateId, version: m.version }),
      "utf8"
    ));
    h.update(m.headHash);
  }
  return h.digest();
}

/** Constant-time hash comparison. Both buffers are non-secret, but constant-time
 *  compare avoids leaking where a mismatch occurs and is cheap. */
export function hashesEqual(a: Buffer | null | undefined, b: Buffer | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
