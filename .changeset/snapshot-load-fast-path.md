---
"@eventfabric/core": patch
"@eventfabric/postgres": patch
"@eventfabric/opentelemetry": patch
---

**Fix:** `loadAggregateAsync` now uses the registered snapshot store instead of always replaying the full event stream. When a snapshot store is registered for the aggregate type, the session loads the latest snapshot, hydrates the aggregate from it, and replays only events after the snapshot's version. Falls back to full replay when no snapshot store is registered or no snapshot has been written yet.