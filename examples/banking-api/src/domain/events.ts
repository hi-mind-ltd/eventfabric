// Union type for all domain events
import type { AccountEvent } from "./account.events";
import type { TransactionEvent } from "./transaction.events";
import type { CustomerEvent } from "./customer.events";

export type BankingEvent = AccountEvent | TransactionEvent | CustomerEvent;
