---
"@eventfabric/core": minor
"@eventfabric/postgres": minor
---

fix(catch-up): never skip events that commit after a higher position (high water mark)

Global positions are allocated at INSERT, not at COMMIT. The catch-up projector read `global_position > checkpoint` with no upper bound, so an event still in flight below a committed higher position was skipped for good once the checkpoint moved past it.

Reads are now bounded by a **high water mark**: the highest position at or below which every event is final.

- `@eventfabric/core`: new `HighWaterMark` interface. `CatchUpProjector` takes an optional fourth constructor argument. When it is set, tenant discovery and every batch read stop at the mark. New `CatchUpOptions.highWaterMarkWaitMs` (default 2000) is how long a call waits for in-flight transactions to settle. `EventStore.loadGlobal` and `discoverActiveTenants` accept an optional `toGlobalPositionInclusive`. Custom event stores must honour it to get the guarantee.
- `@eventfabric/postgres`: new `PgHighWaterMark`, based on transaction snapshots (`pg_current_snapshot`, so PostgreSQL 13+). A sampled position becomes safe once every transaction that was in flight at the time of the sample has finished. Gaps from rolled-back transactions are passed over naturally. `createCatchUpProjector` always wires one in. It accepts `{ highWaterMark: { skipLiveTransactionsAfterMs } }` as an escape hatch for long-running write transactions, which otherwise hold the mark back, the same as Marten's default. The deprecated `PgCatchUpProjector` takes an optional `pool` argument to enable it.
