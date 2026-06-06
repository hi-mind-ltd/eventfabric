import type { AnyEvent, AsyncProjection, EventEnvelope, Transaction } from "@eventfabric/core";
import type { Saga } from "./saga";
import type { SagaTransitionStores } from "./saga-runner";
import { applySagaTransition } from "./saga-runner";
import type { SagaObserver } from "./saga-observer";

export interface SagaAsAsyncProjectionOptions {
  /**
   * Optional override for the projection name. Default: `saga:${saga.name}`.
   * Useful when running the same saga under two different runners (e.g.
   * separate retry policies).
   */
  readonly projectionName?: string;
  /** Observer threaded into `applySagaTransition`. Hooks fire per event. */
  readonly observer?: SagaObserver;
}

/**
 * Wraps a saga as an `AsyncProjection`, so it can run on the existing
 * outbox-based async projection runner with no new infrastructure. Each
 * incoming event is correlated to a saga instance, the reaction is
 * computed, and the resulting commands / timers / state advance commit
 * inside the runner's transaction.
 *
 * If the state CAS reports a concurrent advance, this adapter throws so
 * the runner releases the message back to the outbox for retry — the
 * normal at-least-once retry flow.
 */
export function sagaAsAsyncProjection<
  TState,
  TEvent extends AnyEvent,
  TTx extends Transaction
>(
  saga: Saga<TState, TEvent>,
  stores: SagaTransitionStores<TState, TTx>,
  opts?: SagaAsAsyncProjectionOptions
): AsyncProjection<TEvent, TTx> {
  return {
    name: opts?.projectionName ?? `saga:${saga.name}`,
    async handle(tx: TTx, env: EventEnvelope<TEvent>): Promise<void> {
      // tenantId comes from the envelope — the outer batch claim already
      // narrowed the tx to this tenant before invoking us.
      const tenantId = env.tenantId;
      const outcome = await applySagaTransition(
        saga,
        { kind: "event", envelope: env },
        { tx, tenantId },
        stores,
        { observer: opts?.observer }
      );

      if (outcome.result === "concurrent") {
        // Surface as a ConcurrencyError so the runner releases the event
        // for retry. Naming matches the framework's concurrency-retry
        // predicate (see resilience/with-concurrency-retry.ts).
        const err = new Error(
          `Concurrent advance of saga ${saga.name}:${outcome.instance.instanceId}`
        );
        err.name = "ConcurrencyError";
        throw err;
      }
      // "applied" | "skipped" → handled silently. Skipped is the correct
      // outcome for events that don't correlate to this saga at all.
    },
  };
}
