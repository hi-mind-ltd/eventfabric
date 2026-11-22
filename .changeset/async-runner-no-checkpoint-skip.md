---
"@eventfabric/core": minor
"@eventfabric/postgres": minor
---

fix(async-runner): stop skipping outbox rows that sit at or below a projection checkpoint

The async runner used to skip any event at or below the projection's checkpoint and then ack (delete) its outbox row. Global positions are allocated when an event is inserted, not when its transaction commits, so the skip silently dropped:

- events whose transaction committed after a higher position was processed,
- rows requeued from the DLQ, and
- rows handled out of order by concurrent runner replicas.

The outbox row is now the only record of delivery, and it is deleted in the same transaction as the handlers that processed it. The runner no longer reads or writes `projection_checkpoints`. The `checkpoints` constructor argument of `AsyncProjectionRunner` is deprecated and ignored, and `createAsyncProjectionRunner` no longer passes one. Handlers must be idempotent: delivery is at least once.
