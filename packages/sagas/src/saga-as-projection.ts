import type { AnyEvent, CatchUpProjection, EventEnvelope, ProjectionHandleContext, Transaction } from "@eventfabric/core";
import type { Saga } from "./saga";
import type { SagaTransitionStores } from "./saga-runner";
import { applySagaTransition } from "./saga-runner";
import type { SagaObserver } from "./saga-observer";

export interface SagaAsProjectionOptions {
  /** Projection (checkpoint) name. Default: `saga:${saga.name}`. */
  readonly projectionName?: string;
  /** Observer threaded into `applySagaTransition`. Hooks fire per event. */
  readonly observer?: SagaObserver;
}

/**
 * Wraps a saga as a `CatchUpProjection` for the `ProjectionDaemon` — the
 * recommended way to feed events to sagas (the equivalent of a Marten event
 * subscription feeding a Wolverine saga).
 *
 * Why the daemon: it delivers each tenant's events in `global_position`
 * order, never past the high water mark, one batch at a time per tenant
 * across all instances. That is what makes the saga's
 * `globalPosition <= lastEventPos` duplicate check sound — an event at or
 * below it really was applied already (e.g. a batch redelivered after a
 * failed commit). On the outbox runner (`sagaAsAsyncProjection`) events can
 * arrive out of order, and that check can silently drop them.
 *
 * Behaviour:
 * - State, commands, timers and `lastEventPos` commit in the daemon's batch
 *   transaction, together with the checkpoint.
 * - A concurrent advance of the same instance (e.g. a timer firing at the
 *   same moment) throws a `ConcurrencyError`; the daemon retries the event
 *   with backoff.
 * - An event that keeps failing is dead-lettered by the daemon.
 *   `daemon.replayDeadLetter(id)` re-applies it out of order, bypassing the
 *   position check, against the instance's current state.
 * - Do not `rebuild` a saga projection: replaying events would re-run
 *   reactions. (Without a `reset`, existing instances skip events at or
 *   below their `lastEventPos`, so a rebuild is a no-op for them; but new
 *   instances could be started for long-finished flows.)
 *
 * @example
 * const daemon = createProjectionDaemon(pool, store, [
 *   sagaAsProjection(fundsTransferSaga, sagaStores),
 * ]);
 */
export function sagaAsProjection<TState, TEvent extends AnyEvent, TTx extends Transaction>(
  saga: Saga<TState, TEvent>,
  stores: SagaTransitionStores<TState, TTx>,
  opts?: SagaAsProjectionOptions
): CatchUpProjection<TEvent, TTx> {
  return {
    name: opts?.projectionName ?? `saga:${saga.name}`,
    async handle(tx: TTx, env: EventEnvelope<TEvent>, ctx?: ProjectionHandleContext): Promise<void> {
      const outcome = await applySagaTransition(
        saga,
        { kind: "event", envelope: env },
        { tx, tenantId: env.tenantId },
        stores,
        { observer: opts?.observer, replay: ctx?.replay ?? false }
      );

      if (outcome.result === "concurrent") {
        const err = new Error(`Concurrent advance of saga ${saga.name}:${outcome.instance.instanceId}`);
        err.name = "ConcurrencyError";
        throw err;
      }
      // "applied" | "skipped" → nothing to do.
    },
  };
}
