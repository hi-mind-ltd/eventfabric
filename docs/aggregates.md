# Aggregates

An aggregate is the transactional consistency boundary of your domain. In
EventFabric every aggregate extends the `AggregateRoot<S, E>` base class from
`@eventfabric/core`.

## AggregateRoot&lt;S, E&gt;

```typescript
import { AggregateRoot, type HandlerMap } from "@eventfabric/core";
```

### Type parameters

| Parameter | Meaning                                       |
| --------- | --------------------------------------------- |
| `S`       | The in-memory state type of the aggregate     |
| `E`       | The discriminated union of all event types     |

`E` must satisfy `AnyEvent` (`{ type: string; version: number }`).

### Instance properties

| Property  | Type   | Description                                                      |
| --------- | ------ | ---------------------------------------------------------------- |
| `id`      | `string` | The aggregate identity, set once via the constructor.           |
| `version` | `number` | The stream version. Starts at `0`; incremented by the store after each append. |
| `state`   | `S`      | The mutable in-memory state, updated by event handlers.        |

### Abstract members

Every concrete aggregate must provide:

```typescript
protected abstract handlers: HandlerMap<E, S>;
```

### Static members

Every aggregate class must declare a static `aggregateName`:

```typescript
static readonly aggregateName = "Account" as const;
```

This string is stored in the `aggregate_name` column of `eventfabric.events`
and is used by the session to look up the correct class at load time.

## HandlerMap&lt;E, S&gt;

```typescript
export type HandlerMap<E extends AnyEvent, S> = {
  [K in E["type"]]?: (state: S, event: Extract<E, { type: K }>) => void;
};
```

The handler map is an object whose keys are event type strings and whose values
are functions that apply one event to the mutable state. Handlers are called by
`loadFromHistory()` during replay and by `raise()` when a new event is created.

Handlers **must be pure and synchronous**. They must not throw, perform I/O, or
have side effects. They run both during replay (where there is no transaction)
and during command execution.

Using `satisfies HandlerMap<E, S>` on the handler object gives you autocomplete
on event type keys and narrows the `event` parameter to the correct variant:

```typescript
protected handlers = {
  AccountOpened: (s, e) => {
    // e is narrowed to AccountOpenedV2
    s.customerId = e.customerId;
    s.balance = e.initialBalance;
    s.currency = e.currency;
    s.region = e.region;
    s.isClosed = false;
  },
  AccountDeposited: (s, e) => {
    // e is narrowed to AccountDepositedV1
    s.balance = e.balance;
  },
} satisfies HandlerMap<AccountEvent, AccountState>;
```

## raise()

```typescript
protected raise(...events: E[]): void
```

Call `raise()` from command methods to record that something happened. The
method:

1. Validates the event structure in non-production environments (`type` must be
   a string, `version` must be a positive integer).
2. Calls the matching handler to apply the event to `this.state`.
3. Pushes the event onto the internal pending list.

If no handler exists for the event type, `raise()` throws immediately.

```typescript
deposit(amount: number) {
  if (this.state.isClosed) throw new Error("Cannot deposit to closed account");
  if (amount <= 0) throw new Error("Deposit amount must be positive");
  const newBalance = this.state.balance + amount;
  this.raise({
    type: "AccountDeposited",
    version: 1,
    accountId: this.id,
    amount,
    balance: newBalance,
  });
}
```

After `raise()` returns, `this.state` already reflects the new event. This
means subsequent business-rule checks within the same command see the updated
state.

## loadFromHistory()

```typescript
public loadFromHistory(history: { payload: E; aggregateVersion: number }[]): void
```

Called by the framework (the `Session` or `Repository`) to replay historical
events. It iterates the history array, calls each handler, and sets
`this.version` to the last `aggregateVersion` seen.

You do not call this method yourself unless you are writing tests or building a
custom repository.

## pullPendingEvents()

```typescript
public pullPendingEvents(): E[]
```

Returns and clears the list of events that have been `raise()`-d since the last
call. The session calls this during `saveChangesAsync()` to collect events for
the store.

After `pullPendingEvents()` the aggregate's `state` still reflects the raised
events, but the pending list is empty. Calling `pullPendingEvents()` a second
time returns `[]`.

## Full example -- AccountAggregate

Below is the complete `AccountAggregate` from the banking-api example.

```typescript
// domain/account.events.ts
export type AccountOpenedV2 = {
  type: "AccountOpened";
  version: 2;
  accountId: string;
  customerId: string;
  initialBalance: number;
  currency: string;
  region: string;
};

export type AccountDepositedV1 = {
  type: "AccountDeposited";
  version: 1;
  accountId: string;
  amount: number;
  balance: number;
  transactionId?: string;
};

export type AccountWithdrawnV1 = {
  type: "AccountWithdrawn";
  version: 1;
  accountId: string;
  amount: number;
  balance: number;
  transactionId?: string;
};

export type AccountClosedV1 = {
  type: "AccountClosed";
  version: 1;
  accountId: string;
  reason: string;
};

// ... other event types omitted for brevity

export type AccountEvent =
  | AccountOpenedV2
  | AccountDepositedV1
  | AccountWithdrawnV1
  // | ... other variants
  | AccountClosedV1;
```

