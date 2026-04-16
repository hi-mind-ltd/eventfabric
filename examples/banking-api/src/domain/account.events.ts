/**
 * Historical event shape. Kept exported so the upcaster can reference it.
 * New code should raise AccountOpenedV2 instead; V1 events in the database
 * are migrated to V2 on load via `accountEventUpcaster`.
 */
export type AccountOpenedV1 = {
  type: "AccountOpened";
  version: 1;
  accountId: string;
  customerId: string;
  initialBalance: number;
  currency: string;
};

/**
 * Current shape. Adds `region` for regulatory tracking. Historical V1 events
 * are upcast to V2 with `region: "unknown"` at read time.
 */
export type AccountOpenedV2 = {
  type: "AccountOpened";
  version: 2;
  accountId: string;
  customerId: string;
  initialBalance: number;
  currency: string;
  region: string;
};

export type AccountDepositedV1 = {
  type: "AccountDeposited";
  version: 1;
  accountId: string;
  amount: number;
  balance: number;
  transactionId?: string;
};

export type AccountWithdrawnV1 = {
  type: "AccountWithdrawn";
  version: 1;
  accountId: string;
  amount: number;
  balance: number;
  transactionId?: string;
};

export type WithdrawalCompletedV1 = {
  type: "WithdrawalCompleted";
  version: 1;
  accountId: string;
  transactionId: string;
  amount: number;
  balance: number;
  completedAt: string;
};

export type DepositCompletedV1 = {
  type: "DepositCompleted";
  version: 1;
  accountId: string;
  transactionId: string;
  amount: number;
  balance: number;
  completedAt: string;
};

export type AccountTransferredOutV1 = {
  type: "AccountTransferredOut";
  version: 1;
  accountId: string;
  toAccountId: string;
  amount: number;
  balance: number;
  transactionId: string;
};

export type AccountTransferredInV1 = {
  type: "AccountTransferredIn";
  version: 1;
  accountId: string;
  fromAccountId: string;
  amount: number;
  balance: number;
  transactionId: string;
};

export type AccountClosedV1 = {
  type: "AccountClosed";
  version: 1;
  accountId: string;
  reason: string;
};

// The union models the *current* event shapes that downstream code sees.
// Historical versions (like AccountOpenedV1) are intentionally absent — they
// are upcast to current shapes by `accountEventUpcaster` before reaching any
// handler, projection, or read model.
export type AccountEvent =
  | AccountOpenedV2
  | AccountDepositedV1
  | AccountWithdrawnV1
  | WithdrawalCompletedV1
  | DepositCompletedV1
  | AccountTransferredOutV1
  | AccountTransferredInV1
  | AccountClosedV1;
