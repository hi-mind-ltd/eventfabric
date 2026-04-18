import type { AsyncProjection, EventEnvelope } from "@eventfabric/core";
import type { InsuranceEvent } from "../domain/events";
import type { PgTx } from "@eventfabric/postgres";

/**
 * Stub notification gateway — in production this would talk to SendGrid /
 * Twilio / a push provider. The in-memory log is what the integration tests
 * assert against.
 */
class NotificationGateway {
  private sent: Array<{
    tenantId: string;
    channel: "email" | "sms";
    to: string;
    subject: string;
    body: string;
  }> = [];

  async send(msg: { tenantId: string; channel: "email" | "sms"; to: string; subject: string; body: string }): Promise<void> {
    console.log(`[notification] tenant=${msg.tenantId} ${msg.channel}→${msg.to}: ${msg.subject}`);
    this.sent.push(msg);
  }

  getSent() {
    return this.sent;
  }

  clear() {
    this.sent = [];
  }
}

export const notificationGateway = new NotificationGateway();

/**
 * Async projection for external notifications. Outbox pattern — each message
 * is a row in `eventfabric.outbox`, claimed by the runner, retried on
 * failure, and dead-lettered after maxAttempts. Topic-filtered so we only
 * claim events from the streams we care about.
 *
 * The `tenantId` attached to each outbox row flows through `env.tenantId` so
 * every notification is correctly attributed to the tenant that raised the
 * source event. That is what makes the outbox tenant-safe.
 */
export const insuranceNotificationProjection: AsyncProjection<InsuranceEvent, PgTx> = {
  name: "insurance-notifications",
  topicFilter: {
    mode: "include",
    topics: ["policy", "claim", "policyholder"]
  },
  async handle(_tx: PgTx, env: EventEnvelope<InsuranceEvent>) {
    const event = env.payload;
    const tenantId = env.tenantId;

    if (event.type === "PolicyIssued") {
      await notificationGateway.send({
        tenantId,
        channel: "email",
        to: `policyholder-${event.policyholderId}@example.com`,
        subject: `Policy ${event.policyId} issued`,
        body: `Your ${event.productCode} policy is active from ${event.effectiveDate} to ${event.expiryDate}. Coverage: ${event.coverageAmount} ${event.currency}.`
      });
      return;
    }

    if (event.type === "PolicyCancelled") {
      await notificationGateway.send({
        tenantId,
        channel: "email",
        to: `policy-${event.policyId}@example.com`,
        subject: `Policy ${event.policyId} cancelled`,
        body: `Reason: ${event.reason}. Refund: ${event.refundAmount}.`
      });
      return;
    }

    if (event.type === "PolicyExpired") {
      await notificationGateway.send({
        tenantId,
        channel: "email",
        to: `policy-${event.policyId}@example.com`,
        subject: `Policy ${event.policyId} expired`,
        body: `Your policy expired on ${event.expiredAt}. Renew to keep coverage active.`
      });
      return;
    }

    if (event.type === "PremiumPaid") {
      await notificationGateway.send({
        tenantId,
        channel: "sms",
        to: `policy-${event.policyId}`,
        subject: "Premium received",
        body: `We received your payment of ${event.amount} (installment #${event.installmentNumber}).`
      });
      return;
    }

    if (event.type === "ClaimSubmitted") {
      await notificationGateway.send({
        tenantId,
        channel: "email",
        to: `policyholder-${event.policyholderId}@example.com`,
        subject: `Claim ${event.claimId} received`,
        body: `We received your claim for ${event.requestedAmount}. An adjuster will be in touch.`
      });
      return;
    }

    if (event.type === "ClaimApproved") {
      await notificationGateway.send({
        tenantId,
        channel: "email",
        to: `claim-${event.claimId}@example.com`,
        subject: `Claim ${event.claimId} approved`,
        body: `Approved amount: ${event.approvedAmount}. Payment will follow shortly.`
      });
      return;
    }

    if (event.type === "ClaimDenied") {
      await notificationGateway.send({
        tenantId,
        channel: "email",
        to: `claim-${event.claimId}@example.com`,
        subject: `Claim ${event.claimId} denied`,
        body: `Reason: ${event.reason}.`
      });
      return;
    }

    if (event.type === "ClaimPaid") {
      await notificationGateway.send({
        tenantId,
        channel: "email",
        to: `claim-${event.claimId}@example.com`,
        subject: `Claim ${event.claimId} paid`,
        body: `Amount: ${event.amount}. Reference: ${event.paymentReference}.`
      });
      return;
    }

    if (event.type === "PolicyholderVerified") {
      await notificationGateway.send({
        tenantId,
        channel: "email",
        to: `policyholder-${event.policyholderId}@example.com`,
        subject: "Identity verified",
        body: `KYC reference ${event.kycReference}. You can now purchase policies.`
      });
      return;
    }

    if (event.type === "PolicyholderSuspended") {
      await notificationGateway.send({
        tenantId,
        channel: "email",
        to: `policyholder-${event.policyholderId}@example.com`,
        subject: "Account suspended",
        body: `Reason: ${event.reason}.`
      });
      return;
    }
  }
};
