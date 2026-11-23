---
"@eventfabric/core": patch
---

`AggregateRoot.raise()` applies the event after a JSON round trip, the shape it is stored and replayed in. Live state now matches the state after a reload (a `Date` in an event becomes its ISO string; `undefined` fields are dropped), and a `bigint` in an event throws at `raise()` with a clear message. Handlers that relied on receiving a `Date` object from a live event must read an ISO string instead (they already had to on reload).
