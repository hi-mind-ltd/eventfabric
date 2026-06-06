export type TransactionInitiatedV1 = {
  type: "TransactionInitiated";
  version: 1;
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency: string;
  description?: string;
};

export type TransactionStartedV1 = {
  type: "TransactionStarted";
  version: 1;
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  currency: string;
  description?: string;
  startedAt: string;
};

export type TransactionCompletedV1 = {
  type: "TransactionCompleted";
  version: 1;
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  completedAt: string;
};

export type TransactionFailedV1 = {
  type: "TransactionFailed";
  version: 1;
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  reason: string;
  failedAt: string;
};

export type TransactionEvent =
  | TransactionInitiatedV1
  | TransactionStartedV1
  | TransactionCompletedV1
  | TransactionFailedV1;

// Factory functions — type and version are baked in
export const TransactionInitiated = (data: Omit<TransactionInitiatedV1, "type" | "version">): TransactionInitiatedV1 =>
  ({ type: "TransactionInitiated", version: 1, ...data });

export const TransactionStarted = (data: Omit<TransactionStartedV1, "type" | "version">): TransactionStartedV1 =>
  ({ type: "TransactionStarted", version: 1, ...data });

export const TransactionCompleted = (data: Omit<TransactionCompletedV1, "type" | "version">): TransactionCompletedV1 =>
  ({ type: "TransactionCompleted", version: 1, ...data });

export const TransactionFailed = (data: Omit<TransactionFailedV1, "type" | "version">): TransactionFailedV1 =>
  ({ type: "TransactionFailed", version: 1, ...data });
