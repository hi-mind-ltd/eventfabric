import { InlineProjection } from "./inline-protection";
import type { AnyEvent, EventEnvelope, Transaction } from "../types";

export class InlineProjector<E extends AnyEvent, TTx extends Transaction = Transaction> {
  constructor(private readonly projections: InlineProjection<E, TTx>[]) {}

  async run(tx: TTx, envelopes: EventEnvelope<E>[]) {
    for (const env of envelopes) {
      if (env.dismissed) continue;
      for (const p of this.projections) {
        await p.handle(tx, env);
      }
    }
  }
}
