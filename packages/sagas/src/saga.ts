import type { AnyEvent, EventEnvelope } from "@eventfabric/core";
import type { Command } from "@eventfabric/mediator";

/**
 * Per-reaction context handed to a saga's `react*` methods. The metadata
 * mirrors what the runner persists alongside the instance: which saga
 * instance is reacting, which tenant it belongs to, and the correlation
 * id that ties downstream commands and events back to the originating
 * flow.
 */
export interface SagaReactContext {
  readonly metadata: {
    readonly correlationId: string;
    readonly instanceId: string;
    readonly tenantId: string;
  };
}

/**
 * A timer message delivered to a saga when a previously scheduled timer
 * fires. The `id` matches the id the saga supplied when scheduling, so the
 * saga can dispatch on it inside `reactToTimer`. `payload` is opaque to
 * the runner — saga authors stuff whatever per-timer state they need.
 */
export interface TimerMessage<TPayload = unknown> {
  readonly type: "$timer";
  readonly id: string;
  readonly payload: TPayload;
}

/**
 * Description of a future timer the saga wants the runner to deliver back
 * to it. `fireAt` may be either an absolute time or a relative offset; the
 * runner converts to an absolute timestamp before persisting.
 */
export interface ScheduledMessage<TPayload = unknown> {
  readonly id: string;
  readonly fireAt: Date | { afterMs: number };
  readonly message: TimerMessage<TPayload>;
}

/**
 * A saga's pure-reducer return value. Every reaction produces:
 *  - the next state (overwrites current state in storage),
 *  - zero or more commands to dispatch (queued for async dispatcher),
 *  - zero or more new timers to schedule,
 *  - an optional list of timer ids to cancel,
 *  - an optional `end: true` to mark the instance completed.
 *
 * The runner persists state, commands, and timer changes in one
 * transaction together with the instance's checkpoint advance — so
 * downstream effects can never observe a saga that "moved" without the
 * commands or timers landing.
 */
export interface SagaReaction<TState> {
  readonly newState: TState;
  readonly commands?: readonly Command[];
  readonly schedule?: readonly ScheduledMessage[];
  readonly cancel?: readonly string[];
  readonly end?: boolean;
}

/**
 * Transforms a stored saga state snapshot into the current shape.
 *
 * Called by the runner on every load when the persisted `schemaVersion`
 * of the saga instance is less than the saga's current `version`. The
 * upcaster receives the raw deserialized JSONB payload plus the version
 * it was stored at, and returns the current-shape state.
 *
 * Sagas are snapshot-persisted (not event-sourced), so this is the only
 * schema-evolution path. Writers always persist current-shape state, so
 * upcasting only matters on reads of historical instances after a
 * `saga.version` bump.
 *
 * The runner persists the upgraded state on the next reaction's CAS
 * update — so old-shape rows are gradually rewritten as their sagas
 * advance. No bulk migration is needed.
 */
export type SagaStateUpcaster<TState> = (
  rawState: unknown,
  fromVersion: number
) => TState;

/**
 * A saga: a typed pure reducer over events and timers, plus the metadata
 * the runner needs to find the right instance for an incoming event.
 *
 * Saga implementations should be IO-free. All effects (commands, timers)
 * are returned as data on the SagaReaction; the runner persists and
 * dispatches them. This keeps sagas testable without a database.
 */
export interface Saga<TState, TEvent extends AnyEvent> {
  readonly name: string;
  readonly version: number;
  /**
   * Optional upcaster called when an instance's persisted `schemaVersion`
   * is less than `version`. Required only after the first time you bump
   * `version` against existing live instances. See `SagaStateUpcaster`.
   */
  readonly upcaster?: SagaStateUpcaster<TState>;

  /**
   * Decides which saga instance an incoming event routes to. Returning
   * `null` means "this event is not for any instance of this saga" — the
   * runner ignores it.
   */
  correlate(env: EventEnvelope<TEvent>): string | null;

  /**
   * For events that produced a non-null `correlate()` but match no
   * existing instance: should the runner create a new instance? If yes,
   * `initialState(env)` is consulted to seed the state.
   */
  startsNewInstance(env: EventEnvelope<TEvent>): boolean;

  /**
   * Build the seed state for a freshly created instance. Only invoked
   * when `startsNewInstance(env)` returns true.
   */
  initialState(env: EventEnvelope<TEvent>): TState;

  /**
   * Reaction to an event delivered to an existing (or freshly created)
   * instance. Pure: must not perform IO. Returning the unchanged state
   * with no effects is the no-op path; events the saga doesn't care
   * about should fall through to that.
   */
  reactToEvent(
    state: TState,
    env: EventEnvelope<TEvent>,
    ctx: SagaReactContext
  ): SagaReaction<TState>;

  /**
   * Reaction to a timer that previously this saga scheduled. Optional —
   * sagas without timers don't implement it. The runner only invokes it
   * for timer deliveries.
   */
  reactToTimer?(
    state: TState,
    timer: TimerMessage,
    ctx: SagaReactContext
  ): SagaReaction<TState>;
}

export type SagaInstanceStatus = "active" | "completed" | "failed";

/**
 * Persisted shape of a saga instance. `stateVersion` is incremented on
 * every transition and used for optimistic concurrency control by the
 * state store. `lastEventPos` is the highest globalPosition the runner
 * has applied — the runner skips events with `globalPosition <=
 * lastEventPos` so replay is a no-op (idempotent).
 */
export interface SagaInstance<TState> {
  readonly sagaName: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly state: TState;
  readonly stateVersion: number;
  readonly status: SagaInstanceStatus;
  readonly schemaVersion: number;
  readonly lastEventPos: bigint | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
