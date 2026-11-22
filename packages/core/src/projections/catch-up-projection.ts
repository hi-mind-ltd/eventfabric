import type { AnyEvent, EventEnvelope, Transaction } from "../types";

/** Extra information passed to `CatchUpProjection.handle`. */
export type ProjectionHandleContext = {
  /**
   * True when the event is being re-run from the dead-letter store
   * (`ProjectionDaemon.replayDeadLetter`). The projection has already moved
   * past it, so it arrives out of order, and any "already handled" check
   * based on position must not skip it.
   */
  replay: boolean;
};

/**
 * A projection used for catch-up scenarios.
 * Catch-up projections process events from a specific global position forward,
 * typically used for rebuilding projections or processing missed events.
 */
export interface CatchUpProjection<E extends AnyEvent, TTx extends Transaction = Transaction> {
  /**
   * Unique name of the projection.
   */
  name: string;

  /**
   * Handles a single event envelope.
   * Must be idempotent (safe to retry).
   * 
   * @param tx - Transaction context
   * @param env - Event envelope to process
   * @param ctx - Set by the ProjectionDaemon; see ProjectionHandleContext
   */
  handle(tx: TTx, env: EventEnvelope<E>, ctx?: ProjectionHandleContext): Promise<void>;

  /**
   * Optional. Clears this projection's read model for one tenant before a
   * rebuild (`ProjectionDaemon.rebuild`). `tx` is scoped to that tenant, and
   * the checkpoint is reset to 0 in the same transaction. Without it, a
   * rebuild replays every event on top of the existing read model.
   */
  reset?(tx: TTx): Promise<void>;
}
