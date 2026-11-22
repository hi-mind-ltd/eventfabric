import { canonicalJson, type Transaction } from "@eventfabric/core";
import { createHash } from "crypto";

export type ClaimResult =
  | { state: "claimed" }
  | {
      state: "completed";
      result: unknown;
      /**
       * The command type the key was first used with. When it differs from
       * the command being sent, the middleware throws
       * `IdempotencyKeyConflictError` instead of returning another
       * command's result. Stores that don't record it skip the check.
       */
      commandType?: string;
      /**
       * Hash of the payload the key was first used with (see
       * `commandRequestHash`). When it differs from the command being sent,
       * the middleware throws `IdempotencyKeyConflictError`. Stores (or rows)
       * that don't record it skip the check.
       */
      requestHash?: string;
    }
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
    params: { key: string; commandType: string; commandId: string; tenantId?: string; requestHash?: string }
  ): Promise<ClaimResult>;

  complete(tx: TTx, params: { key: string; tenantId?: string; result: unknown }): Promise<void>;

  release(tx: TTx, params: { key: string; tenantId?: string; error: Error }): Promise<void>;
}

/**
 * Fingerprint of a command's payload, stored with its idempotency key so a
 * key reused with a different payload is detected. SHA-256 over the
 * canonical JSON of the payload as it would be serialized (key order does
 * not matter; a Date hashes as its ISO string).
 */
export function commandRequestHash(payload: unknown): string {
  const normalized = payload === undefined ? null : JSON.parse(JSON.stringify(payload));
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}
