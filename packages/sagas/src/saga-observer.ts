/**
 * Observability hooks for the saga runner, dispatcher, and timer scheduler.
 *
 * All fields are optional — set only the ones you care about. Hooks are
 * vendor-neutral: the library calls them at semantic lifecycle points,
 * and the caller wires them into whatever observability stack they use
 * (console logs, Prometheus, Datadog, OpenTelemetry).
 *
 * Lifecycle hooks are synchronous and fire-and-forget. The runtime never
 * awaits them and never lets their errors affect behavior, so a buggy
 * observer cannot crash a saga.
 *
 * `runReact` / `runDispatch` / `runTimer` are the wrap-style exceptions:
 * they are async and their errors propagate (as if thrown by the wrapped
 * step). Use them for context propagation — e.g. OpenTelemetry
 * `startActiveSpan` — so nested instrumented libraries inside the
 * reaction body see the correct parent span.
 */

export type SagaInstanceInfo = {
  sagaName: string;
  instanceId: string;
  tenantId: string;
};

export type SagaInstanceStartedInfo = SagaInstanceInfo;

export type SagaInstanceCompletedInfo = SagaInstanceInfo & {
  /** Wall-clock milliseconds from instance creation to completion. */
  ageMs: number;
};

export type SagaInstanceFailedInfo = SagaInstanceInfo & {
  error: Error;
};

export type SagaReactInfo = SagaInstanceInfo & {
  /** "event" or "timer" — which delivery shape triggered the reaction. */
  delivery: "event" | "timer";
  /** Event type (when delivery="event") or timer id (when delivery="timer"). */
  trigger: string;
};

export type SagaCommandDispatchedInfo = {
  sagaName: string;
  instanceId: string;
  tenantId: string;
  /** Database id of the row in `saga_pending_commands`. */
  rowId: string;
  /** Command type that was dispatched. */
  commandType: string;
  /** Number of dispatch attempts including this one. */
  attempts: number;
  /** Wall-clock milliseconds spent inside `bus.send`. */
  durationMs: number;
};

export type SagaCommandReleasedInfo = SagaCommandDispatchedInfo & {
  error: Error;
};

export type SagaCommandFailedInfo = SagaCommandDispatchedInfo & {
  error: Error;
};

export type SagaTimerFiredInfo = {
  sagaName: string;
  instanceId: string;
  tenantId: string;
  timerId: string;
  /** Wall-clock milliseconds spent inside the saga reaction + persistence. */
  durationMs: number;
};

export type SagaTimerReleasedInfo = SagaTimerFiredInfo & {
  /** Concurrent state advance — the row was released for redelivery. */
  reason: "concurrent";
};

export type SagaTimerOrphanedInfo = {
  sagaName: string;
  instanceId: string;
  tenantId: string;
  timerId: string;
};

export type SagaObserver = {
  /** Fired when the runner inserts a fresh saga instance. */
  onInstanceStarted?(info: SagaInstanceStartedInfo): void;
  /** Fired when a reaction returns `end: true` and the instance moves to `completed`. */
  onInstanceCompleted?(info: SagaInstanceCompletedInfo): void;
  /** Fired when an instance is moved to status='failed'. Not emitted by the
   * built-in runner today (sagas don't auto-fail) — wire your own logic
   * if you flip status manually. Reserved on the surface for future use. */
  onInstanceFailed?(info: SagaInstanceFailedInfo): void;

  /** Fired when the dispatcher successfully sends a command through the bus. */
  onCommandDispatched?(info: SagaCommandDispatchedInfo): void;
  /** Fired when the dispatcher releases a row back to pending after a transient failure. */
  onCommandReleased?(info: SagaCommandReleasedInfo): void;
  /** Fired when the dispatcher gives up after `maxAttempts` and marks the row failed. */
  onCommandFailed?(info: SagaCommandFailedInfo): void;

  /** Fired when the scheduler successfully delivers a timer to a saga. */
  onTimerFired?(info: SagaTimerFiredInfo): void;
  /** Fired when the scheduler releases a timer after a concurrent state advance. */
  onTimerReleased?(info: SagaTimerReleasedInfo): void;
  /** Fired when the scheduler marks a timer fired because no saga handler is registered for its name. */
  onTimerOrphaned?(info: SagaTimerOrphanedInfo): void;

  /**
   * Wraps a saga reaction (event or timer). Must invoke `react` exactly
   * once. Return its result (or re-throw). Default: call react() directly.
   *
   * Use this for context propagation — e.g. OpenTelemetry
   * `startActiveSpan` — so other OTel-instrumented libraries called by
   * the saga see the correct parent span.
   */
  runReact?<T>(react: () => Promise<T>, info: SagaReactInfo): Promise<T>;

  /** Wraps `bus.send` for a single dispatched command. Same contract as `runReact`. */
  runDispatch?<T>(
    send: () => Promise<T>,
    info: Omit<SagaCommandDispatchedInfo, "durationMs">
  ): Promise<T>;
};
