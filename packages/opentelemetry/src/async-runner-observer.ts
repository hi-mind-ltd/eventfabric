import { SpanStatusCode, type Attributes, type Meter, type Tracer } from "@opentelemetry/api";
import type {
  AsyncRunnerObserver,
  AsyncHandlerInfo
} from "@eventfabric/core";

export type AsyncRunnerOtelOptions = {
  tracer: Tracer;
  meter?: Meter;
  /** Prefix applied to all emitted metric names. Default: "eventfabric.async_runner". */
  metricPrefix?: string;
};

/**
 * Builds an {@link AsyncRunnerObserver} backed by OpenTelemetry.
 *
 * - `runHandler` wraps each projection handler call in `tracer.startActiveSpan`,
 *   so any OTel-instrumented library used inside the handler body (pg, http,
 *   redis, etc.) automatically attaches child spans to the correct parent.
 * - Lifecycle hooks emit span events, metric counters, and histograms.
 *
 * If `meter` is omitted the observer still produces spans; counters/histograms
 * are simply no-ops. This lets callers opt into metrics separately from tracing.
 */
export function createAsyncRunnerObserver(opts: AsyncRunnerOtelOptions): AsyncRunnerObserver {
  const { tracer, meter } = opts;
  const prefix = opts.metricPrefix ?? "eventfabric.async_runner";

  // Metric instruments — cheap to create, safe to hold.
  const batchClaimedCounter = meter?.createCounter(`${prefix}.batch_claimed`, {
    description: "Total number of outbox batches claimed by the runner"
  });
  const eventsClaimedCounter = meter?.createCounter(`${prefix}.events_claimed`, {
    description: "Total number of events across all claimed batches"
  });
  const handledCounter = meter?.createCounter(`${prefix}.events_handled`, {
    description: "Total number of events successfully handled by a projection"
  });
  const failedCounter = meter?.createCounter(`${prefix}.events_failed`, {
    description: "Total number of handler failures"
  });
  const ackedCounter = meter?.createCounter(`${prefix}.messages_acked`);
  const releasedCounter = meter?.createCounter(`${prefix}.messages_released`);
  const deadLetteredCounter = meter?.createCounter(`${prefix}.messages_dead_lettered`);
  const runnerErrorCounter = meter?.createCounter(`${prefix}.runner_errors`);
  const handlerDurationHistogram = meter?.createHistogram(`${prefix}.handler_duration_ms`, {
    description: "Wall-clock milliseconds per handler invocation",
    unit: "ms"
  });

  const baseAttrs = (info: AsyncHandlerInfo): Attributes => ({
    "eventfabric.runner": "async",
    "eventfabric.worker_id": info.workerId,
    "eventfabric.projection": info.projection,
    "eventfabric.event_type": info.eventType,
    "eventfabric.global_position": info.globalPosition.toString(),
    "eventfabric.attempts": info.attempts
  });

  return {
    onBatchClaimed(info) {
      const attrs: Attributes = {
        "eventfabric.runner": "async",
        "eventfabric.worker_id": info.workerId,
        "eventfabric.topic": info.topic ?? "(none)"
      };
      batchClaimedCounter?.add(1, attrs);
      eventsClaimedCounter?.add(info.count, attrs);
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

    onMessageAcked(info) {
      ackedCounter?.add(1, {
        "eventfabric.runner": "async",
        "eventfabric.worker_id": info.workerId
      });
    },

    onMessageReleased(info) {
      releasedCounter?.add(1, {
        "eventfabric.runner": "async",
        "eventfabric.worker_id": info.workerId,
        "eventfabric.error_name": info.error.name
      });
    },

    onMessageDeadLettered(info) {
      deadLetteredCounter?.add(1, {
        "eventfabric.runner": "async",
        "eventfabric.worker_id": info.workerId,
        "eventfabric.attempts": info.attempts
      });
    },

    onRunnerError(info) {
      runnerErrorCounter?.add(1, {
        "eventfabric.runner": "async",
        "eventfabric.worker_id": info.workerId,
        "eventfabric.error_name": info.error.name
      });
    },

    async runHandler(handle, info) {
      // startActiveSpan sets this span as the *active* span on the current OTel
      // context for the duration of the callback. Handlers that use other
      // OTel-instrumented libraries (pg, http, fetch, etc.) will automatically
      // attach their own spans as children of this one.
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
