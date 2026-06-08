---
"@eventfabric/core": minor
"@eventfabric/postgres": minor
---

Add opt-in, tamper-evident event chaining — primitives + contract in `@eventfabric/core`, Postgres implementation in `@eventfabric/postgres` (migration `015_event_hash_chain`).

**`@eventfabric/core`**
- Backend-agnostic hash-chain primitives: `canonicalJson`, `computeEventHash`, `streamGenesis` / `anchorGenesis`, `computeAnchorHash`, `hashesEqual`, `toSecret`, and the `ChainableEvent` / `AnchorMember` types. These define the canonical chain *format* so it isn't reinvented per backend.
- `TamperEvidentEventStore<E, TTx>` — an optional capability interface (separate from base `EventStore`) declaring `verifyStream` / `verifyAggregate`, plus the `ChainVerificationResult` type. Lets app code and future backends depend on the verification contract rather than a concrete adapter.
- `AggregateRoot.tamperEvident` static (default `false`) — first-classes the per-aggregate toggle as an intrinsic property of the aggregate, read by the storage adapter at registration.

**`@eventfabric/postgres`**
- `PgEventStore implements TamperEvidentEventStore`. Turn chaining on per aggregate type via `static tamperEvident = true` on the aggregate class (or `registerAggregate(..., { tamperEvident: true })`), plus `new PgEventStore({ hashChain: { secret } })`. Each protected event stores `event_hash = HMAC(secret, prevHash ‖ canonical(event))`; `stream_versions.head_hash` caches the head so the write path reads no extra rows. Unprotected aggregates keep the original SQL path (NULL hashes) — stores that never opt in don't even need migration 015.
- `verifyStream` / `verifyAggregate` detect payload/metadata mutation, event removal, and tail truncation; a soft `dismiss()` does not break the chain.
- **Per-tenant anchor (`PgChainAnchorSealer`).** An async `seal(tx)` snapshots the tenant's chained stream heads from a consistent MVCC cut into an HMAC-chained anchor (tables `event_chain_anchors` + `event_chain_anchor_members`); `verifyAnchors(tx)` re-derives the chain and confirms every sealed head is still live — catching whole-stream deletion and clean stream rollbacks that per-stream verification alone cannot. `PgChainAnchorRunner` schedules sealing across all tenants on an interval (`start(signal)` idiom).
- Integrity is HMAC-SHA256 keyed by an app-held secret, never stored in the database.
