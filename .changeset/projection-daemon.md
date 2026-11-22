---
"@eventfabric/core": minor
"@eventfabric/postgres": minor
---

feat: ProjectionDaemon, a Marten-style async daemon for projections

`ProjectionDaemon` (core) and `createProjectionDaemon(pool, eventStore, projections, opts)` (postgres) run projections continuously against the event log:

- **Checkpoints per (projection, tenant).** A projection added later back-fills from the start of the log, and `rebuild(name)` replays one from scratch. It calls the new optional `CatchUpProjection.reset(tx)` per tenant to clear the read model, resets the checkpoint (new optional `ProjectionCheckpointStore.reset`) and drops that projection's dead letters.
- **High water mark.** Reads never pass an event whose transaction is still in flight, so late commits are not skipped.
- **Several instances.** Each batch claims its checkpoint, so any number of instances can run the same projections and each event is handled once. Instances running different projections each see every event.
- **Failures.** A failing event is retried with backoff. Events before it in the batch are committed first, so one bad event only holds back what comes after it. After `maxAttempts` (default 10) the event goes to the new `eventfabric.projection_dead_letters` table (migration `016_projection_dead_letters`) and the checkpoint moves past it. `replayDeadLetter(id)` and `listDeadLetters()` manage dead letters. The observer gains `onEventDeadLettered`.

New exports: `ProjectionDaemon`, `ProjectionDaemonOptions`, `ProjectionDeadLetterStore`, `ProjectionDeadLetter` (core); `createProjectionDaemon`, `PgProjectionDeadLetterStore` (postgres).

Use the daemon for projections. Keep the outbox `AsyncProjectionRunner` for external delivery: each outbox row goes to whichever runner claims it, so runners with different handlers must split the outbox with `claimTopic`.
