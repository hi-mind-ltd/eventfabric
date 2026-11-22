import type { Transaction } from "../types";

/**
 * Represents a row in the outbox table.
 * The ID type is database-specific (number for PostgreSQL, string/ObjectId for MongoDB, etc.)
 */
export interface OutboxRow {
  id: string | number;
  globalPosition: bigint;
  topic: string | null;
  attempts: number;
}

/**
 * Interface for managing the outbox pattern.
 * The outbox pattern ensures reliable event delivery by storing events in a transactional outbox
 * that can be processed asynchronously.
 */
export interface OutboxStore<TTx extends Transaction = Transaction> {
  /**
   * Claims a batch of messages from the outbox for processing.
   * Messages are locked to prevent concurrent processing by multiple workers.
   *
   * When `leaseMs` is set, rows whose lock is older than `leaseMs` are treated
   * as abandoned (e.g. the claiming worker crashed) and may be claimed again.
   * When omitted, only unlocked rows are claimed.
   *
   * @param tx - Transaction context
   * @param opts - Options for claiming messages
   * @returns Array of claimed outbox rows
   */
  claimBatch(
    tx: TTx,
    opts: { batchSize: number; workerId: string; topic?: string | null; leaseMs?: number }
  ): Promise<OutboxRow[]>;

  /**
   * Acknowledges successful processing of a message, removing it from the outbox.
   * 
   * @param tx - Transaction context
   * @param id - ID of the outbox row to acknowledge
   * @param workerId - When given, the ack only succeeds while this worker
   *   still holds the row's lease. If another worker has taken the row over
   *   (the lease expired), it throws {@link LeaseLostError}, so the caller's
   *   transaction, including the handler's writes, rolls back.
   */
  ack(tx: TTx, id: OutboxRow["id"], workerId?: string): Promise<void>;

  /**
   * Releases a message back to the outbox after a processing error.
   * The message is unlocked so it can be retried.
   * 
   * @param tx - Transaction context
   * @param id - ID of the outbox row to release
   * @param error - Error message to store
   * @param workerId - When given, only releases the row while this worker
   *   still holds its lease (a no-op otherwise).
   */
  releaseWithError(tx: TTx, id: OutboxRow["id"], error: string, workerId?: string): Promise<void>;

  /**
   * Releases claimed messages that were never attempted (e.g. the runner
   * stopped or bailed out before reaching them). Unlocks the rows and undoes
   * the `attempts` increment applied by `claimBatch`, leaving `last_error`
   * untouched, so the release does not count towards `maxAttempts`.
   *
   * @param tx - Transaction context
   * @param ids - IDs of the outbox rows to release
   * @param workerId - When given, only releases rows this worker still holds
   *   the lease on.
   */
  release(tx: TTx, ids: OutboxRow["id"][], workerId?: string): Promise<void>;

  /**
   * Moves a message to the dead letter queue after exceeding max attempts.
   * The message is removed from the active outbox.
   * 
   * @param tx - Transaction context
   * @param row - Outbox row to dead letter
   * @param reason - Reason for dead lettering
   * @param workerId - When given, throws {@link LeaseLostError} if this
   *   worker no longer holds the row's lease.
   */
  deadLetter(tx: TTx, row: OutboxRow, reason: string, workerId?: string): Promise<void>;
}

/**
 * Thrown by `ack` / `deadLetter` when the worker's lease on an outbox row was
 * taken over by another worker (the handler outlived `leaseMs`). Throwing
 * rolls back the transaction, so the handler's writes are not committed twice.
 */
export class LeaseLostError extends Error {
  constructor(public readonly outboxId: OutboxRow["id"], public readonly workerId: string) {
    super(`Lease on outbox row ${outboxId} was lost by worker ${workerId}: another worker took it over`);
    this.name = "LeaseLostError";
  }
}
