import { SpanStatusCode, type Attributes, type Meter, type Tracer } from "@opentelemetry/api";
import type {
  SagaObserver,
  SagaInstanceInfo,
  SagaCommandDispatchedInfo,
  SagaTimerFiredInfo,
} from "@eventfabric/sagas";

export type SagaOtelOptions = {
  tracer: Tracer;
  meter?: Meter;
  /** Prefix applied to all emitted metric names. Default: "eventfabric.saga". */
  metricPrefix?: string;
};

/**
 * Builds a {@link SagaObserver} backed by OpenTelemetry.
 *
 * - `runReact` and `runDispatch` wrap the saga reaction and the
 *   `bus.send` call respectively in `tracer.startActiveSpan`, so any
 *   OTel-instrumented library used inside (pg, http, fetch, etc.)
 *   automatically attaches child spans to the correct parent.
 * - Lifecycle hooks emit metric counters and histograms.
 *
 * If `meter` is omitted the observer still produces spans; counters and
 * histograms are no-ops. Metrics for queue depth / overdue timers are
 * polled from the database — see `createSagaQueueGauges`.
 */
export function createSagaObserver(opts: SagaOtelOptions): SagaObserver {
  const { tracer, meter } = opts;
  const prefix = opts.metricPrefix ?? "eventfabric.saga";

  const startedCounter = meter?.createCounter(`${prefix}.instances_started`, {
    description: "Total saga instances created",
  });
  const completedCounter = meter?.createCounter(`${prefix}.instances_completed`, {
    description: "Total saga instances that ran reaction.end and moved to completed",
  });
  const failedCounter = meter?.createCounter(`${prefix}.instances_failed`, {
    description: "Total saga instances flipped to status='failed'",
  });
  const ageHistogram = meter?.createHistogram(`${prefix}.instance_age_seconds`, {
    description: "Wall-clock seconds from instance creation to completion",
    unit: "s",
  });

  const commandDispatchCounter = meter?.createCounter(`${prefix}.command_dispatch_total`, {
    description: "Total saga commands processed by the dispatcher, labelled by result",
  });
  const commandDispatchDurationHistogram = meter?.createHistogram(
    `${prefix}.command_dispatch_duration_ms`,
    {
      description: "Wall-clock milliseconds spent in bus.send per saga-emitted command",
      unit: "ms",
    }
  );

  const loopErrorCounter = meter?.createCounter(`${prefix}.loop_error_total`, {
    description: "Rounds of the timer scheduler or command dispatcher that threw and were retried after a backoff",
  });

  const timerFireCounter = meter?.createCounter(`${prefix}.timer_fire_total`, {
    description: "Total saga timers processed by the scheduler, labelled by result",
  });
  const timerFireDurationHistogram = meter?.createHistogram(
    `${prefix}.timer_fire_duration_ms`,
    {
      description: "Wall-clock milliseconds from timer claim to mark-fired/release",
      unit: "ms",
    }
  );

  // Metric attributes must be low-cardinality: every distinct combination is
  // a separate time series. Instance and timer ids go on spans only.
  const instanceMetricAttrs = (info: SagaInstanceInfo): Attributes => ({
    "eventfabric.saga": info.sagaName,
    "eventfabric.tenant_id": info.tenantId,
  });
  const instanceAttrs = (info: SagaInstanceInfo): Attributes => ({
    ...instanceMetricAttrs(info),
    "eventfabric.saga_instance": info.instanceId,
  });

  const commandMetricAttrs = (
    info: Omit<SagaCommandDispatchedInfo, "durationMs">
  ): Attributes => ({
    "eventfabric.saga": info.sagaName,
    "eventfabric.tenant_id": info.tenantId,
    "eventfabric.command_type": info.commandType,
    "eventfabric.attempts": info.attempts,
  });
  const commandAttrs = (
    info: Omit<SagaCommandDispatchedInfo, "durationMs">
  ): Attributes => ({
    ...commandMetricAttrs(info),
    "eventfabric.saga_instance": info.instanceId,
  });

  const timerMetricAttrs = (info: SagaTimerFiredInfo | { sagaName: string; tenantId: string }): Attributes => ({
    "eventfabric.saga": info.sagaName,
    "eventfabric.tenant_id": info.tenantId,
  });

  return {
    onInstanceStarted(info) {
      startedCounter?.add(1, instanceMetricAttrs(info));
    },

    onInstanceCompleted(info) {
      const attrs = instanceMetricAttrs(info);
      completedCounter?.add(1, attrs);
      ageHistogram?.record(info.ageMs / 1000, attrs);
    },

    onInstanceFailed(info) {
      failedCounter?.add(1, {
        ...instanceMetricAttrs(info),
        "eventfabric.error_name": info.error.name,
      });
    },

    onCommandDispatched(info) {
      const attrs = { ...commandMetricAttrs(info), "eventfabric.result": "dispatched" };
      commandDispatchCounter?.add(1, attrs);
      commandDispatchDurationHistogram?.record(info.durationMs, attrs);
    },

    onCommandReleased(info) {
      const attrs = {
        ...commandMetricAttrs(info),
        "eventfabric.result": "released",
        "eventfabric.error_name": info.error.name,
      };
      commandDispatchCounter?.add(1, attrs);
      commandDispatchDurationHistogram?.record(info.durationMs, attrs);
    },

    onCommandFailed(info) {
      const attrs = {
        ...commandMetricAttrs(info),
        "eventfabric.result": "failed",
        "eventfabric.error_name": info.error.name,
      };
      commandDispatchCounter?.add(1, attrs);
      commandDispatchDurationHistogram?.record(info.durationMs, attrs);
    },

    onTimerFired(info) {
      const attrs = { ...timerMetricAttrs(info), "eventfabric.result": "fired" };
      timerFireCounter?.add(1, attrs);
      timerFireDurationHistogram?.record(info.durationMs, attrs);
    },

    onTimerReleased(info) {
      const attrs = {
        ...timerMetricAttrs(info),
        "eventfabric.result": "released",
        "eventfabric.reason": info.reason,
      };
      timerFireCounter?.add(1, attrs);
      timerFireDurationHistogram?.record(info.durationMs, attrs);
    },

    onTimerSkipped(info) {
      const attrs = {
        ...timerMetricAttrs(info),
        "eventfabric.result": "skipped",
        "eventfabric.reason": info.reason,
      };
      timerFireCounter?.add(1, attrs);
      timerFireDurationHistogram?.record(info.durationMs, attrs);
    },

    onTimerOrphaned(info) {
      timerFireCounter?.add(1, {
        ...timerMetricAttrs(info),
        "eventfabric.result": "orphaned",
      });
    },

    onLoopError(info) {
      loopErrorCounter?.add(1, {
        "eventfabric.component": info.component,
        "eventfabric.error_name": info.error.name,
      });
    },

    async runReact(react, info) {
      return tracer.startActiveSpan(
        `saga:${info.sagaName}.react`,
        {
          attributes: {
            ...instanceAttrs(info),
            "eventfabric.delivery": info.delivery,
            "eventfabric.trigger": info.trigger,
          },
        },
        async (span) => {
          try {
            const result = await react();
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
    },

    async runDispatch(send, info) {
      return tracer.startActiveSpan(
        `saga:${info.sagaName}.dispatch`,
        { attributes: commandAttrs(info) },
        async (span) => {
          try {
            const result = await send();
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
    },
  };
}
