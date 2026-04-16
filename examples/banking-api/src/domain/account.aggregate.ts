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
      // The handler only sees AccountOpenedV2 — historical V1 events are
      // upcast by accountEventUpcaster before reaching this point.
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
    WithdrawalCompleted: (s, e) => {
      s.balance = e.balance;
    },
    DepositCompleted: (s, e) => {
      s.balance = e.balance;
    },
    AccountTransferredOut: (s, e) => {
      s.balance = e.balance;
    },
    AccountTransferredIn: (s, e) => {
      s.balance = e.balance;
    },
    AccountClosed: (s, e) => {
      s.isClosed = true;
      s.closedReason = e.reason;
    }
  } satisfies HandlerMap<AccountEvent, AccountState>;

  constructor(id: string, snapshot?: AccountState) {
    super(id, snapshot ?? { balance: 0, currency: "USD", isClosed: false });
  }

  open(customerId: string, initialBalance: number, currency: string = "USD", region: string = "unknown") {
    if (this.state.isClosed) {
      throw new Error("Cannot open a closed account");
    }
    if (this.state.customerId) {
      throw new Error("Account already opened");
    }
    this.raise({
      type: "AccountOpened",
      version: 2,
      accountId: this.id,
      customerId,
      initialBalance,
      currency,
      region
    });
  }

  deposit(amount: number, transactionId?: string) {
    if (this.state.isClosed) {
      throw new Error("Cannot deposit to closed account");
    }
    if (amount <= 0) {
      throw new Error("Deposit amount must be positive");
    }
    const newBalance = this.state.balance + amount;
    this.raise({
      type: "AccountDeposited",
      version: 1,
      accountId: this.id,
      amount,
      balance: newBalance,
      transactionId
    });
  }

  withdraw(amount: number, transactionId?: string) {
    if (this.state.isClosed) {
      throw new Error("Cannot withdraw from closed account");
    }
    if (amount <= 0) {
      throw new Error("Withdrawal amount must be positive");
    }
    if (this.state.balance < amount) {
      throw new Error("Insufficient funds");
    }
    const newBalance = this.state.balance - amount;
    this.raise({
      type: "AccountWithdrawn",
      version: 1,
      accountId: this.id,
      amount,
      balance: newBalance,
      transactionId
    });
  }

  transferOut(toAccountId: string, amount: number, transactionId: string) {
    if (this.state.isClosed) {
      throw new Error("Cannot transfer from closed account");
    }
    if (amount <= 0) {
      throw new Error("Transfer amount must be positive");
    }
    if (this.state.balance < amount) {
      throw new Error("Insufficient funds for transfer");
    }
    const newBalance = this.state.balance - amount;
    this.raise({
      type: "AccountTransferredOut",
      version: 1,
      accountId: this.id,
      toAccountId,
      amount,
      balance: newBalance,
      transactionId
    });
  }

  transferIn(fromAccountId: string, amount: number, transactionId: string) {
    if (this.state.isClosed) {
      throw new Error("Cannot transfer to closed account");
    }
    if (amount <= 0) {
      throw new Error("Transfer amount must be positive");
    }
    const newBalance = this.state.balance + amount;
    this.raise({
      type: "AccountTransferredIn",
      version: 1,
      accountId: this.id,
      fromAccountId,
      amount,
      balance: newBalance,
      transactionId
    });
  }

  close(reason: string) {
    if (this.state.isClosed) {
      throw new Error("Account already closed");
    }
    if (this.state.balance !== 0) {
      throw new Error("Cannot close account with non-zero balance");
    }
    this.raise({
      type: "AccountClosed",
      version: 1,
      accountId: this.id,
      reason
    });
  }

  get balance(): number {
    return this.state.balance;
  }

  get customerId(): string | undefined {
    return this.state.customerId;
  }

  get isClosed(): boolean {
    return this.state.isClosed;
  }
}
