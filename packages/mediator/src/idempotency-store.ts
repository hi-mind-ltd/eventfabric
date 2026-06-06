import type { Transaction } from "@eventfabric/core";

export type ClaimResult =
  | { state: "claimed" }
  | { state: "completed"; result: unknown }
  | { state: "in_flight" };

/**
 * Atomically deduplicates command execution by an `idempotencyKey`.
 *
 * Implementations are expected to make `claim` an atomic check-and-set —
 * Postgres uses INSERT ... ON CONFLICT DO NOTHING; the in-memory impl
 * relies on JS single-threaded execution between `await` boundaries. The
 * bus calls `claim` inside the same transaction as the handler, so a
 * rolled-back transaction releases the slot implicitly for transactional
 * stores. `release` exists for non-transactional stores (in-memory tests,
 * future external stores) that need to clear the slot on failure.
 */
export interface IdempotencyStore<TTx extends Transaction = Transaction> {
  claim(
    tx: TTx,
    params: { key: string; commandType: string; commandId: string; tenantId?: string }
  ): Promise<ClaimResult>;

  complete(tx: TTx, params: { key: string; tenantId?: string; result: unknown }): Promise<void>;

  release(tx: TTx, params: { key: string; tenantId?: string; error: Error }): Promise<void>;
}
