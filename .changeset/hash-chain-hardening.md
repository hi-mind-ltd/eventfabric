---
"@eventfabric/core": patch
"@eventfabric/postgres": patch
---

Harden tamper-evidence against a stripped chain and a bad secret.

- **Strict verification:** `verifyStream` / `verifyAggregate` now fail a stream that has events without an `event_hash`. Before, a stream whose hashes (and `head_hash`) had all been set to NULL verified as ok with `eventsChecked: 0`, and its next append started a fresh chain. The result reports `unprotectedEvents`. For streams that predate tamper-evidence, pass `allowUnprotectedPrefix: true`. A stream whose events were all removed while `stream_versions` still records a version also fails.
- **Secret validation:** `toSecret` (used by `PgEventStore` and `PgChainAnchorSealer`) throws on a missing or empty secret. Before, `hashChain: { secret: undefined, enabledAggregates }` silently disabled chaining and an empty string was accepted.
