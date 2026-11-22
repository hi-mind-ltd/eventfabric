import type { Transaction } from "../types";

/**
 * Represents a projection checkpoint, tracking the last processed global
 * position for a given (projection, tenant) pair.
 *
 * Checkpoints are per-tenant: with conjoined multi-tenancy, each projection
 * tracks one checkpoint per tenant so one tenant's slow/failing handler
 * cannot block another tenant's progress. Single-tenant deployments simply
 * use a single `tenant_id = 'default'` checkpoint.
 */
export type ProjectionCheckpoint = {
  projectionName: string;
  tenantId: string;
  lastGlobalPosition: bigint;
  updatedAt: string;
};

/**
 * Interface for managing projection checkpoints.
 *
 * Checkpoints track the last processed global position for each
 * (projection, tenant) pair. This enables resumable processing, catch-up
 * after downtime, and per-tenant fault isolation: a stuck event in tenant A
 * holds back only A's checkpoint for that projection, not B's.
 */
export interface ProjectionCheckpointStore<TTx extends Transaction = Transaction> {
  /**
   * Get the checkpoint for a (projection, tenant) pair, creating it at
   * position 0 if it doesn't exist yet.
   */
  get(tx: TTx, projectionName: string, tenantId: string): Promise<ProjectionCheckpoint>;

  /**
   * Like `get`, but also takes an exclusive lock on the (projection, tenant)
   * checkpoint for the rest of `tx`. Returns `null` without waiting when
   * another transaction already holds it.
   *
   * The catch-up projector claims the checkpoint before reading a batch, so
   * any number of projector instances (processes, nodes) can run the same
   * projection at once: each batch is processed by exactly one of them, and
   * the next instance only sees the checkpoint after that batch commits.
   *
   * Optional for backward compatibility. Without it, concurrent instances
   * may read the same checkpoint and process the same events twice.
   */
  claim?(tx: TTx, projectionName: string, tenantId: string): Promise<ProjectionCheckpoint | null>;

  /**
   * Update the checkpoint for a (projection, tenant) pair. Implementations
   * should use a monotonic write (only advance forward) so concurrent or
   * re-entrant runs cannot roll the checkpoint backward.
   */
  set(tx: TTx, projectionName: string, tenantId: string, lastGlobalPosition: bigint): Promise<void>;
}
