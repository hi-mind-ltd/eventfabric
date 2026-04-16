# @eventfabric/postgres

## 0.1.3

### Patch Changes

- 3b5ec98: Refactor `registerAggregate` from positional args to options bag and add required `outboxTopic` parameter. Session now sets per-aggregate outbox topics on every event, fixing silent routing failures where topic-filtered async projections would never match events saved through Session.

  ### Breaking change

  `registerAggregate` signature changed from positional snapshot args to `(AggregateClass, eventTypes, outboxTopic, opts?)`.

  ### Migration guide

  **Before:**

  ```typescript
  factory.registerAggregate(
    AccountAggregate,
    ["AccountOpened", "AccountDeposited"],
    snapshotStore
  );

  factory.registerAggregate(
    AccountAggregate,
    ["AccountOpened", "AccountDeposited"],
    snapshotStore,
    { everyNEvents: 50 },
    1
  );
  ```

  **After:**

  ```typescript
  factory.registerAggregate(
    AccountAggregate,
    ["AccountOpened", "AccountDeposited"],
    "account",
    { snapshotStore }
  );

  factory.registerAggregate(
    AccountAggregate,
    ["AccountOpened", "AccountDeposited"],
    "account",
    {
      snapshotStore,
      snapshotPolicy: { everyNEvents: 50 },
      snapshotSchemaVersion: 1,
    }
  );
  ```

  The `outboxTopic` string (3rd argument) is required. It sets the topic on every outbox row so that async projections with `topicFilter: { mode: "include", topics: ["account"] }` correctly match events from this aggregate.

## 0.1.2

### Patch Changes

- f54bce9: Add partitioning, migrator, and performance optimizations
- Updated dependencies [f54bce9]
  - @eventfabric/core@0.1.2

## 0.1.1

### Patch Changes

- 4438c66: Initial release setup with npm Trusted Publishing
- Updated dependencies [4438c66]
  - @eventfabric/core@0.1.1
