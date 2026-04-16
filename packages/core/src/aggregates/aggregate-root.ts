import type { AnyEvent } from "../types";

export type HandlerMap<E extends AnyEvent, S> = {
  [K in E["type"]]?: (state: S, event: Extract<E, { type: K }>) => void;
};

export abstract class AggregateRoot<S, E extends AnyEvent> {
  public version = 0;
  public state: S;
  private pending: E[] = [];

  protected abstract handlers: HandlerMap<E, S>;

  protected constructor(public readonly id: string, initial: S) {
    this.state = initial;
  }

  public loadFromHistory(history: { payload: E; aggregateVersion: number }[]) {
    for (const h of history) {
      this.apply(h.payload, false);
      this.version = h.aggregateVersion;
    }
  }

  protected raise(...events: E[]) {
    for (const e of events) {
      // In development/test mode, validate event structure
      if (process.env.NODE_ENV !== "production") {
        this.validateEvent(e);
      }
      this.apply(e, true);
    }
  }

  /**
   * Validates that an event has the expected structure.
   * This helps catch version mismatches and other issues during development.
   */
  private validateEvent(event: E) {
    if (!event.type || typeof event.type !== "string") {
      throw new Error(`Event missing or invalid 'type' field: ${JSON.stringify(event)}`);
    }
    if (typeof event.version !== "number" || !Number.isInteger(event.version) || event.version < 1) {
      throw new Error(
        `Event '${event.type}' has invalid version: ${event.version}. Version must be a positive integer.`
      );
    }
    // Note: We can't validate that the version matches the type definition at runtime
    // because TypeScript type information is erased. This is a limitation of JavaScript.
    // To catch version mismatches at compile time, use the createEvent helper from event-helpers.ts
    // and ensure your event types use literal number types (e.g., version: 1, not version: number).
  }

  private apply(event: E, isNew: boolean) {
    const handler = this.handlers[event.type as E["type"]];
    if (!handler) throw new Error(`No handler for event type: ${event.type}`);
    handler(this.state, event as Extract<E, { type: typeof event.type }>);
    if (isNew) this.pending.push(event);
  }

  public pullPendingEvents(): E[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
