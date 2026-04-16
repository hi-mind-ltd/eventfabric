import type { AnyEvent, EventEnvelope, Transaction } from "../types";
import type { CatchUpProjection } from "./catch-up-projection";
import type { AsyncProjection } from "./async-projection";
import type { TopicFilter } from "./topic-filter";

/**
 * Creates a catch-up projection that only reacts to events of a single type.
 *
 * The handler is called only for events whose `type` matches `eventType`;
 * other events are skipped, but the projection's checkpoint still advances
 * past them — that's the correct behavior, since the projection has "seen"
 * the event and decided it didn't care.
 *
 * TypeScript narrows the handler's `env.payload` to
 * `Extract<E, { type: K }>`, so the handler gets precise types for just the
 * matched variant without casts.
 *
 * @example
 * const depositAudit = forEventType<BankingEvent, "AccountDeposited", PgTx>(
 *   "deposit-audit",
 *   "AccountDeposited",
 *   async (tx, env) => {
 *     // env.payload is typed as AccountDepositedV1 — full field narrowing
 *     console.log(`deposit: ${env.payload.accountId} +${env.payload.amount}`);
 *   }
 * );
 */
export function forEventType<
  E extends AnyEvent,
  K extends E["type"],
  TTx extends Transaction = Transaction
>(
  name: string,
  eventType: K,
  handle: (tx: TTx, env: EventEnvelope<Extract<E, { type: K }>>) => Promise<void>
): CatchUpProjection<E, TTx> {
  return {
    name,
    async handle(tx, env) {
      if (env.payload.type !== eventType) return;
      await handle(tx, env as EventEnvelope<Extract<E, { type: K }>>);
    }
  };
}

/**
 * Async-projection variant of {@link forEventType}.
 *
 * The optional topic filter composes with the event-type check: the
 * runner's topic filter decides which outbox rows are claimed at all, and
 * the event-type check then narrows further inside the handler. If you
 * only want topic-based routing, omit the event-type helper.
 */
export function asyncForEventType<
  E extends AnyEvent,
  K extends E["type"],
  TTx extends Transaction = Transaction
>(
  name: string,
  eventType: K,
  handle: (tx: TTx, env: EventEnvelope<Extract<E, { type: K }>>) => Promise<void>,
  options?: { topicFilter?: TopicFilter }
): AsyncProjection<E, TTx> {
  return {
    name,
    topicFilter: options?.topicFilter,
    async handle(tx, env) {
      if (env.payload.type !== eventType) return;
      await handle(tx, env as EventEnvelope<Extract<E, { type: K }>>);
    }
  };
}
