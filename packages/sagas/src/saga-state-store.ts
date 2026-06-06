import type { Transaction } from "@eventfabric/core";
import type { SagaInstance } from "./saga";

/**
 * Storage for saga instance state. The runner uses optimistic concurrency
 * via `stateVersion`: it loads the instance with version N, computes the
 * reaction, and calls `update` with `expectedVersion: N`. If a parallel
 * worker advanced the instance in the meantime, `update` returns false
 * and the runner releases the event for retry.
 */
export interface SagaStateStore<TState, TTx extends Transaction = Transaction> {
  load(
    tx: TTx,
    params: { sagaName: string; instanceId: string; tenantId: string }
  ): Promise<SagaInstance<TState> | null>;

  /**
   * Insert a fresh instance. Throws if (sagaName, instanceId, tenantId)
   * already exists — callers should guard with a prior `load` returning
   * null.
   */
  insert(tx: TTx, instance: SagaInstance<TState>): Promise<void>;

  /**
   * Update an existing instance with optimistic concurrency. Returns
   * `true` on success and `false` when the stored version no longer
   * matches `expectedVersion`. The caller is responsible for retrying
   * (typically by releasing the event for redelivery).
   */
  update(
    tx: TTx,
    instance: SagaInstance<TState>,
    expectedVersion: number
  ): Promise<boolean>;
}