```typescript
// domain/account.aggregate.ts
import { AggregateRoot, type HandlerMap } from "@eventfabric/core";
import type { AccountEvent } from "./account.events";

export type AccountState = {
  customerId?: string;
  balance: number;
  currency: string;
  region?: string;
  isClosed: boolean;
  closedReason?: string;
};

export class AccountAggregate extends AggregateRoot<AccountState, AccountEvent> {
  static readonly aggregateName = "Account" as const;

  protected handlers = {
    AccountOpened: (s, e) => {
      s.customerId = e.customerId;
      s.balance = e.initialBalance;
      s.currency = e.currency;
      s.region = e.region;
      s.isClosed = false;
    },
    AccountDeposited: (s, e) => {
      s.balance = e.balance;
    },
    AccountWithdrawn: (s, e) => {
      s.balance = e.balance;
    },
    AccountClosed: (s, e) => {
      s.isClosed = true;
      s.closedReason = e.reason;
    },
  } satisfies HandlerMap<AccountEvent, AccountState>;

  constructor(id: string, snapshot?: AccountState) {
    super(id, snapshot ?? { balance: 0, currency: "USD", isClosed: false });
  }

  open(customerId: string, initialBalance: number, currency = "USD", region = "unknown") {
    if (this.state.customerId) throw new Error("Account already opened");
    this.raise({
      type: "AccountOpened",
      version: 2,
      accountId: this.id,
      customerId,
      initialBalance,
      currency,
      region,
    });
  }

  deposit(amount: number, transactionId?: string) {
    if (this.state.isClosed) throw new Error("Cannot deposit to closed account");
    if (amount <= 0) throw new Error("Deposit amount must be positive");
    this.raise({
      type: "AccountDeposited",
      version: 1,
      accountId: this.id,
      amount,
      balance: this.state.balance + amount,
      transactionId,
    });
  }

  withdraw(amount: number, transactionId?: string) {
    if (this.state.isClosed) throw new Error("Cannot withdraw from closed account");
    if (amount <= 0) throw new Error("Withdrawal amount must be positive");
    if (this.state.balance < amount) throw new Error("Insufficient funds");
    this.raise({
      type: "AccountWithdrawn",
      version: 1,
      accountId: this.id,
      amount,
      balance: this.state.balance - amount,
      transactionId,
    });
  }

  close(reason: string) {
    if (this.state.isClosed) throw new Error("Account already closed");
    if (this.state.balance !== 0) throw new Error("Cannot close account with non-zero balance");
    this.raise({
      type: "AccountClosed",
      version: 1,
      accountId: this.id,
      reason,
    });
  }

  get balance(): number {
    return this.state.balance;
  }
}
```

## Testing pattern

Aggregates are plain in-memory objects. You do not need a database to test them.
The pattern is:

1. Create an instance.
2. Optionally replay history with `loadFromHistory()`.
3. Call command methods.
4. Assert on `state` and/or `pullPendingEvents()`.

```typescript
import { describe, it, expect } from "vitest";
import { AccountAggregate } from "./account.aggregate";

describe("AccountAggregate", () => {
  it("opens an account and sets initial balance", () => {
    const account = new AccountAggregate("acc-1");
    account.open("cust-1", 500, "USD");

    expect(account.state.customerId).toBe("cust-1");
    expect(account.state.balance).toBe(500);

    const events = account.pullPendingEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "AccountOpened",
      version: 2,
      initialBalance: 500,
    });
  });

  it("rejects withdrawal when funds are insufficient", () => {
    const account = new AccountAggregate("acc-1");
    // Replay history to put the aggregate into a known state.
    account.loadFromHistory([
      {
        payload: {
          type: "AccountOpened",
          version: 2,
          accountId: "acc-1",
          customerId: "cust-1",
          initialBalance: 100,
          currency: "USD",
          region: "unknown",
        },
        aggregateVersion: 1,
      },
    ]);

    expect(() => account.withdraw(200)).toThrow("Insufficient funds");
    expect(account.pullPendingEvents()).toHaveLength(0);
  });

  it("allows sequential deposits", () => {
    const account = new AccountAggregate("acc-1");
    account.open("cust-1", 0, "USD");
    account.deposit(100);
    account.deposit(50);

    expect(account.state.balance).toBe(150);
    expect(account.pullPendingEvents()).toHaveLength(3); // open + 2 deposits
  });
});
```

Because the aggregate validates events at `raise()` time, your test
automatically checks that every raised event has a valid `type` and `version`
(this validation runs in non-production environments).

## Related documentation

- [Events](./events.md) -- Event types, envelopes, versioning
- [Event Store](./event-store.md) -- How events are persisted and loaded
- [Sessions](./sessions.md) -- Unit of work that loads and saves aggregates
- [Snapshots](./snapshots.md) -- Skipping replay for long-lived aggregates
- [Core Concepts](./core-concepts.md) -- Aggregates as consistency boundaries
