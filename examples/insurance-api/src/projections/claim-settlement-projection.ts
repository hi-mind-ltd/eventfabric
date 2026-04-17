import type { CatchUpProjection, EventEnvelope } from "@eventfabric/core";
import type { PgTx, PgEventStore } from "@eventfabric/postgres";
import type { InsuranceEvent } from "../domain/events";
import type { ClaimEvent } from "../domain/claim.events";
import { ClaimPaid } from "../domain/claim.events";
import { ClaimAggregate } from "../domain/claim.aggregate";

/**
 * Process manager for claim settlement.
 *
 * When an adjuster approves a claim (ClaimApproved), the payout must be
 * scheduled against the insurer's disbursement system. This projection picks
 * up each ClaimApproved event, generates a synthetic payment reference, and
 * emits ClaimPaid against the same claim stream so the aggregate advances to
 * the `paid` terminal state.
 *
 * Catch-up (not outbox): the handoff is an internal state transition in the
 * same database, not an external side effect. Each tenant's projection
 * checkpoint is scoped by tenant_id, so approvals in tenant "acme" never
 * bleed into tenant "contoso".
 */
export function createClaimSettlementProjection(
  eventStore: PgEventStore<InsuranceEvent>
): CatchUpProjection<InsuranceEvent, PgTx> {
  return {
    name: "claim-settlement",
    async handle(tx: PgTx, env: EventEnvelope<InsuranceEvent>) {
      const event = env.payload;
      if (event.type !== "ClaimApproved") return;

      // The projector scopes `tx.tenantId` to the envelope's tenant id
      // automatically, so loadStream / append below filter on the right
      // tenant without any manual narrowing in user code.
      const claimHistory = await eventStore.loadStream(tx, event.claimId, ClaimAggregate);
      const claim = new ClaimAggregate(event.claimId);
      claim.loadFromHistory(
        claimHistory.map((h) => ({ payload: h.payload as ClaimEvent, aggregateVersion: h.aggregateVersion }))
      );

      // Idempotency: the projector can replay. If we've already emitted
      // ClaimPaid (terminal state), skip.
      if (claim.status !== "approved") return;

      const paymentReference = `PAY-${env.tenantId}-${event.claimId.slice(0, 8)}-${Date.now()}`;
      claim.markPaid(paymentReference);

      const pending = claim.pullPendingEvents();
      if (pending.length === 0) return;

      await eventStore.append(tx, {
        aggregateName: "Claim",
        aggregateId: claim.id,
        expectedAggregateVersion: claim.version,
        events: pending,
        enqueueOutbox: true,
        outboxTopic: "claim"
      });
    }
  };
}

/**
 * Alternate single-event projection written by hand (without the
 * `forEventType` helper) — kept to show the full shape, including the
 * explicit emit of ClaimPaid events. Not wired by default.
 */
export function createManualSettlementProjection(
  eventStore: PgEventStore<InsuranceEvent>
): CatchUpProjection<InsuranceEvent, PgTx> {
  return {
    name: "claim-settlement-manual",
    async handle(tx: PgTx, env: EventEnvelope<InsuranceEvent>) {
      const event = env.payload;
      if (event.type !== "ClaimApproved") return;

      // Append ClaimPaid directly (skipping the aggregate — only valid when
      // no invariants need checking). Shown for contrast with the preferred
      // approach above.
      await eventStore.append(tx, {
        aggregateName: "Claim",
        aggregateId: event.claimId,
        expectedAggregateVersion: -1, // unsafe: bypasses version check
        events: [
          ClaimPaid({
            claimId: event.claimId,
            amount: event.approvedAmount,
            paymentReference: `MANUAL-${event.claimId}`,
            paidAt: new Date().toISOString()
          })
        ]
      });
    }
  };
}
