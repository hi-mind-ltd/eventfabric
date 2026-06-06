import type { Transaction } from "@eventfabric/core";
import type { Command } from "@eventfabric/mediator";

export interface SagaCommandQueueItem {
  readonly id: string;
  readonly tenantId: string;
  readonly sagaName: string;
  readonly instanceId: string;
  readonly command: Command;
  readonly attempts: number;
  /**
   * The eventId of the saga delivery that emitted this command (event or
   * timer). `null` for commands emitted by saga creation paths that lack
   * an upstream event in scope. Used by the dispatcher to stamp the
   * dispatched command's `metadata.causationId` so resulting events trace
   * back to the original cause across the saga boundary.
   */
  readonly causationEventId: string | null;
}

/**
 * Outbox for commands emitted by sagas. The runner enqueues commands in
 * the same transaction as the saga's state advance — atomic by
 * construction. A separate dispatcher worker drains the queue and sends
 * each command through the CommandBus, keyed by row id so dispatch is
 * exactly-once via the bus's idempotency layer.
 */
export interface SagaCommandQueue<TTx extends Transaction = Transaction> {
  enqueue(
    tx: TTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      command: Command;
      causationEventId?: string | null;
    }
  ): Promise<void>;

  /**
   * Atomically claim up to `batchSize` pending rows for dispatch. The
   * postgres impl uses FOR UPDATE SKIP LOCKED so multiple dispatcher
   * workers can run in parallel without overlap. The in-memory impl
   * marks rows as claimed inline.
   *
   * Rows with `next_attempt_at` in the future are skipped — see
   * `releaseWithError`'s `delayUntil` parameter.
   */
  claimBatch(tx: TTx, params: { batchSize: number }): Promise<SagaCommandQueueItem[]>;

  /** Mark a claimed row as successfully dispatched. */
  ack(tx: TTx, params: { id: string }): Promise<void>;

  /**
   * Release a claimed row back to pending after a transient dispatch
   * failure. When `delayUntil` is set, the row is held back from the
   * next claim until that time (retry backoff).
   */
  releaseWithError(
    tx: TTx,
    params: { id: string; error: Error; delayUntil?: Date }
  ): Promise<void>;
}
