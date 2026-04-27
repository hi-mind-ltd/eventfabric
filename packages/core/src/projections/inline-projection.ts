import type { AnyEvent, EventEnvelope, Transaction } from "../types";

export interface InlineProjection<E extends AnyEvent, TTx extends Transaction = Transaction> {
    name: string;
    handle(tx: TTx, env: EventEnvelope<E>): Promise<void>;
  }