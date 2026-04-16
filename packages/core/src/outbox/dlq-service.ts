import type { Transaction } from "../types";

/**
 * Represents an item in the dead letter queue.
 */
export type DlqItem = {
  id: string | number;
  outboxId: string | number;
  globalPosition: bigint;
  topic: string | null;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: string;
};

/**
 * Options for listing DLQ items.
 */
export type ListDlqOptions = {
  limit?: number;
  offset?: number;
  topic?: string | null;
};

/**
 * Interface for managing the dead letter queue (DLQ).
 * The DLQ stores messages that have failed processing after exceeding max attempts.
 */
export interface DlqService<TTx extends Transaction = Transaction> {
  /**
   * Lists DLQ items with pagination and optional topic filtering.
   * 
   * @param options - List options
   * @returns List of DLQ items and total count
   */
  list(options?: ListDlqOptions): Promise<{ items: DlqItem[]; total: number }>;

  /**
   * Gets a specific DLQ item by ID.
   * 
   * @param dlqId - ID of the DLQ item
   * @returns The DLQ item or null if not found
   */
  get(dlqId: DlqItem["id"]): Promise<DlqItem | null>;

  /**
   * Requeues a DLQ item back to the outbox for retry.
   * 
   * @param dlqId - ID of the DLQ item to requeue
   * @returns Result indicating success and optional reason
   */
  requeue(dlqId: DlqItem["id"]): Promise<{ requeued: boolean; reason?: string }>;

  /**
   * Requeues a DLQ item by its global position.
   * 
   * @param globalPosition - Global position of the event to requeue
   * @returns Result indicating success and optional reason
   */
  requeueByGlobalPosition(globalPosition: bigint): Promise<{ requeued: boolean; reason?: string }>;

  /**
   * Requeues a range of DLQ items.
   * 
   * @param from - Starting global position (inclusive)
   * @param to - Ending global position (inclusive)
   * @returns Number of items requeued
   */
  requeueRange(from: bigint, to: bigint): Promise<{ requeued: number }>;

  /**
   * Purges DLQ items, optionally filtered by topic or age.
   * 
   * @param options - Purge options
   * @returns Number of items purged
   */
  purge(options?: { topic?: string | null; olderThan?: Date }): Promise<{ purged: number }>;
}
