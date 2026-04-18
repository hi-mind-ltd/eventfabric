import { AggregateRoot, type HandlerMap } from "@eventfabric/core";
import type { PolicyEvent } from "./policy.events";

export type PolicyStatus = "active" | "cancelled" | "expired";

export type PolicyState = {
  policyholderId?: string;
  productCode?: string;
  coverageAmount: number;
  premiumAmount: number;
  totalPaid: number;
  currency: string;
  effectiveDate?: string;
  expiryDate?: string;
  status: PolicyStatus;
  installmentCount: number;
  cancellationReason?: string;
  refundAmount?: number;
};

export class PolicyAggregate extends AggregateRoot<PolicyState, PolicyEvent> {
  static readonly aggregateName = "Policy" as const;

  protected handlers = {
    PolicyIssued: (s, e) => {
      // The handler only sees V2 — historical V1 events are upcast by
      // policyEventUpcaster before reaching this point.
      s.policyholderId = e.policyholderId;
      s.productCode = e.productCode;
      s.coverageAmount = e.coverageAmount;
      s.premiumAmount = e.premiumAmount;
      s.currency = e.currency;
      s.effectiveDate = e.effectiveDate;
      s.expiryDate = e.expiryDate;
      s.status = "active";
      s.totalPaid = 0;
      s.installmentCount = 0;
    },
    PremiumPaid: (s, e) => {
      s.totalPaid = e.totalPaid;
      s.installmentCount = e.installmentNumber;
    },
    PolicyRenewed: (s, e) => {
      s.expiryDate = e.newExpiryDate;
      s.premiumAmount = e.newPremiumAmount;
    },
    PolicyCancelled: (s, e) => {
      s.status = "cancelled";
      s.cancellationReason = e.reason;
      s.refundAmount = e.refundAmount;
    },
    PolicyExpired: (s) => {
      s.status = "expired";
    }
  } satisfies HandlerMap<PolicyEvent, PolicyState>;

  constructor(id: string, snapshot?: PolicyState) {
    super(id, snapshot ?? {
      coverageAmount: 0,
      premiumAmount: 0,
      totalPaid: 0,
      currency: "GBP",
      status: "active",
      installmentCount: 0
    });
  }

  issue(params: {
    policyholderId: string;
    productCode: string;
    coverageAmount: number;
    premiumAmount: number;
    currency?: string;
    effectiveDate: string;
    expiryDate: string;
  }) {
    if (this.state.policyholderId) {
      throw new Error("Policy already issued");
    }
    if (params.coverageAmount <= 0) {
      throw new Error("Coverage amount must be positive");
    }
    if (params.premiumAmount <= 0) {
      throw new Error("Premium amount must be positive");
    }
    if (new Date(params.expiryDate) <= new Date(params.effectiveDate)) {
      throw new Error("Expiry date must be after effective date");
    }
    this.raise({
      type: "PolicyIssued",
      version: 2,
      policyId: this.id,
      policyholderId: params.policyholderId,
      productCode: params.productCode,
      coverageAmount: params.coverageAmount,
      premiumAmount: params.premiumAmount,
      currency: params.currency ?? "GBP",
      effectiveDate: params.effectiveDate,
      expiryDate: params.expiryDate
    });
  }

  payPremium(paymentId: string, amount: number) {
    if (this.state.status !== "active") {
      throw new Error(`Cannot pay premium on ${this.state.status} policy`);
    }
    if (amount <= 0) {
      throw new Error("Payment amount must be positive");
    }
    const nextInstallment = this.state.installmentCount + 1;
    const newTotalPaid = this.state.totalPaid + amount;
    this.raise({
      type: "PremiumPaid",
      version: 1,
      policyId: this.id,
      paymentId,
      amount,
      paidAt: new Date().toISOString(),
      installmentNumber: nextInstallment,
      totalPaid: newTotalPaid
    });
  }

  renew(newExpiryDate: string, newPremiumAmount: number) {
    if (this.state.status !== "active") {
      throw new Error(`Cannot renew ${this.state.status} policy`);
    }
    if (!this.state.expiryDate) {
      throw new Error("Policy has no expiry date");
    }
    if (new Date(newExpiryDate) <= new Date(this.state.expiryDate)) {
      throw new Error("New expiry date must be after current expiry");
    }
    if (newPremiumAmount <= 0) {
      throw new Error("New premium amount must be positive");
    }
    this.raise({
      type: "PolicyRenewed",
      version: 1,
      policyId: this.id,
      previousExpiryDate: this.state.expiryDate,
      newExpiryDate,
      newPremiumAmount,
      renewedAt: new Date().toISOString()
    });
  }

  cancel(reason: string, refundAmount: number) {
    if (this.state.status !== "active") {
      throw new Error(`Cannot cancel ${this.state.status} policy`);
    }
    if (refundAmount < 0) {
      throw new Error("Refund amount cannot be negative");
    }
    if (refundAmount > this.state.totalPaid) {
      throw new Error("Refund cannot exceed total paid premiums");
    }
    this.raise({
      type: "PolicyCancelled",
      version: 1,
      policyId: this.id,
      reason,
      refundAmount,
      cancelledAt: new Date().toISOString()
    });
  }

  expire() {
    if (this.state.status !== "active") {
      throw new Error(`Cannot expire ${this.state.status} policy`);
    }
    this.raise({
      type: "PolicyExpired",
      version: 1,
      policyId: this.id,
      expiredAt: new Date().toISOString()
    });
  }

  get policyholderId(): string | undefined {
    return this.state.policyholderId;
  }

  get status(): PolicyStatus {
    return this.state.status;
  }

  get coverageAmount(): number {
    return this.state.coverageAmount;
  }

  get totalPaid(): number {
    return this.state.totalPaid;
  }

  get expiryDate(): string | undefined {
    return this.state.expiryDate;
  }
}
