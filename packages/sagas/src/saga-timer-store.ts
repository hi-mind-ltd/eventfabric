import type { Transaction } from "@eventfabric/core";
import type { TimerMessage } from "./saga";

export interface SagaTimerStoreItem {
  readonly tenantId: string;
  readonly sagaName: string;
  readonly instanceId: string;
  readonly id: string;
  readonly fireAt: Date;
  readonly message: TimerMessage;
}

/**
 * Storage for scheduled timer messages. The runner schedules timers in
 * the same transaction as the saga's state advance. A separate scheduler
 * worker polls due rows and feeds them back to the saga's
 * `reactToTimer`.
 *
 * Cancellation is by `(sagaName, instanceId, tenantId, id)` — the saga
 * supplies stable ids so it can cancel previously-scheduled timers when
 * the awaited event arrives early.
 */
export interface SagaTimerStore<TTx extends Transaction = Transaction> {
  schedule(
    tx: TTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
      fireAt: Date;
      message: TimerMessage;
    }
  ): Promise<void>;

  cancel(
    tx: TTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      ids: readonly string[];
    }
  ): Promise<number>;

  /**
   * Returns timers whose `fireAt <= now` and that are still pending,
   * marking them claimed in the same call (so a parallel scheduler
   * worker doesn't pick them up). The postgres impl uses FOR UPDATE
   * SKIP LOCKED.
   */
  claimDue(
    tx: TTx,
    params: { now: Date; batchSize: number }
  ): Promise<SagaTimerStoreItem[]>;

  /**
   * Mark a claimed timer as fired (removes it from the pending set).
   *
   * Must only change a row that is still `claimed`: when the saga's
   * reaction re-schedules the same id (a recurring timer), the row is
   * `pending` again by the time this runs and has to stay that way.
   */
  markFired(
    tx: TTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
    }
  ): Promise<void>;

  /**
   * Optional, recommended. Lock a claimed timer for delivery and report
   * whether it is still `claimed`. Returns `false` when the timer was
   * cancelled or re-scheduled after the claim, or another scheduler already
   * fired it; the scheduler then skips the delivery. Holding the lock until
   * the delivery commits makes a concurrent cancel / re-schedule wait.
   *
   * Without it the scheduler delivers every claimed timer, even one that
   * was cancelled after it was claimed.
   */
  lockClaimed?(
    tx: TTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
    }
  ): Promise<boolean>;

  /**
   * Optional — mark a claimed timer as `failed` so it stays visible to
   * ops without being re-claimed. Used by the scheduler when an orphan
   * row is found (no handler for `sagaName`). In-memory test fixtures
   * can omit this; the scheduler treats it as a no-op when missing.
   */
  markFailed?(
    tx: TTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
      error: Error;
    }
  ): Promise<void>;
}
