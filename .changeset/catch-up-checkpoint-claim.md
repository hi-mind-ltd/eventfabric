---
"@eventfabric/core": minor
"@eventfabric/postgres": minor
---

feat(catch-up): safe to run the same projection on several instances at once

`ProjectionCheckpointStore` has a new optional method, `claim(tx, projection, tenant)`. It locks the checkpoint for the rest of the transaction and returns `null` without waiting when another transaction holds it. The catch-up projector claims the checkpoint before reading each batch. Any number of instances (processes, nodes) can now run the same projection: each batch is processed by exactly one of them, and a busy (projection, tenant) pair is skipped until the next round. `PgProjectionCheckpointStore` implements it with `SELECT … FOR UPDATE SKIP LOCKED`. Custom checkpoint stores without `claim` keep the previous behaviour, where concurrent instances may process the same events twice.
