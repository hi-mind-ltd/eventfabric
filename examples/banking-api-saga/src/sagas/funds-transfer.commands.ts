import type { Command } from "@eventfabric/mediator";

/**
 * Commands emitted by the FundsTransfer saga. Each maps 1:1 to a
 * step the saga needs the system to execute. The saga itself never
 * touches aggregates — it only returns these as data, and the
 * SagaCommandDispatcher hands them to the CommandBus.
 *
 * Using the same `Command` envelope shape as the rest of the system
 * means handlers can opt into idempotency, get correlation/causation
 * stamping, and surface in the same observability tooling as any
 * other command.
 */

export interface WithdrawFromAccount
  extends Command<{ accountId: string; amount: number; transactionId: string }> {
  type: "WithdrawFromAccount";
}

export interface DepositToAccount
  extends Command<{ accountId: string; amount: number; transactionId: string }> {
  type: "DepositToAccount";
}

export interface CompleteTransaction extends Command<{ transactionId: string }> {
  type: "CompleteTransaction";
}

export interface FailTransaction
  extends Command<{ transactionId: string; reason: string }> {
  type: "FailTransaction";
}

export type FundsTransferCommand =
  | WithdrawFromAccount
  | DepositToAccount
  | CompleteTransaction
  | FailTransaction;
