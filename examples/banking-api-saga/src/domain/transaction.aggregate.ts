import { AggregateRoot, type HandlerMap } from "@eventfabric/core";
import type { TransactionEvent } from "./transaction.events";

export type TransactionState = {
  fromAccountId?: string;
  toAccountId?: string;
  amount: number;
  currency: string;
  status: "pending" | "started" | "withdrawal_completed" | "deposit_completed" | "completed" | "failed";
  description?: string;
  failureReason?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
};

export class TransactionAggregate extends AggregateRoot<TransactionState, TransactionEvent> {
  static readonly aggregateName = "Transaction" as const;
  
  protected handlers = {
    TransactionInitiated: (s, e) => {
      s.fromAccountId = e.fromAccountId;
      s.toAccountId = e.toAccountId;
      s.amount = e.amount;
      s.currency = e.currency;
      s.status = "pending";
      s.description = e.description;
    },
    TransactionStarted: (s, e) => {
      s.status = "started";
      s.startedAt = e.startedAt;
    },
    TransactionCompleted: (s, e) => {
      s.status = "completed";
      s.completedAt = e.completedAt;
    },
    TransactionFailed: (s, e) => {
      s.status = "failed";
      s.failureReason = e.reason;
      s.failedAt = e.failedAt;
    }
  } satisfies HandlerMap<TransactionEvent, TransactionState>;

  constructor(id: string, snapshot?: TransactionState) {
    super(id, snapshot ?? { amount: 0, currency: "USD", status: "pending" });
  }

  initiate(fromAccountId: string, toAccountId: string, amount: number, currency: string = "USD", description?: string) {
    if (this.state.fromAccountId) {
      throw new Error("Transaction already initiated");
    }
    if (amount <= 0) {
      throw new Error("Transaction amount must be positive");
    }
    if (fromAccountId === toAccountId) {
      throw new Error("Cannot transfer to the same account");
    }
    this.raise({
      type: "TransactionInitiated",
      version: 1,
      transactionId: this.id,
      fromAccountId,
      toAccountId,
      amount,
      currency,
      description
    });
  }

  start() {
    if (this.state.status !== "pending") {
      throw new Error(`Cannot start transaction in ${this.state.status} status`);
    }
    this.raise({
      type: "TransactionStarted",
      version: 1,
      transactionId: this.id,
      fromAccountId: this.state.fromAccountId!,
      toAccountId: this.state.toAccountId!,
      amount: this.state.amount,
      currency: this.state.currency,
      description: this.state.description,
      startedAt: new Date().toISOString()
    });
  }

  markWithdrawalCompleted() {
    if (this.state.status !== "started") {
      throw new Error(`Cannot mark withdrawal completed in ${this.state.status} status`);
    }
    this.state.status = "withdrawal_completed";
  }

  markDepositCompleted() {
    if (this.state.status !== "withdrawal_completed") {
      throw new Error(`Cannot mark deposit completed in ${this.state.status} status`);
    }
    this.state.status = "deposit_completed";
  }

  complete() {
    // Allow completion from "started" (for eventual consistency flow) or "pending" (for atomic flow)
    if (this.state.status !== "started" && this.state.status !== "pending" && this.state.status !== "deposit_completed") {
      throw new Error(`Cannot complete transaction in ${this.state.status} status`);
    }
    this.raise({
      type: "TransactionCompleted",
      version: 1,
      transactionId: this.id,
      fromAccountId: this.state.fromAccountId!,
      toAccountId: this.state.toAccountId!,
      amount: this.state.amount,
      completedAt: new Date().toISOString()
    });
  }

  fail(reason: string) {
    if (this.state.status !== "pending" && this.state.status !== "started") {
      throw new Error(`Cannot fail transaction in ${this.state.status} status`);
    }
    this.raise({
      type: "TransactionFailed",
      version: 1,
      transactionId: this.id,
      fromAccountId: this.state.fromAccountId!,
      toAccountId: this.state.toAccountId!,
      amount: this.state.amount,
      reason,
      failedAt: new Date().toISOString()
    });
  }

  get status(): TransactionState["status"] {
    return this.state.status;
  }

  get amount(): number {
    return this.state.amount;
  }
}
