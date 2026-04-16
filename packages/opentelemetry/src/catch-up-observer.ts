import { SpanStatusCode, type Attributes, type Meter, type Tracer } from "@opentelemetry/api";
import type {
  CatchUpProjectorObserver,
  CatchUpHandlerInfo
} from "@eventfabric/core";

export type CatchUpOtelOptions = {
  tracer: Tracer;
  meter?: Meter;
  /** Prefix applied to all emitted metric names. Default: "eventfabric.catch_up". */
  metricPrefix?: string;
};

/**
 * Builds a {@link CatchUpProjectorObserver} backed by OpenTelemetry.
 *
 * Mirrors {@link createAsyncRunnerObserver}: spans per handler invocation via
 * `startActiveSpan` for context propagation, plus counters and a duration
 * histogram from the optional meter.
 */
export function createCatchUpObserver(opts: CatchUpOtelOptions): CatchUpProjectorObserver {
  const { tracer, meter } = opts;
  const prefix = opts.metricPrefix ?? "eventfabric.catch_up";

  const batchLoadedCounter = meter?.createCounter(`${prefix}.batches_loaded`);
  const eventsLoadedCounter = meter?.createCounter(`${prefix}.events_loaded`);
  const handledCounter = meter?.createCounter(`${prefix}.events_handled`);
  const failedCounter = meter?.createCounter(`${prefix}.events_failed`);
  const checkpointCounter = meter?.createCounter(`${prefix}.checkpoints_advanced`);
  const projectorErrorCounter = meter?.createCounter(`${prefix}.projector_errors`);
  const handlerDurationHistogram = meter?.createHistogram(`${prefix}.handler_duration_ms`, {
    description: "Wall-clock milliseconds per handler invocation",
    unit: "ms"
  });

  const baseAttrs = (info: CatchUpHandlerInfo): Attributes => ({
    "eventfabric.runner": "catch_up",
    "eventfabric.projection": info.projection,
    "eventfabric.event_type": info.eventType,
    "eventfabric.global_position": info.globalPosition.toString()
  });

  return {
    onBatchLoaded(info) {
      const attrs: Attributes = {
        "eventfabric.runner": "catch_up",
        "eventfabric.projection": info.projection,
        "eventfabric.from_position": info.fromPosition.toString()
      };
      batchLoadedCounter?.add(1, attrs);
      eventsLoadedCounter?.add(info.count, attrs);
    },

    onEventHandled(info) {
      const attrs = baseAttrs(info);
      handledCounter?.add(1, attrs);
      handlerDurationHistogram?.record(info.durationMs, attrs);
    },

    onEventFailed(info) {
      const attrs = {
        ...baseAttrs(info),
        "eventfabric.error_name": info.error.name
      };
      failedCounter?.add(1, attrs);
      handlerDurationHistogram?.record(info.durationMs, attrs);
    },

    onCheckpointAdvanced(info) {
      checkpointCounter?.add(1, {
        "eventfabric.runner": "catch_up",
        "eventfabric.projection": info.projection,
        "eventfabric.from_position": info.fromPosition.toString(),
        "eventfabric.to_position": info.toPosition.toString()
      });
    },

    onProjectorError(info) {
      projectorErrorCounter?.add(1, {
        "eventfabric.runner": "catch_up",
        "eventfabric.projection": info.projection,
        "eventfabric.error_name": info.error.name
      });
    },

    async runHandler(handle, info) {
      return tracer.startActiveSpan(
        `${info.projection}.handle`,
        { attributes: baseAttrs(info) },
        async (span) => {
          try {
            const result = await handle();
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
            throw err;
          } finally {
            span.end();
          }
        }
      );
    }
  };
}
