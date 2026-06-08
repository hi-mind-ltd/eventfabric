# Tamper Evidence

EventFabric can make an event log **tamper-evident**: a cryptographic hash chain
over events lets you *detect* after the fact if stored events were altered,
removed, reordered, or if whole streams were deleted or rolled back. It is
**opt-in per aggregate type** — chaining adds work on the write path, so you turn
it on only for the aggregates that need it (audit logs, API-key events, ledger
entries, …).

The contract and the chain *format* live in `@eventfabric/core`
(`TamperEvidentEventStore`, plus the hashing primitives); the Postgres
implementation lives in `@eventfabric/postgres`.

> **Evident, not preventive.** This detects tampering; it does not prevent a
> privileged actor from modifying the database. The guarantee is that they
> cannot do so *undetectably* without the HMAC secret.

## Threat model

Integrity is an **HMAC-SHA256** chain keyed by a secret your application holds
(env / KMS) and that is **never stored in the database**. An attacker who can
write the database still cannot forge a valid chain without that secret — which
is why a keyed HMAC is used rather than a plain SHA-256 chain (a plain chain can
be recomputed by anyone who can write the rows).

There are two layers:

| Layer | Catches | Does **not** catch on its own |
| --- | --- | --- |
| **Per-stream chain** (always, when enabled) | payload/metadata mutation, event insertion/removal, reordering, tail truncation within a stream | deletion of an *entire* stream; a clean rollback to a valid earlier state |
| **Per-tenant anchor** (optional, async) | whole-stream deletion, clean stream rollback/truncation, cross-stream tampering | — |

Run **both** for full coverage. The anchor exists precisely because a privileged
attacker can truncate a stream to a *valid* earlier prefix (delete the tail, lower
`current_version`, point `head_hash` at a real earlier event) — that passes
per-stream verification but fails anchor verification.

## Enabling it

Three things:

**1. Declare the aggregate as tamper-evident** (intrinsic property of the aggregate):

```typescript
class AuditLog extends AggregateRoot<AuditState, AuditEvent> {
  static aggregateName = "audit";
  static tamperEvident = true;        // ← every "audit" stream is hash-chained
  // ...
}
```

**2. Give the store the HMAC secret** and run migration 015 (`migrate(pool)` applies it):

```typescript
import { PgEventStore } from "@eventfabric/postgres";

const store = new PgEventStore<MyEvent>({
  hashChain: { secret: process.env.EF_CHAIN_SECRET! },
});
```

**3. Register the aggregate** — registration reads `static tamperEvident` and turns
chaining on for that aggregate in the store:

```typescript
const factory = new SessionFactory(pool, store);
factory.registerAggregate(AuditLog, ["AuditRecorded", /* … */], "audit");
// equivalent explicit override (rarely needed — e.g. on in one deployment, off in another):
factory.registerAggregate(AuditLog, [...], "audit", { tamperEvident: true });
```

That's it. Protected events now carry an `event_hash`; everything else is
unchanged. **Aggregates you don't enable are byte-for-byte on the original write
path** (NULL `event_hash`), and a store with no `hashChain.secret` doesn't even
need migration 015.

### The HMAC secret

- Keep it in env/KMS, **never in the database or source**. Losing it means you can
  no longer verify existing chains (but events remain readable). Leaking it lets an
  attacker forge chains.
- The same secret must be used by the write path, `verifyStream`, the anchor
  sealer, and `verifyAnchors`.
- Rotation isn't automatic: a rotated secret won't verify chains written under the
  old one. If you need rotation, verify-then-re-seal under the new key during a
  maintenance window (or scope a key per tenant — see the per-tenant signing-key
  pattern in the runbook).

## Verifying a stream

`PgEventStore` implements `TamperEvidentEventStore`:

```typescript
const result = await uow.withTransaction((tx) =>
  store.verifyStream(tx, { aggregateName: "audit", aggregateId: "audit-42" })
);
// { ok, tenantId, aggregateName, aggregateId, eventsChecked, firstBrokenAt, reason? }

if (!result.ok) {
  console.error(`audit-42 broken at v${result.firstBrokenAt}: ${result.reason}`);
}
```

`verifyStream` walks the stream in version order, recomputes each `event_hash`
from the **raw stored payload** (it deliberately bypasses any upcaster — the hash
is over the bytes as stored), checks each link, and checks the final hash equals
`stream_versions.head_hash`. `firstBrokenAt` is the `aggregate_version` where it
diverged; `reason` describes the failure (`"event_hash mismatch"`,
`"version gap"`, `"head_hash mismatch"`, …).

