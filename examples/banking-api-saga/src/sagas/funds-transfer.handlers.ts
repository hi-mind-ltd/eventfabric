import type { CommandHandler } from "@eventfabric/mediator";
import type { PgEventStore, PgTx } from "@eventfabric/postgres";
import type { BankingEvent } from "../domain/events";
import type { AccountEvent } from "../domain/account.events";
import type { TransactionEvent } from "../domain/transaction.events";
import { WithdrawalCompleted, DepositCompleted } from "../domain/account.events";
import { AccountAggregate } from "../domain/account.aggregate";
import { TransactionAggregate } from "../domain/transaction.aggregate";
import type {
  WithdrawFromAccount,
  DepositToAccount,
  CompleteTransaction,
  FailTransaction,
} from "./funds-transfer.commands";

/**
 * Command handlers for the FundsTransfer saga. Each handler is a port
 * of the corresponding block from
 * `../projections/eventual-transfer-projections.ts` — same domain
 * logic, same emitted events. The difference is the trigger:
 *
 *  - In the projection version, the catch-up projector calls the
 *    handler when its checkpoint reaches the matching event.
 *  - Here, the saga emits a Command, the SagaCommandDispatcher claims
 *    the row, and the CommandBus routes it to one of these handlers.
 *
 * The handlers run inside the bus's transaction (`ctx.tx`). Their
 * effects commit atomically with the idempotency claim, so a worker
 * crash mid-handler simply rolls everything back and the dispatcher
 * re-claims the row on the next round.
 */

export function createWithdrawFromAccountHandler(
  store: PgEventStore<BankingEvent>
): CommandHandler<WithdrawFromAccount, void, PgTx> {
  return {
    commandType: "WithdrawFromAccount",
    async handle(cmd, ctx) {
      const { accountId, amount, transactionId } = cmd.payload;

      const accountHistory = await store.loadStream(ctx.tx, accountId, AccountAggregate);
      const account = new AccountAggregate(accountId);
      account.loadFromHistory(
        accountHistory.map((h) => ({
          payload: h.payload as AccountEvent,
          aggregateVersion: h.aggregateVersion,
        }))
      );

      // Insufficient funds → fail the transaction in the same tx and
      // stop. The saga will see TransactionFailed and end its instance.
      if (account.balance < amount) {
        const txHistory = await store.loadStream(
          ctx.tx,
          transactionId,
          TransactionAggregate
        );
        const transaction = new TransactionAggregate(transactionId);
        transaction.loadFromHistory(
          txHistory.map((h) => ({
            payload: h.payload as TransactionEvent,
            aggregateVersion: h.aggregateVersion,
          }))
        );

        transaction.fail(`Insufficient funds in account ${accountId}`);
        await store.append(ctx.tx, {
          aggregateName: "Transaction",
          aggregateId: transaction.id,
          expectedAggregateVersion: transaction.version,
          events: transaction.pullPendingEvents(),
        });
        return;
      }

      account.withdraw(amount, transactionId);
      const newBalance = account.balance;

      const withdrawalEvents = account.pullPendingEvents();
      if (withdrawalEvents.length > 0) {
        const result = await store.append(ctx.tx, {
          aggregateName: "Account",
          aggregateId: account.id,
          expectedAggregateVersion: account.version,
          events: withdrawalEvents,
        });
        account.version = result.nextAggregateVersion;
      }

      await store.append(ctx.tx, {
        aggregateName: "Account",
        aggregateId: account.id,
        expectedAggregateVersion: account.version,
        events: [
          WithdrawalCompleted({
            accountId,
            transactionId,
            amount,
            balance: newBalance,
            completedAt: new Date().toISOString(),
          }),
        ],
      });
    },
  };
}

export function createDepositToAccountHandler(
  store: PgEventStore<BankingEvent>
): CommandHandler<DepositToAccount, void, PgTx> {
  return {
    commandType: "DepositToAccount",
    async handle(cmd, ctx) {
      const { accountId, amount, transactionId } = cmd.payload;

      const accountHistory = await store.loadStream(ctx.tx, accountId, AccountAggregate);
      const account = new AccountAggregate(accountId);
      account.loadFromHistory(
        accountHistory.map((h) => ({
          payload: h.payload as AccountEvent,
          aggregateVersion: h.aggregateVersion,
        }))
      );

      account.deposit(amount, transactionId);
      const newBalance = account.balance;

      const depositEvents = account.pullPendingEvents();
      if (depositEvents.length > 0) {
        const result = await store.append(ctx.tx, {
          aggregateName: "Account",
          aggregateId: account.id,
          expectedAggregateVersion: account.version,
          events: depositEvents,
        });
        account.version = result.nextAggregateVersion;
      }

      await store.append(ctx.tx, {
        aggregateName: "Account",
        aggregateId: account.id,
        expectedAggregateVersion: account.version,
        events: [
          DepositCompleted({
            accountId,
            transactionId,
            amount,
            balance: newBalance,
            completedAt: new Date().toISOString(),
          }),
        ],
      });
    },
  };
}

export function createCompleteTransactionHandler(
  store: PgEventStore<BankingEvent>
): CommandHandler<CompleteTransaction, void, PgTx> {
  return {
    commandType: "CompleteTransaction",
    async handle(cmd, ctx) {
      const { transactionId } = cmd.payload;

      const txHistory = await store.loadStream(
        ctx.tx,
        transactionId,
        TransactionAggregate
      );
      const transaction = new TransactionAggregate(transactionId);
      transaction.loadFromHistory(
        txHistory.map((h) => ({
          payload: h.payload as TransactionEvent,
          aggregateVersion: h.aggregateVersion,
        }))
      );

      transaction.complete();

      const events = transaction.pullPendingEvents();
      if (events.length > 0) {
        await store.append(ctx.tx, {
          aggregateName: "Transaction",
          aggregateId: transaction.id,
          expectedAggregateVersion: transaction.version,
          events,
        });
      }
    },
  };
}

export function createFailTransactionHandler(
  store: PgEventStore<BankingEvent>
): CommandHandler<FailTransaction, void, PgTx> {
  return {
    commandType: "FailTransaction",
    async handle(cmd, ctx) {
      const { transactionId, reason } = cmd.payload;

      const txHistory = await store.loadStream(
        ctx.tx,
        transactionId,
        TransactionAggregate
      );
      const transaction = new TransactionAggregate(transactionId);
      transaction.loadFromHistory(
        txHistory.map((h) => ({
          payload: h.payload as TransactionEvent,
          aggregateVersion: h.aggregateVersion,
        }))
      );

      transaction.fail(reason);

      const events = transaction.pullPendingEvents();
      if (events.length > 0) {
        await store.append(ctx.tx, {
          aggregateName: "Transaction",
          aggregateId: transaction.id,
          expectedAggregateVersion: transaction.version,
          events,
        });
      }
    },
  };
}

/**
 * Convenience: register all four handlers on a CommandBus in one call.
 */
export function registerFundsTransferHandlers(
  bus: {
    register(handler: CommandHandler<any, any, PgTx>): void;
  },
  store: PgEventStore<BankingEvent>
): void {
  bus.register(createWithdrawFromAccountHandler(store));
  bus.register(createDepositToAccountHandler(store));
  bus.register(createCompleteTransactionHandler(store));
  bus.register(createFailTransactionHandler(store));
}
