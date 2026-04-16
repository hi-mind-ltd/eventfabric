---
"@eventfabric/postgres": minor
---

Refactor `registerAggregate` from positional args to options bag and add required `outboxTopic` parameter. Session now sets per-aggregate outbox topics on every event, fixing silent routing failures where topic-filtered async projections would never match events saved through Session.

### Breaking change

`registerAggregate` signature changed from positional snapshot args to `(AggregateClass, eventTypes, outboxTopic, opts?)`.

### Migration guide

**Before:**

```typescript
factory.registerAggregate(AccountAggregate, [
  "AccountOpened", "AccountDeposited"
], snapshotStore);

factory.registerAggregate(AccountAggregate, [
  "AccountOpened", "AccountDeposited"
], snapshotStore, { everyNEvents: 50 }, 1);
```

**After:**

```typescript
factory.registerAggregate(AccountAggregate, [
  "AccountOpened", "AccountDeposited"
], "account", { snapshotStore });

factory.registerAggregate(AccountAggregate, [
  "AccountOpened", "AccountDeposited"
], "account", {
  snapshotStore,
  snapshotPolicy: { everyNEvents: 50 },
  snapshotSchemaVersion: 1
});
```

The `outboxTopic` string (3rd argument) is required. It sets the topic on every outbox row so that async projections with `topicFilter: { mode: "include", topics: ["account"] }` correctly match events from this aggregate.
