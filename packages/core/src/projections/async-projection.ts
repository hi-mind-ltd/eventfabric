import type { AnyEvent, EventEnvelope, Transaction } from "../types";
import type { TopicFilter } from "./topic-filter";

/**
 * A projection that is executed outside the write transaction.
 * The execution mechanism (outbox, queue, kafka, etc.) is adapter-specific.
 */
export interface AsyncProjection<E extends AnyEvent, TTx extends Transaction = Transaction> {
  name: string;

  /**
   * Optional topic filter for routing messages to this projection.
   * Used by outbox-based adapters to determine which projections should process which messages.
   * 
   * For other adapters (Kafka, queues), this may be ignored in favor of `routes`.
   */
  topicFilter?: TopicFilter;

  /**
   * Optional routing key(s). Semantics are adapter-defined.
   * - outbox adapter: use `topicFilter` instead
   * - kafka adapter: use as "topics"
   * - queue adapter: use as "queue names"
   */
  routes?: readonly string[];

  /**
   * Must be idempotent (safe to retry).
   */
  handle(tx: TTx, env: EventEnvelope<E>): Promise<void>;
}