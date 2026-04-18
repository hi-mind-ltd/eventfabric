import type { PolicyholderEvent } from "./policyholder.events";
import type { PolicyEvent } from "./policy.events";
import type { ClaimEvent } from "./claim.events";

export type InsuranceEvent = PolicyholderEvent | PolicyEvent | ClaimEvent;
