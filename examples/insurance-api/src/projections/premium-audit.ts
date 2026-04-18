import { forEventType } from "@eventfabric/core";
import type { PgTx } from "@eventfabric/postgres";
import type { InsuranceEvent } from "../domain/events";

/**
 * Single-event-type audit projection built with the `forEventType` helper.
 *
 * The helper wraps a plain handler in a CatchUpProjection that filters by
 * event type before dispatching. Inside the handler, TypeScript narrows
 * `env.payload` to exactly `PremiumPaidV1` — field-level type safety without
 * any cast or type guard. Non-matching events advance the checkpoint silently.
 *
 * In production the handler would write to an audit table / SIEM. Here it
 * just logs — the point is to demonstrate the helper shape.
 */
export const premiumAuditProjection = forEventType<InsuranceEvent, "PremiumPaid", PgTx>(
  "premium-audit",
  "PremiumPaid",
  async (_tx, env) => {
    const { policyId, paymentId, amount, installmentNumber, totalPaid } = env.payload;
    console.log(
      `[premium-audit] tenant=${env.tenantId} policy=${policyId} payment=${paymentId} ` +
        `amount=${amount} installment=${installmentNumber} total=${totalPaid}`
    );
  }
);
