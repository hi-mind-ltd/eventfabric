---
"@eventfabric/core": patch
"@eventfabric/postgres": patch
"@eventfabric/sagas": patch
"@eventfabric/opentelemetry": patch
"@eventfabric/mediator-opentelemetry": patch
"@eventfabric/sagas-opentelemetry": patch
---

Fix robustness bugs found in review.

- **Query builder (postgres):** the fluent builder no longer puts column names, operators, sort direction, JSONB keys, `limit` or `offset` into the SQL text unchecked. JSONB keys, `limit` and `offset` are parameters; column names must be plain identifiers; operators and sort direction must come from a fixed set. Invalid input throws.
- **Migrations (postgres):** concurrent `migrate()` calls (several app instances starting at once) are serialized with an advisory lock, and `enablePartitioning()` re-checks under the table lock, so a second caller backs off instead of breaking the new partitioned table. New `PgPartitionManager.enablePartitioningOn(client)`.
- **Saga loops (sagas):** the timer scheduler and command dispatcher keep running after a round throws (e.g. the database is down). They report via the new `onLoopError` observer hook, back off (`errorBackoff` option), and `stop()` interrupts the sleep. `sagas-opentelemetry` counts `eventfabric.saga.loop_error_total`.
- **Failed saves (core, postgres):** `Repository.save()` and `saveChangesAsync()` change the in-memory aggregate only after the commit. A failed save keeps the pending events and old version, so a retry writes them instead of silently returning `null`. New `AggregateRoot.peekPendingEvents()` and `markCommitted()`.
- **Backoff (core):** the first retry waits `minMs`, not `minMs * factor`.
- **OpenTelemetry:** per-event, per-command and per-instance ids (`global_position`, positions, `command_id`, `idempotency_key`, `principal_id`, `correlation_id`, `saga_instance`, `timer_id`) are no longer metric attributes; they stay on spans. Dashboards that grouped metrics by these labels need updating.
