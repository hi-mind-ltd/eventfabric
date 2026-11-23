---
"@eventfabric/core": patch
"@eventfabric/postgres": patch
"@eventfabric/mediator": patch
---

Fix lower-priority bugs found in review.

- **Snapshots (core, postgres):** a save that writes several events and jumps past a multiple of `everyNEvents` now snapshots (it used to snapshot only when the new version was an exact multiple). New `shouldSnapshot(policy, fromVersion, toVersion)` helper.
- **Dead-letter reason (postgres):** the reason passed to `deadLetter()` is now stored (migration `019_outbox_dead_letter_reason` adds `outbox_dead_letters.reason`) and returned as `DlqItem.reason`. Run `migrate()` when upgrading.
- **Partitioning (postgres):** `enablePartitioning()` places the first boundary above both `MAX(global_position)` and the sequence's current value, so appends don't fail with "no partition" when the sequence is ahead (rolled-back appends, deleted events).
- **`loadByGlobalPositions` (postgres):** positions are sent as one array parameter, so very large batches don't exceed Postgres's 65,535-parameter limit.
- **Anchor sealer (postgres):** members are inserted with array parameters, so a seal covering more than ~10,900 advanced streams no longer fails every time.
- **In-memory idempotency store (mediator):** slots claimed or completed in a transaction that rolls back (including a failed commit) are removed, so a retry runs the handler instead of returning an uncommitted result. New optional `IdempotencyStore.afterCommit` / `afterRollback`, called by the bus.
