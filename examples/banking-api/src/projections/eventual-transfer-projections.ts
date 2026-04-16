import type { CatchUpProjection, EventEnvelope } from "@eventfabric/core";
import type { BankingEvent } from "../domain/events";
import type { AccountEvent } from "../domain/account.events";
import { WithdrawalCompleted, DepositCompleted } from "../domain/account.events";
import type { TransactionEvent } from "../domain/transaction.events";
import { TransactionFailed, TransactionCompleted } from "../domain/transaction.events";
import type { PgTx } from "@eventfabric/postgres";
import { PgEventStore } from "@eventfabric/postgres";
import { AccountAggregate } from "../domain/account.aggregate";
import { TransactionAggregate } from "../domain/transaction.aggregate";

/**
 * The transfer chain is a *process manager*: it reacts to events, does
 * work, and emits follow-up events that the next step reacts to. These
 * projections are implemented as catch-up projections — each tracks its
 * own checkpoint in eventfabric.projection_checkpoints and reads straight from
 * the events table. No outbox, no topic filter.
 *
 * Why catch-up and not outbox for this chain?
 *  - The handoffs (TransactionStarted → WithdrawalCompleted → DepositCompleted →
 *    TransactionCompleted) are purely internal state transitions, not
 *    external side effects. Catch-up is cheaper (no outbox row per event)
 *    and removes the topic-routing footgun.
 *  - External delivery (email notifications) stays on the outbox path
 *    via emailNotificationProjection — that's what the outbox pattern
 *    actually exists for.
 *
 * Each handler dispatches on event.type and returns early for events
 * it doesn't care about. The checkpoint still advances — other events
 * in the same batch just pass through untouched.
 */

/**
 * Handles TransactionStarted → performs withdrawal → emits WithdrawalCompleted.
 */
export function createWithdrawalProjection(
  eventStore: PgEventStore<BankingEvent>
): CatchUpProjection<BankingEvent, PgTx> {
  return {
    name: "withdrawal-handler",
    async handle(tx: PgTx, env: EventEnvelope<BankingEvent>) {
      const event = env.payload;
      if (event.type !== "TransactionStarted") return;

      // Load source account
      const accountHistory = await eventStore.loadStream(tx, event.fromAccountId, AccountAggregate);
      const account = new AccountAggregate(event.fromAccountId);
      account.loadFromHistory(
        accountHistory.map((h) => ({ payload: h.payload as AccountEvent, aggregateVersion: h.aggregateVersion }))
      );

      // Not enough funds → mark the transaction failed and stop
      if (account.balance < event.amount) {
        const txHistory = await eventStore.loadStream(tx, event.transactionId, TransactionAggregate);
        const transaction = new TransactionAggregate(event.transactionId);
        transaction.loadFromHistory(
          txHistory.map((h) => ({ payload: h.payload as TransactionEvent, aggregateVersion: h.aggregateVersion }))
        );

        transaction.fail(`Insufficient funds in account ${event.fromAccountId}`);
        await eventStore.append(tx, {
          aggregateName: "Transaction",
          aggregateId: transaction.id,
          expectedAggregateVersion: transaction.version,
          events: transaction.pullPendingEvents()
        });
        return;
      }

      // Perform withdrawal
      account.withdraw(event.amount, event.transactionId);
      const newBalance = account.balance;

      const withdrawalEvents = account.pullPendingEvents();
      if (withdrawalEvents.length > 0) {
        const result = await eventStore.append(tx, {
          aggregateName: "Account",
          aggregateId: account.id,
          expectedAggregateVersion: account.version,
          events: withdrawalEvents
        });
        account.version = result.nextAggregateVersion;
      }

      // Emit WithdrawalCompleted — the deposit projection's handler will
      // pick this up on its next catch-up tick (no outbox, no topic).
      await eventStore.append(tx, {
        aggregateName: "Account",
        aggregateId: account.id,
        expectedAggregateVersion: account.version,
        events: [WithdrawalCompleted({
          accountId: event.fromAccountId,
          transactionId: event.transactionId,
          amount: event.amount,
          balance: newBalance,
          completedAt: new Date().toISOString()
        })]
      });
    }
  };
}

/**
 * Handles WithdrawalCompleted → performs deposit → emits DepositCompleted.
 */
export function createDepositProjection(
  eventStore: PgEventStore<BankingEvent>
): CatchUpProjection<BankingEvent, PgTx> {
  return {
    name: "deposit-handler",
    async handle(tx: PgTx, env: EventEnvelope<BankingEvent>) {
      const event = env.payload;
      if (event.type !== "WithdrawalCompleted") return;

      const txHistory = await eventStore.loadStream(tx, event.transactionId, TransactionAggregate);
      const transaction = new TransactionAggregate(event.transactionId);
      transaction.loadFromHistory(
        txHistory.map((h) => ({ payload: h.payload as TransactionEvent, aggregateVersion: h.aggregateVersion }))
      );

      if (!transaction.state.toAccountId) {
        throw new Error(`Transaction ${event.transactionId} missing toAccountId`);
      }

      const accountHistory = await eventStore.loadStream(tx, transaction.state.toAccountId, AccountAggregate);
      const account = new AccountAggregate(transaction.state.toAccountId);
      account.loadFromHistory(
        accountHistory.map((h) => ({ payload: h.payload as AccountEvent, aggregateVersion: h.aggregateVersion }))
      );

      account.deposit(event.amount, event.transactionId);
      const newBalance = account.balance;

      const depositEvents = account.pullPendingEvents();
      if (depositEvents.length > 0) {
        const result = await eventStore.append(tx, {
          aggregateName: "Account",
          aggregateId: account.id,
          expectedAggregateVersion: account.version,
          events: depositEvents
        });
        account.version = result.nextAggregateVersion;
      }

      await eventStore.append(tx, {
        aggregateName: "Account",
        aggregateId: account.id,
        expectedAggregateVersion: account.version,
        events: [DepositCompleted({
          accountId: transaction.state.toAccountId!,
          transactionId: event.transactionId,
          amount: event.amount,
          balance: newBalance,
          completedAt: new Date().toISOString()
        })]
      });
    }
  };
}

/**
 * Handles DepositCompleted → marks the transaction completed.
 */
export function createTransactionCompletionProjection(
  eventStore: PgEventStore<BankingEvent>
): CatchUpProjection<BankingEvent, PgTx> {
  return {
    name: "transaction-completion-handler",
    async handle(tx: PgTx, env: EventEnvelope<BankingEvent>) {
      const event = env.payload;
      if (event.type !== "DepositCompleted") return;

      const txHistory = await eventStore.loadStream(tx, event.transactionId, TransactionAggregate);
      const transaction = new TransactionAggregate(event.transactionId);
      transaction.loadFromHistory(
        txHistory.map((h) => ({ payload: h.payload as TransactionEvent, aggregateVersion: h.aggregateVersion }))
      );

      transaction.complete();

      const events = transaction.pullPendingEvents();
      if (events.length > 0) {
        await eventStore.append(tx, {
          aggregateName: "Transaction",
          aggregateId: transaction.id,
          expectedAggregateVersion: transaction.version,
          events
        });
      }
    }
  };
}
