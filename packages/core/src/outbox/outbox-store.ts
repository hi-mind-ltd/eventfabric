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
   * @param tx - Transaction context
   * @param opts - Options for claiming messages
   * @returns Array of claimed outbox rows
   */
  claimBatch(
    tx: TTx,
    opts: { batchSize: number; workerId: string; topic?: string | null }
  ): Promise<OutboxRow[]>;

  /**
   * Acknowledges successful processing of a message, removing it from the outbox.
   * 
   * @param tx - Transaction context
   * @param id - ID of the outbox row to acknowledge
   */
  ack(tx: TTx, id: OutboxRow["id"]): Promise<void>;

  /**
   * Releases a message back to the outbox after a processing error.
   * The message is unlocked so it can be retried.
   * 
   * @param tx - Transaction context
   * @param id - ID of the outbox row to release
   * @param error - Error message to store
   */
  releaseWithError(tx: TTx, id: OutboxRow["id"], error: string): Promise<void>;

  /**
   * Moves a message to the dead letter queue after exceeding max attempts.
   * The message is removed from the active outbox.
   * 
   * @param tx - Transaction context
   * @param row - Outbox row to dead letter
   * @param reason - Reason for dead lettering
   */
  deadLetter(tx: TTx, row: OutboxRow, reason: string): Promise<void>;
}
