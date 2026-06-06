import { forEventType } from "@eventfabric/core";
import type { BankingEvent } from "../domain/events";
import type { PgTx } from "@eventfabric/postgres";

/**
 * Single-event-type projection built with the `forEventType` helper.
 *
 * The helper wraps a plain handler in a CatchUpProjection that filters by
 * event type before dispatching. Inside the handler body, TypeScript
 * narrows `env.payload` to exactly `AccountDepositedV1` — you get field-
 * level type safety for the one variant you care about, no casts, no
 * `if (env.payload.type !== ...)` guard.
 *
 * Checkpoints still advance past non-matching events, so this projection
 * coexists cleanly with others that care about different event types.
 */
export const depositAuditProjection = forEventType<BankingEvent, "AccountDeposited", PgTx>(
  "deposit-audit",
  "AccountDeposited",
  async (_tx, env) => {
    const { accountId, amount, balance, transactionId } = env.payload;
    console.log(
      `[deposit-audit] account=${accountId} +${amount} (balance=${balance})` +
        (transactionId ? ` tx=${transactionId}` : "")
    );
  }
);
