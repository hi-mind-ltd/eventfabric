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
