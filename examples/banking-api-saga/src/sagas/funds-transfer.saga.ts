import type { Saga, SagaReaction, TimerMessage } from "@eventfabric/sagas";
import type { BankingEvent } from "../domain/events";
import type { FundsTransferCommand } from "./funds-transfer.commands";

/**
 * Funds-transfer saga — a process manager for the
 *   TransactionStarted → WithdrawalCompleted → DepositCompleted → TransactionCompleted
 * chain. Replaces the three coordinated catch-up projections in
 * `../projections/eventual-transfer-projections.ts` with one self-
 * contained state machine.
 *
 * What this gains over the projection approach:
 *
 *  - **Withdrawal timeout.** Scheduled in `react`; if WithdrawalCompleted
 *    doesn't arrive in 30s, the timer fires and the saga emits
 *    FailTransaction. With three independent projections there's no
 *    natural place to express "if step N hasn't completed by time T,
 *    compensate" — you'd need a fourth projection polling timestamps.
 *
 *  - **Per-instance state.** `step` is materialised once and read in
 *    O(1). The projection chain re-derived equivalent state from event
 *    history each tick.
 *
 *  - **Single source of truth for the workflow.** One file, one
 *    reducer, one diff to read when the rules change. Three projections
 *    had to agree by convention — easy to break, hard to test in
 *    isolation.
 *
 * What stays the same: the events emitted and consumed are unchanged,
 * so other consumers (read-model projectors, audit, email) keep working.
 *
 * The saga is a pure reducer. It returns commands and timer schedules
 * as data; the saga runner inserts them transactionally with the state
 * advance, and the SagaCommandDispatcher / SagaTimerScheduler workers
 * dispatch them. No IO inside this file.
 */

export type TransferStep = "started" | "withdrawn";

export interface TransferState {
  transferId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  step: TransferStep;
}

const WITHDRAW_TIMEOUT_ID = "withdraw-timeout";
const WITHDRAW_TIMEOUT_MS = 30_000;

/**
 * Build a Command envelope for a FundsTransfer-emitted command.
 * causationId/correlationId are sourced from the saga reaction context
 * so events emitted by handlers tie back to the originating transfer.
 */
const buildCommand = <T extends FundsTransferCommand>(
  type: T["type"],
  payload: T["payload"],
  ctx: { metadata: { correlationId: string; instanceId: string } }
): T =>
  ({
    type,
    version: 1,
    payload,
    metadata: {
      commandId: `${type}-${ctx.metadata.instanceId}-${Math.random()
        .toString(36)
        .slice(2)}`,
      // Author-supplied key. The dispatcher rewrites this to
      // `saga:FundsTransfer:<instance>:<rowId>` before bus.send, so the
      // value here is informational only and never collides.
      idempotencyKey: `${type}:${ctx.metadata.instanceId}`,
      issuedAt: new Date().toISOString(),
      correlationId: ctx.metadata.correlationId,
      causationId: ctx.metadata.instanceId,
    },
  }) as T;

export const fundsTransferSaga: Saga<TransferState, BankingEvent> = {
  name: "FundsTransfer",
  version: 1,

  correlate(env) {
    const e = env.payload;
    if (
      e.type === "TransactionStarted" ||
      e.type === "WithdrawalCompleted" ||
      e.type === "DepositCompleted" ||
      e.type === "TransactionFailed"
    ) {
      return e.transactionId;
    }
    return null;
  },

  startsNewInstance(env) {
    return env.payload.type === "TransactionStarted";
  },

  initialState(env) {
    if (env.payload.type !== "TransactionStarted") {
      throw new Error(
        `FundsTransfer.initialState called with unexpected event type ${env.payload.type}`
      );
    }
    const e = env.payload;
    return {
      transferId: e.transactionId,
      fromAccountId: e.fromAccountId,
      toAccountId: e.toAccountId,
      amount: e.amount,
      step: "started",
    };
  },

  reactToEvent(state, env, ctx): SagaReaction<TransferState> {
    const e = env.payload;

    if (e.type === "TransactionStarted") {
      return {
        newState: state,
        commands: [
          buildCommand("WithdrawFromAccount", {
            accountId: state.fromAccountId,
            amount: state.amount,
            transactionId: state.transferId,
          }, ctx),
        ],
        schedule: [
          {
            id: WITHDRAW_TIMEOUT_ID,
            fireAt: { afterMs: WITHDRAW_TIMEOUT_MS },
            message: {
              type: "$timer",
              id: WITHDRAW_TIMEOUT_ID,
              payload: {},
            },
          },
        ],
      };
    }

    if (e.type === "WithdrawalCompleted") {
      // The withdraw step landed in time — cancel the timeout and move
      // on to the deposit.
      return {
        newState: { ...state, step: "withdrawn" },
        commands: [
          buildCommand("DepositToAccount", {
            accountId: state.toAccountId,
            amount: state.amount,
            transactionId: state.transferId,
          }, ctx),
        ],
        cancel: [WITHDRAW_TIMEOUT_ID],
      };
    }

    if (e.type === "DepositCompleted") {
      return {
        newState: state,
        commands: [
          buildCommand("CompleteTransaction", {
            transactionId: state.transferId,
          }, ctx),
        ],
        end: true,
      };
    }

    if (e.type === "TransactionFailed") {
      // Insufficient-funds (or any other fail path inside a handler)
      // already terminated the transaction. The saga shuts down so it
      // doesn't keep waiting for events that won't arrive. Cancelling
      // the timer is harmless if it already fired.
      return {
        newState: state,
        cancel: [WITHDRAW_TIMEOUT_ID],
        end: true,
      };
    }

    return { newState: state };
  },

  reactToTimer(state, timer: TimerMessage, ctx): SagaReaction<TransferState> {
    if (timer.id === WITHDRAW_TIMEOUT_ID) {
      return {
        newState: state,
        commands: [
          buildCommand("FailTransaction", {
            transactionId: state.transferId,
            reason: "Withdrawal timeout — no WithdrawalCompleted within 30s",
          }, ctx),
        ],
        end: true,
      };
    }
    return { newState: state };
  },
};
