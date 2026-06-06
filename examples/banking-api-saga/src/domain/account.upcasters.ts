import type { EventUpcaster } from "@eventfabric/core";
import type { BankingEvent } from "./events";
import type { AccountOpenedV1, AccountOpenedV2 } from "./account.events";

/**
 * Per-event upcasters for the Account aggregate.
 *
 * This shows the "co-located" style — a dedicated upcaster per (type, version)
 * tuple, kept next to the event definitions. The top-level accountEventUpcaster
 * just dispatches to the right one. Other valid organizations:
 *
 *   - One big switch on (raw.type, raw.version) inline in app.ts
 *   - A dispatch table keyed by `${type}:v${version}`
 *
 * All three produce an `EventUpcaster<AccountEvent>` — the framework only
 * requires the single-function shape. Pick whatever keeps your schema
 * evolution readable as it grows.
 */

function upcastAccountOpenedV1(raw: AccountOpenedV1): AccountOpenedV2 {
  return {
    type: "AccountOpened",
    version: 2,
    accountId: raw.accountId,
    customerId: raw.customerId,
    initialBalance: raw.initialBalance,
    currency: raw.currency,
    // Backfill: V1 predates the region field. "unknown" is the agreed-upon
    // placeholder — an ops task will later fill in real regions by lookup.
    region: "unknown"
  };
}

export const accountEventUpcaster: EventUpcaster<BankingEvent> = (raw) => {
  if (raw.type === "AccountOpened" && raw.version === 1) {
    return upcastAccountOpenedV1(raw as AccountOpenedV1);
  }
  // Current-shape events pass through unchanged (the fast path).
  return raw as BankingEvent;
};
