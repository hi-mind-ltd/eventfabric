/**
 * Observability hooks for AsyncProjectionRunner.
 *
 * All fields are optional — set only the ones you care about. Hooks are
 * vendor-neutral: the library calls them at semantic lifecycle points, and
 * the caller wires them into whatever observability stack they use
 * (console logs, Prometheus, New Relic, Datadog, OpenTelemetry).
 *
 * Lifecycle hooks are synchronous and fire-and-forget. The runner never
 * awaits them and never lets their errors affect runtime behavior, so a
 * buggy observer cannot crash the runner.
 *
 * `runHandler` is the exception: it wraps handler execution, so it is
 * async and its errors propagate (as if thrown by the handler itself).
 * Use it for context propagation — e.g. OpenTelemetry `startActiveSpan`
 * — so nested instrumented libraries inside the handler body see the
 * correct parent span.
 */

export type AsyncHandlerInfo = {
  workerId: string;
  projection: string;
  eventType: string;
  globalPosition: bigint;
  attempts: number;
};

export type AsyncEventHandledInfo = AsyncHandlerInfo & {
  /** Wall-clock milliseconds spent inside the handler (or runHandler wrapper). */
  durationMs: number;
};

export type AsyncEventFailedInfo = AsyncHandlerInfo & {
  durationMs: number;
  error: Error;
};

export type AsyncBatchClaimedInfo = {
  workerId: string;
  count: number;
  topic: string | null;
};

export type AsyncMessageAckedInfo = {
  workerId: string;
  outboxId: number | string;
};

export type AsyncMessageReleasedInfo = {
  workerId: string;
  outboxId: number | string;
  error: Error;
};

export type AsyncMessageDeadLetteredInfo = {
  workerId: string;
  outboxId: number | string;
  reason: string;
  attempts: number;
};

export type AsyncRunnerErrorInfo = {
  workerId: string;
  error: Error;
};

export type AsyncRunnerObserver = {
  onBatchClaimed?(info: AsyncBatchClaimedInfo): void;
  onEventHandled?(info: AsyncEventHandledInfo): void;
  onEventFailed?(info: AsyncEventFailedInfo): void;
  onMessageAcked?(info: AsyncMessageAckedInfo): void;
  onMessageReleased?(info: AsyncMessageReleasedInfo): void;
  onMessageDeadLettered?(info: AsyncMessageDeadLetteredInfo): void;
  onRunnerError?(info: AsyncRunnerErrorInfo): void;
  /**
   * Wraps handler execution for context propagation. Must invoke `handle`
   * exactly once. Return its result (or re-throw). Default: call handle()
   * directly.
   *
   * @example
   * // OpenTelemetry active-span wrapper:
   * runHandler: (handle, info) =>
   *   tracer.startActiveSpan(`${info.projection}.handle`, async (span) => {
   *     try { return await handle(); }
   *     finally { span.end(); }
   *   });
   */
  runHandler?<T>(handle: () => Promise<T>, info: AsyncHandlerInfo): Promise<T>;
};
