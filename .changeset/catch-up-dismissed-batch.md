---
"@eventfabric/core": patch
---

fix(catch-up): do not stall on a batch made entirely of dismissed events

The projector asked the store to drop dismissed events. `PgEventStore.loadGlobal` does that after applying `LIMIT`, so a batch of `batchSize` consecutive dismissed events came back empty. The projector treated that as "caught up" and never moved past them. It now always loads dismissed events and skips them itself, so the checkpoint advances past them.
