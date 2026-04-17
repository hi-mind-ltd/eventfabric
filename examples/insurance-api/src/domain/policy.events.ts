/**
 * Historical shape — kept so the upcaster can reference it. New code raises
 * PolicyIssuedV2. The V1 shape predates per-policy `productCode` tagging.
 */
export type PolicyIssuedV1 = {
  type: "PolicyIssued";
  version: 1;
  policyId: string;
  policyholderId: string;
  coverageAmount: number;
  premiumAmount: number;
  currency: string;
  effectiveDate: string;
  expiryDate: string;
};

/**
 * Current shape. Adds `productCode` so reporting can segment by insurance
 * product line (auto, home, life, ...). Historical V1 events are upcast with
 * `productCode: "legacy"`.
 */
export type PolicyIssuedV2 = {
  type: "PolicyIssued";
  version: 2;
  policyId: string;
  policyholderId: string;
  productCode: string;
  coverageAmount: number;
  premiumAmount: number;
  currency: string;
  effectiveDate: string;
  expiryDate: string;
};

export type PremiumPaidV1 = {
  type: "PremiumPaid";
  version: 1;
  policyId: string;
  paymentId: string;
  amount: number;
  paidAt: string;
  installmentNumber: number;
  totalPaid: number;
};

export type PolicyRenewedV1 = {
  type: "PolicyRenewed";
  version: 1;
  policyId: string;
  previousExpiryDate: string;
  newExpiryDate: string;
  newPremiumAmount: number;
  renewedAt: string;
};

export type PolicyCancelledV1 = {
  type: "PolicyCancelled";
  version: 1;
  policyId: string;
  reason: string;
  cancelledAt: string;
  refundAmount: number;
};

export type PolicyExpiredV1 = {
  type: "PolicyExpired";
  version: 1;
  policyId: string;
  expiredAt: string;
};

// Current shapes only — historical PolicyIssuedV1 is upcast before reaching handlers.
export type PolicyEvent =
  | PolicyIssuedV2
  | PremiumPaidV1
  | PolicyRenewedV1
  | PolicyCancelledV1
  | PolicyExpiredV1;

export const PolicyIssued = (data: Omit<PolicyIssuedV2, "type" | "version">): PolicyIssuedV2 =>
  ({ type: "PolicyIssued", version: 2, ...data });

export const PremiumPaid = (data: Omit<PremiumPaidV1, "type" | "version">): PremiumPaidV1 =>
  ({ type: "PremiumPaid", version: 1, ...data });

export const PolicyRenewed = (data: Omit<PolicyRenewedV1, "type" | "version">): PolicyRenewedV1 =>
  ({ type: "PolicyRenewed", version: 1, ...data });

export const PolicyCancelled = (data: Omit<PolicyCancelledV1, "type" | "version">): PolicyCancelledV1 =>
  ({ type: "PolicyCancelled", version: 1, ...data });

export const PolicyExpired = (data: Omit<PolicyExpiredV1, "type" | "version">): PolicyExpiredV1 =>
  ({ type: "PolicyExpired", version: 1, ...data });
