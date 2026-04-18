import type { EventUpcaster } from "@eventfabric/core";
import type { InsuranceEvent } from "./events";
import type { PolicyIssuedV1, PolicyIssuedV2 } from "./policy.events";

/**
 * Upcaster for PolicyIssued V1 → V2.
 *
 * V2 added the `productCode` field so reporting can segment policies by
 * product line (auto, home, life). Historical V1 events predate this and are
 * backfilled with `productCode: "legacy"`. An ops task will later replace
 * "legacy" with real codes by cross-referencing the source system.
 */
function upcastPolicyIssuedV1(raw: PolicyIssuedV1): PolicyIssuedV2 {
  return {
    type: "PolicyIssued",
    version: 2,
    policyId: raw.policyId,
    policyholderId: raw.policyholderId,
    productCode: "legacy",
    coverageAmount: raw.coverageAmount,
    premiumAmount: raw.premiumAmount,
    currency: raw.currency,
    effectiveDate: raw.effectiveDate,
    expiryDate: raw.expiryDate
  };
}

export const policyEventUpcaster: EventUpcaster<InsuranceEvent> = (raw) => {
  if (raw.type === "PolicyIssued" && raw.version === 1) {
    return upcastPolicyIssuedV1(raw as PolicyIssuedV1);
  }
  return raw as InsuranceEvent;
};
