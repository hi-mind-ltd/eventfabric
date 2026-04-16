/**
 * Observability hooks for CatchUpProjector.
 *
 * Same design as AsyncRunnerObserver — lifecycle hooks are fire-and-forget,
 * runHandler wraps handler execution for context propagation. All fields
 * optional; errors in hooks never affect runtime behavior.
 */

export type CatchUpHandlerInfo = {
  projection: string;
  eventType: string;
  globalPosition: bigint;
};

export type CatchUpEventHandledInfo = CatchUpHandlerInfo & {
  durationMs: number;
};

export type CatchUpEventFailedInfo = CatchUpHandlerInfo & {
  durationMs: number;
  error: Error;
};

export type CatchUpBatchLoadedInfo = {
  projection: string;
  count: number;
  fromPosition: bigint;
};

export type CatchUpCheckpointAdvancedInfo = {
  projection: string;
  fromPosition: bigint;
  toPosition: bigint;
};

export type CatchUpProjectorErrorInfo = {
  projection: string;
  error: Error;
};

export type CatchUpProjectorObserver = {
  onBatchLoaded?(info: CatchUpBatchLoadedInfo): void;
  onEventHandled?(info: CatchUpEventHandledInfo): void;
  onEventFailed?(info: CatchUpEventFailedInfo): void;
  onCheckpointAdvanced?(info: CatchUpCheckpointAdvancedInfo): void;
  onProjectorError?(info: CatchUpProjectorErrorInfo): void;
  /**
   * Wraps handler execution for context propagation. Must invoke `handle`
   * exactly once. Return its result (or re-throw). Default: call handle()
   * directly.
   */
  runHandler?<T>(handle: () => Promise<T>, info: CatchUpHandlerInfo): Promise<T>;
};
