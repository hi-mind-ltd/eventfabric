---
"@eventfabric/core": patch
"@eventfabric/postgres": patch
---

Harden tamper-evidence against a stripped chain and a bad secret.

- **Strict verification:** `verifyStream` / `verifyAggregate` now fail a stream that has events without an `event_hash`. Before, a stream whose hashes (and `head_hash`) had all been set to NULL verified as ok with `eventsChecked: 0`, and its next append started a fresh chain. The result reports `unprotectedEvents`. For streams that predate tamper-evidence, pass `allowUnprotectedPrefix: true`. A stream whose events were all removed while `stream_versions` still records a version also fails.
- **No dismissals in chained streams:** `PgEventStore.dismiss()` throws for an event in a hash-chained stream, and `verifyStream` fails a chained event marked dismissed. The `dismissed_*` columns are outside the hash and a dismissed event is hidden from replay, so a database writer could hide any event undetected.
- **Hash format v2 covers `occurred_at`:** `computeEventHash` includes the timestamp when `ChainableEvent.occurredAt` is set. `PgEventStore` writes new chained events in v2, taking `occurred_at` from the application clock (millisecond precision). Events in v1 keep verifying and are counted in `legacyFormatEvents`. Upgrade verifying processes before or together with appending ones: an older release reports v2 events as a mismatch.
- **Secret validation:** `toSecret` (used by `PgEventStore` and `PgChainAnchorSealer`) throws on a missing or empty secret. Before, `hashChain: { secret: undefined, enabledAggregates }` silently disabled chaining and an empty string was accepted.
