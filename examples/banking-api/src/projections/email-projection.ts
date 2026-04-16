import type { AsyncProjection, EventEnvelope } from "@eventfabric/core";
import type { BankingEvent } from "../domain/events";
import type { PgTx } from "@eventfabric/postgres";

/**
 * Simple email service mock - in production, this would integrate with
 * SendGrid, AWS SES, etc.
 */
class EmailService {
  private sentEmails: Array<{ to: string; subject: string; body: string }> = [];

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    // In production, this would call an actual email service
    console.log(`📧 Email sent to ${to}:`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Body: ${body}`);
    this.sentEmails.push({ to, subject, body });
  }

  getSentEmails() {
    return this.sentEmails;
  }
}

const emailService = new EmailService();

/**
 * Async projection that sends email notifications for banking transactions.
 * This demonstrates:
 * - Topic filtering (only processes transaction-related events)
 * - Idempotent handling (safe to retry)
 * - Async processing via outbox pattern
 */
export const emailNotificationProjection: AsyncProjection<BankingEvent, PgTx> = {
  name: "email-notifications",
  topicFilter: {
    mode: "include",
    topics: ["transaction", "account"]
  },
  async handle(tx: PgTx, env: EventEnvelope<BankingEvent>) {
    const event = env.payload;

    // Handle transaction completion
    if (event.type === "TransactionCompleted") {
      // In a real app, we'd load customer info from a read model or database
      // For this example, we'll use placeholder emails
      const fromEmail = `customer-${event.fromAccountId}@example.com`;
      const toEmail = `customer-${event.toAccountId}@example.com`;

      // Send email to sender
      await emailService.sendEmail(
        fromEmail,
        "Transaction Completed",
        `Your transfer of $${event.amount} to account ${event.toAccountId} has been completed.`
      );

      // Send email to receiver
      await emailService.sendEmail(
        toEmail,
        "Money Received",
        `You have received $${event.amount} from account ${event.fromAccountId}.`
      );
    }

    // Handle transaction failure
    if (event.type === "TransactionFailed") {
      const fromEmail = `customer-${event.fromAccountId}@example.com`;
      await emailService.sendEmail(
        fromEmail,
        "Transaction Failed",
        `Your transfer of $${event.amount} to account ${event.toAccountId} has failed. Reason: ${event.reason}`
      );
    }

    // Handle account deposits
    if (event.type === "AccountDeposited") {
      const email = `customer-${event.accountId}@example.com`;
      await emailService.sendEmail(
        email,
        "Deposit Confirmed",
        `Your account has been credited with $${event.amount}. New balance: $${event.balance}`
      );
    }

    // Handle account withdrawals
    if (event.type === "AccountWithdrawn") {
      const email = `customer-${event.accountId}@example.com`;
      await emailService.sendEmail(
        email,
        "Withdrawal Confirmed",
        `Your account has been debited $${event.amount}. New balance: $${event.balance}`
      );
    }

    // Handle account opened
    if (event.type === "AccountOpened") {
      const email = `customer-${event.customerId}@example.com`;
      await emailService.sendEmail(
        email,
        "Account Opened",
        `Your new account ${env.aggregateId} has been opened with an initial balance of $${event.initialBalance}.`
      );
    }
  }
};

export { emailService };
