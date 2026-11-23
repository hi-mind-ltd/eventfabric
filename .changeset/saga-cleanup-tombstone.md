---
"@eventfabric/sagas-postgres": patch
---

`PgSagaStateStore.cleanupTerminal()` takes `mode: "delete" | "tombstone"` (default `"delete"`). Tombstone mode clears a finished instance's state but keeps its row, so replaying its starting event (a projection reset or rebuild) doesn't restart the saga. `reactivate()` refuses tombstones.
