---
"@eventfabric/core": minor
"@eventfabric/sagas": minor
---

feat(sagas): run sagas on the projection daemon; dead-letter replays are no longer skipped

- New `sagaAsProjection(saga, stores)` wraps a saga for the `ProjectionDaemon`. Events reach each saga in `global_position` order, never past the high water mark, so the `lastEventPos` duplicate check is correct. Several daemon instances can run side by side. A concurrent state advance throws `ConcurrencyError` and is retried. Events that keep failing are dead-lettered. This is the equivalent of feeding a Wolverine saga from a Marten event subscription.
- `CatchUpProjection.handle` receives an optional third argument, `ProjectionHandleContext` (`{ replay: boolean }`). `ProjectionDaemon.replayDeadLetter` passes `replay: true`.
- `applySagaTransition` accepts `{ replay: true }` to bypass the `globalPosition <= lastEventPos` check. Without it, replaying a dead-lettered saga event was a silent no-op. `lastEventPos` never moves backwards now.
- `sagaAsAsyncProjection` (outbox runner) is documented as unsafe for sagas whose events can be produced concurrently. The outbox does not deliver in position order, so an event that commits after a later one for the same instance is skipped as "already applied".
