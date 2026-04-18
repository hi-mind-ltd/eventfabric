export type PolicyholderRegisteredV1 = {
  type: "PolicyholderRegistered";
  version: 1;
  policyholderId: string;
  email: string;
  fullName: string;
  dateOfBirth: string;
};

export type PolicyholderVerifiedV1 = {
  type: "PolicyholderVerified";
  version: 1;
  policyholderId: string;
  verifiedAt: string;
  kycReference: string;
};

export type PolicyholderContactUpdatedV1 = {
  type: "PolicyholderContactUpdated";
  version: 1;
  policyholderId: string;
  email?: string;
  phone?: string;
};

export type PolicyholderSuspendedV1 = {
  type: "PolicyholderSuspended";
  version: 1;
  policyholderId: string;
  reason: string;
  suspendedAt: string;
};

export type PolicyholderEvent =
  | PolicyholderRegisteredV1
  | PolicyholderVerifiedV1
  | PolicyholderContactUpdatedV1
  | PolicyholderSuspendedV1;

export const PolicyholderRegistered = (data: Omit<PolicyholderRegisteredV1, "type" | "version">): PolicyholderRegisteredV1 =>
  ({ type: "PolicyholderRegistered", version: 1, ...data });

export const PolicyholderVerified = (data: Omit<PolicyholderVerifiedV1, "type" | "version">): PolicyholderVerifiedV1 =>
  ({ type: "PolicyholderVerified", version: 1, ...data });

export const PolicyholderContactUpdated = (data: Omit<PolicyholderContactUpdatedV1, "type" | "version">): PolicyholderContactUpdatedV1 =>
  ({ type: "PolicyholderContactUpdated", version: 1, ...data });

export const PolicyholderSuspended = (data: Omit<PolicyholderSuspendedV1, "type" | "version">): PolicyholderSuspendedV1 =>
  ({ type: "PolicyholderSuspended", version: 1, ...data });
