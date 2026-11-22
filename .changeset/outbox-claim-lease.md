---
"@eventfabric/core": minor
"@eventfabric/postgres": minor
---

fix(outbox): stop claimed outbox rows from staying locked forever

- `AsyncRunnerOptions.leaseMs` (default 5 minutes): a claimed row whose lock is older than the lease is treated as abandoned and can be claimed again, so rows held by a worker that crashed after claiming are recovered.
- `perRow` mode releases the claimed rows it never reached, whether the loop ended because of a handler failure or because the runner was stopped. These rows do not count towards `maxAttempts`.
- `batch` mode dead-letters rows whose event cannot be loaded, as `perRow` mode already did, instead of leaving them locked.

**Breaking for custom `OutboxStore` implementations:** the interface has a new required method, `release(tx, ids)`, which unlocks rows and undoes the `attempts` increment from the claim. `claimBatch` also accepts an optional `leaseMs`. `PgOutboxStore` implements both.
