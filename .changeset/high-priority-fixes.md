---
"@eventfabric/core": patch
"@eventfabric/postgres": patch
"@eventfabric/sagas": patch
"@eventfabric/sagas-postgres": patch
"@eventfabric/mediator": patch
"@eventfabric/mediator-postgres": patch
---

Fix data-loss and false-alarm bugs found in review.

- **Outbox:** `ack`, `release`, `releaseWithError` and `deadLetter` take an optional `workerId` and only act while that worker still holds the lease. The async runner passes it, so a handler that outlived `leaseMs` can no longer commit twice (a late ack throws `LeaseLostError` and rolls back) or free another worker's lock. In batch mode a failure is charged only to the row that failed, so one poison row no longer sends its whole batch to the dead-letter queue.
- **Saga timers:** new optional `SagaTimerStore.lockClaimed`. The scheduler re-checks each claimed timer at delivery and skips one that was cancelled or re-scheduled after the claim (round result `skipped`). `PgSagaTimerStore.markFired` only changes a claimed row, so a timer that re-schedules its own id keeps running.
- **Session:** a snapshot written by `saveChangesAsync` now holds the state at the saved version. Before, a direct `append` snapshotted only the events of that save.
- **Hash chain:** a process that has not registered a tamper-evident aggregate now extends its chained streams instead of breaking them (or refuses, without `hashChain.secret`). Payloads containing a `Date` no longer fail verification.
- **Idempotency:** reusing an idempotency key for a different command type, or for the same type with a different payload, throws `IdempotencyKeyConflictError` instead of returning the other command's result. `@eventfabric/mediator-postgres` adds migration `018_command_request_hash` (a `request_hash` column), applied by `migrate(pool, { extensions: [commandsMigrations] })`.
