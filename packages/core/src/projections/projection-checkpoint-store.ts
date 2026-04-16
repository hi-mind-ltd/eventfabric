import type { Transaction } from "../types";

/**
 * Represents a projection checkpoint, tracking the last processed global position.
 */
export type ProjectionCheckpoint = {
  projectionName: string;
  lastGlobalPosition: bigint;
  updatedAt: string;
};

/**
 * Interface for managing projection checkpoints.
 * Checkpoints track the last processed global position for each projection,
 * enabling resumable processing and catch-up scenarios.
 */
export interface ProjectionCheckpointStore<TTx extends Transaction = Transaction> {
  /**
   * Gets the checkpoint for a projection, creating it with position 0 if it doesn't exist.
   * 
   * @param tx - Transaction context
   * @param projectionName - Name of the projection
   * @returns The projection checkpoint
   */
  get(tx: TTx, projectionName: string): Promise<ProjectionCheckpoint>;

  /**
   * Updates the checkpoint for a projection.
   * Should only update if the new position is greater than the current position
   * (optimistic concurrency control).
   * 
   * @param tx - Transaction context
   * @param projectionName - Name of the projection
   * @param lastGlobalPosition - The last processed global position
   */
  set(tx: TTx, projectionName: string, lastGlobalPosition: bigint): Promise<void>;
}
