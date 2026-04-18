import { AggregateRoot, type HandlerMap } from "@eventfabric/core";
import type { ClaimEvent } from "./claim.events";

export type ClaimStatus = "submitted" | "under_review" | "approved" | "denied" | "paid";

export type ClaimState = {
  policyId?: string;
  policyholderId?: string;
  incidentDate?: string;
  description?: string;
  requestedAmount: number;
  approvedAmount?: number;
  status: ClaimStatus;
  adjusterId?: string;
  decisionReason?: string;
  paymentReference?: string;
};

export class ClaimAggregate extends AggregateRoot<ClaimState, ClaimEvent> {
  static readonly aggregateName = "Claim" as const;

  protected handlers = {
    ClaimSubmitted: (s, e) => {
      s.policyId = e.policyId;
      s.policyholderId = e.policyholderId;
      s.incidentDate = e.incidentDate;
      s.description = e.description;
      s.requestedAmount = e.requestedAmount;
      s.status = "submitted";
    },
    ClaimAssigned: (s, e) => {
      s.adjusterId = e.adjusterId;
      s.status = "under_review";
    },
    ClaimApproved: (s, e) => {
      s.status = "approved";
      s.approvedAmount = e.approvedAmount;
    },
    ClaimDenied: (s, e) => {
      s.status = "denied";
      s.decisionReason = e.reason;
    },
    ClaimPaid: (s, e) => {
      s.status = "paid";
      s.paymentReference = e.paymentReference;
    }
  } satisfies HandlerMap<ClaimEvent, ClaimState>;

  constructor(id: string, snapshot?: ClaimState) {
    super(id, snapshot ?? { requestedAmount: 0, status: "submitted" });
  }

  submit(params: {
    policyId: string;
    policyholderId: string;
    incidentDate: string;
    description: string;
    requestedAmount: number;
  }) {
    if (this.state.policyId) {
      throw new Error("Claim already submitted");
    }
    if (params.requestedAmount <= 0) {
      throw new Error("Requested amount must be positive");
    }
    if (new Date(params.incidentDate) > new Date()) {
      throw new Error("Incident date cannot be in the future");
    }
    this.raise({
      type: "ClaimSubmitted",
      version: 1,
      claimId: this.id,
      policyId: params.policyId,
      policyholderId: params.policyholderId,
      incidentDate: params.incidentDate,
      description: params.description,
      requestedAmount: params.requestedAmount,
      submittedAt: new Date().toISOString()
    });
  }

  assignAdjuster(adjusterId: string) {
    if (this.state.status !== "submitted") {
      throw new Error(`Cannot assign adjuster to claim in ${this.state.status} status`);
    }
    this.raise({
      type: "ClaimAssigned",
      version: 1,
      claimId: this.id,
      adjusterId,
      assignedAt: new Date().toISOString()
    });
  }

  approve(approvedAmount: number, approvedBy: string) {
    if (this.state.status !== "under_review") {
      throw new Error(`Cannot approve claim in ${this.state.status} status`);
    }
    if (approvedAmount <= 0) {
      throw new Error("Approved amount must be positive");
    }
    if (approvedAmount > this.state.requestedAmount) {
      throw new Error("Approved amount cannot exceed requested amount");
    }
    this.raise({
      type: "ClaimApproved",
      version: 1,
      claimId: this.id,
      approvedAmount,
      approvedBy,
      approvedAt: new Date().toISOString()
    });
  }

  deny(reason: string, deniedBy: string) {
    if (this.state.status !== "under_review") {
      throw new Error(`Cannot deny claim in ${this.state.status} status`);
    }
    this.raise({
      type: "ClaimDenied",
      version: 1,
      claimId: this.id,
      reason,
      deniedBy,
      deniedAt: new Date().toISOString()
    });
  }

  markPaid(paymentReference: string) {
    if (this.state.status !== "approved") {
      throw new Error(`Cannot pay claim in ${this.state.status} status`);
    }
    if (this.state.approvedAmount === undefined) {
      throw new Error("Claim has no approved amount");
    }
    this.raise({
      type: "ClaimPaid",
      version: 1,
      claimId: this.id,
      amount: this.state.approvedAmount,
      paymentReference,
      paidAt: new Date().toISOString()
    });
  }

  get status(): ClaimStatus {
    return this.state.status;
  }

  get policyId(): string | undefined {
    return this.state.policyId;
  }

  get policyholderId(): string | undefined {
    return this.state.policyholderId;
  }

  get requestedAmount(): number {
    return this.state.requestedAmount;
  }

  get approvedAmount(): number | undefined {
    return this.state.approvedAmount;
  }
}