Verify every stream of an aggregate for the current tenant:

```typescript
const results = await uow.withTransaction((tx) =>
  store.verifyAggregate(tx, { aggregateName: "audit" })
);
const broken = results.filter((r) => !r.ok);
```

## The per-tenant anchor

The anchor adds cross-stream coverage. `PgChainAnchorSealer.seal()` reads a
**consistent MVCC snapshot** of the tenant's chained stream heads from
`stream_versions` and folds them into a running HMAC anchor chain — no
`global_position`/gap reasoning, so it never false-alarms and never stalls. Each
anchor stores only the *delta* (streams whose head advanced since the last
anchor).

```typescript
import { PgChainAnchorSealer, PgChainAnchorRunner } from "@eventfabric/postgres";

const sealer = new PgChainAnchorSealer({ secret: process.env.EF_CHAIN_SECRET! });

// One-shot seal for a tenant (inside a transaction):
await uow.withTransaction((tx) => sealer.seal(tx));   // tenant from tx; idempotent (no-op if nothing changed)

// Verify the anchor chain + that every sealed head is still live:
const v = await uow.withTransaction((tx) => sealer.verifyAnchors(tx));
// { ok, anchorsChecked, streamsChecked, failure?: { kind, anchorSeq?, aggregateName?, aggregateId?, detail } }
```

Schedule it with `PgChainAnchorRunner`, which discovers every tenant that has
chained streams and seals each on an interval (same `start(signal)` idiom as the
projection runners):

```typescript
const runner = new PgChainAnchorRunner(pool, sealer, {
  intervalMs: 60_000,
  onError: (err, tenantId) => log.error({ err, tenantId }, "anchor seal failed"),
});

const controller = new AbortController();
runner.start(controller.signal);   // fire-and-forget; controller.abort() to stop
```

Run a single instance per pool (the anchor PK backstops accidental concurrent
sealers). For **per-database** multi-tenancy, run one runner per pool. Cadence is
a policy choice: more frequent = tighter detection window for whole-stream
deletion; less frequent = less background work.

## Operational notes

- **Soft `dismiss()` is safe.** Dismissing an event sets `dismissed_*` columns,
  which are **not** part of the hash preimage — the chain stays valid and the
  event remains in the chain. (A hard delete, by contrast, *is* detected.)
- **Enabling mid-stream.** If you turn chaining on for an aggregate that already
  has events, those pre-existing events keep `NULL` `event_hash`; the chain starts
  at the next appended event (genesis). `verifyStream` verifies from the first
  protected event onward. Events before that point are out of scope.
- **Payloads must be JSON round-trip stable.** The hash preimage is a canonical
  JSON serialization (sorted keys). No `NaN`/`Infinity`, no `bigint`, and integers
  within `Number.MAX_SAFE_INTEGER` (store larger values as strings). Violations
  throw at write time rather than silently producing an unverifiable chain.
- **Coverage.** The hash covers identity, in-stream order (`aggregate_version` +
  the prev-hash link), and payload. It deliberately excludes DB-assigned values
  (`global_position`, `occurred_at`) so it's computable in one pass before insert.
- **Performance.** A protected append does one extra `SELECT … FOR UPDATE` on the
  `stream_versions` row it already gates on, plus a 32-byte HMAC. Unprotected
  aggregates are unaffected. The anchor runs off the write path.
- **Partitioning.** Fully compatible — `event_hash` travels with the partitioned
  `events` table.

## Core primitives (custom verifiers)

The chain format is defined by pure, backend-agnostic functions in
`@eventfabric/core`, so you can re-verify a chain outside the database (an audit
job, a different service) without reimplementing the format:

```typescript
import { canonicalJson, computeEventHash, streamGenesis, hashesEqual } from "@eventfabric/core";
```

`canonicalJson`, `computeEventHash`, `streamGenesis` / `anchorGenesis`,
`computeAnchorHash`, `hashesEqual`, `toSecret`, and the `ChainableEvent` /
`AnchorMember` types are all exported.

## Schema

See [Schema Reference](./schema-reference.md) for the columns and tables added by
migration 015: `events.event_hash`, `stream_versions.head_hash`, and the
`event_chain_anchors` + `event_chain_anchor_members` tables.
