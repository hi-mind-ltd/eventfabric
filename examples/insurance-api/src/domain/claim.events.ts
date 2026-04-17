export type ClaimSubmittedV1 = {
  type: "ClaimSubmitted";
  version: 1;
  claimId: string;
  policyId: string;
  policyholderId: string;
  incidentDate: string;
  description: string;
  requestedAmount: number;
  submittedAt: string;
};

export type ClaimAssignedV1 = {
  type: "ClaimAssigned";
  version: 1;
  claimId: string;
  adjusterId: string;
  assignedAt: string;
};

export type ClaimApprovedV1 = {
  type: "ClaimApproved";
  version: 1;
  claimId: string;
  approvedAmount: number;
  approvedBy: string;
  approvedAt: string;
};

export type ClaimDeniedV1 = {
  type: "ClaimDenied";
  version: 1;
  claimId: string;
  reason: string;
  deniedBy: string;
  deniedAt: string;
};

export type ClaimPaidV1 = {
  type: "ClaimPaid";
  version: 1;
  claimId: string;
  amount: number;
  paymentReference: string;
  paidAt: string;
};

export type ClaimEvent =
  | ClaimSubmittedV1
  | ClaimAssignedV1
  | ClaimApprovedV1
  | ClaimDeniedV1
  | ClaimPaidV1;

export const ClaimSubmitted = (data: Omit<ClaimSubmittedV1, "type" | "version">): ClaimSubmittedV1 =>
  ({ type: "ClaimSubmitted", version: 1, ...data });

export const ClaimAssigned = (data: Omit<ClaimAssignedV1, "type" | "version">): ClaimAssignedV1 =>
  ({ type: "ClaimAssigned", version: 1, ...data });

export const ClaimApproved = (data: Omit<ClaimApprovedV1, "type" | "version">): ClaimApprovedV1 =>
  ({ type: "ClaimApproved", version: 1, ...data });

export const ClaimDenied = (data: Omit<ClaimDeniedV1, "type" | "version">): ClaimDeniedV1 =>
  ({ type: "ClaimDenied", version: 1, ...data });

export const ClaimPaid = (data: Omit<ClaimPaidV1, "type" | "version">): ClaimPaidV1 =>
  ({ type: "ClaimPaid", version: 1, ...data });
