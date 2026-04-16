# Observability

EventFabric's async and catch-up projection runners expose **lifecycle hooks** that let you wire in any observability stack -- console logs, Prometheus, Datadog, New Relic, or OpenTelemetry. The `@eventfabric/opentelemetry` package provides ready-made OpenTelemetry adapters that emit spans, counters, and histograms.

## Why observability for async runners

Projection runners are background processes. Unlike HTTP endpoints, they don't have request/response cycles that generate traces automatically. Without observability hooks, a failing projection is invisible until the outbox backlog grows or a user reports stale data.

The observer pattern gives you:

- **Per-handler span tracing**: See which projection handled which event, how long it took, and whether it succeeded.
- **Counters and histograms**: Track throughput, failure rates, and latency distributions.
- **Context propagation**: Child spans from instrumented libraries (pg, HTTP clients, Redis) auto-attach to the correct parent span.
- **Alerting signals**: Dead-letter counts, runner errors, and backlog growth.

## AsyncRunnerObserver

All fields are optional. Hooks are synchronous and fire-and-forget -- the runner never awaits them and never lets their errors affect runtime behavior.

```typescript
// @eventfabric/core

export type AsyncRunnerObserver = {
  onBatchClaimed?(info: AsyncBatchClaimedInfo): void;
  onEventHandled?(info: AsyncEventHandledInfo): void;
  onEventFailed?(info: AsyncEventFailedInfo): void;
  onMessageAcked?(info: AsyncMessageAckedInfo): void;
  onMessageReleased?(info: AsyncMessageReleasedInfo): void;
  onMessageDeadLettered?(info: AsyncMessageDeadLetteredInfo): void;
  onRunnerError?(info: AsyncRunnerErrorInfo): void;
  runHandler?<T>(handle: () => Promise<T>, info: AsyncHandlerInfo): Promise<T>;
};
```

### Hook payload types

```typescript
export type AsyncHandlerInfo = {
  workerId: string;
  projection: string;
  eventType: string;
  globalPosition: bigint;
  attempts: number;
};

export type AsyncBatchClaimedInfo = {
  workerId: string;
  count: number;
  topic: string | null;
};

export type AsyncEventHandledInfo = AsyncHandlerInfo & {
  durationMs: number;   // Wall-clock milliseconds inside the handler
};

export type AsyncEventFailedInfo = AsyncHandlerInfo & {
  durationMs: number;
  error: Error;
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
```

### Hook lifecycle

| Hook | Fires when | Info |
|------|-----------|------|
| `onBatchClaimed` | A non-empty batch of outbox rows is claimed | Worker ID, batch count, topic |
| `onEventHandled` | A projection handler completes successfully | Handler info + duration |
| `onEventFailed` | A projection handler throws | Handler info + duration + error |
| `onMessageAcked` | An outbox row is deleted after successful processing | Worker ID, outbox row ID |
| `onMessageReleased` | An outbox row is unlocked after a failure | Worker ID, outbox row ID, error |
| `onMessageDeadLettered` | A message exceeds `maxAttempts` and is moved to the DLQ | Worker ID, outbox row ID, reason, attempt count |
| `onRunnerError` | The runner's main loop encounters an unrecoverable error | Worker ID, error |

### `runHandler` for context propagation

The `runHandler` hook is special -- it is async and wraps handler execution. It must invoke `handle` exactly once and return its result (or re-throw). Use it for context propagation so that instrumented libraries inside the handler body see the correct parent span.

```typescript
runHandler: async (handle, info) => {
  return tracer.startActiveSpan(
    `${info.projection}.handle`,
    { attributes: { "eventfabric.event_type": info.eventType } },
    async (span) => {
      try {
        const result = await handle();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    }
  );
};
```

## CatchUpProjectorObserver

The catch-up projector has its own observer with the same design principles.

```typescript
// @eventfabric/core

export type CatchUpProjectorObserver = {
  onBatchLoaded?(info: CatchUpBatchLoadedInfo): void;
  onEventHandled?(info: CatchUpEventHandledInfo): void;
  onEventFailed?(info: CatchUpEventFailedInfo): void;
  onCheckpointAdvanced?(info: CatchUpCheckpointAdvancedInfo): void;
  onProjectorError?(info: CatchUpProjectorErrorInfo): void;
  runHandler?<T>(handle: () => Promise<T>, info: CatchUpHandlerInfo): Promise<T>;
};
```

### Hook payload types

```typescript
export type CatchUpHandlerInfo = {
  projection: string;
  eventType: string;
  globalPosition: bigint;
};

export type CatchUpBatchLoadedInfo = {
  projection: string;
  count: number;
  fromPosition: bigint;
};

export type CatchUpEventHandledInfo = CatchUpHandlerInfo & {
  durationMs: number;
};

export type CatchUpEventFailedInfo = CatchUpHandlerInfo & {
  durationMs: number;
  error: Error;
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
```

### Hook lifecycle

| Hook | Fires when | Info |
|------|-----------|------|
| `onBatchLoaded` | A batch of events is loaded from the event store | Projection name, count, starting position |
| `onEventHandled` | A handler completes successfully | Handler info + duration |
| `onEventFailed` | A handler throws | Handler info + duration + error |
| `onCheckpointAdvanced` | The checkpoint is updated after a batch | Projection name, from/to positions |
| `onProjectorError` | The projector encounters an error (batch-level) | Projection name, error |

## `fireHook` safety

Both runners use the same pattern to invoke observer hooks:

```typescript
private fireHook<I>(hook: ((info: I) => void) | undefined, info: I): void {
  if (!hook) return;
  try {
    hook(info);
  } catch {
    // Observer errors must never affect runner behavior.
  }
}
```

This guarantees that a buggy observer can never crash the runner. Lifecycle hooks are synchronous and fire-and-forget. Only `runHandler` is async (because it wraps handler execution), and its errors propagate as if thrown by the handler itself.

## Console observer example

A minimal observer for development and debugging:

```typescript
import type { AsyncRunnerObserver } from "@eventfabric/core";

const consoleObserver: AsyncRunnerObserver = {
  onBatchClaimed: (info) =>
    console.log(`[${info.workerId}] Claimed ${info.count} messages (topic=${info.topic})`),

  onEventHandled: (info) =>
    console.log(
      `[${info.workerId}] ${info.projection} handled ${info.eventType} ` +
      `@${info.globalPosition} in ${info.durationMs}ms`
    ),

  onEventFailed: (info) =>
    console.error(
      `[${info.workerId}] ${info.projection} FAILED ${info.eventType} ` +
      `@${info.globalPosition}: ${info.error.message}`
    ),

  onMessageDeadLettered: (info) =>
    console.warn(
      `[${info.workerId}] DLQ outboxId=${info.outboxId} ` +
      `attempts=${info.attempts}: ${info.reason}`
    ),

  onRunnerError: (info) =>
    console.error(`[${info.workerId}] Runner error: ${info.error.message}`)
};
```

Wire it into the runner:

```typescript
const runner = createAsyncProjectionRunner(pool, store, projections, {
  workerId: "worker-1",
  observer: consoleObserver
});
```

## New Relic example

If you use New Relic's Node.js agent (which patches modules at startup), you can instrument handlers with custom segments:

```typescript
import newrelic from "newrelic";
import type { AsyncRunnerObserver } from "@eventfabric/core";

const newRelicObserver: AsyncRunnerObserver = {
  onEventHandled: (info) => {
    newrelic.recordMetric(
      `Custom/EventFabric/${info.projection}/handled`,
      info.durationMs
    );
  },

  onEventFailed: (info) => {
    newrelic.noticeError(info.error, {
      projection: info.projection,
      eventType: info.eventType,
      globalPosition: info.globalPosition.toString()
    });
  },

  onMessageDeadLettered: (info) => {
    newrelic.recordCustomEvent("EventFabricDLQ", {
      workerId: info.workerId,
      outboxId: String(info.outboxId),
      reason: info.reason,
      attempts: info.attempts
    });
  },

  runHandler: async (handle, info) => {
    return newrelic.startSegment(
      `EventFabric/${info.projection}.handle`,
      true,
      handle
    );
  }
};
```

## `@eventfabric/opentelemetry` package

The `@eventfabric/opentelemetry` package provides production-ready observer factories that emit spans, counters, and histograms via the OpenTelemetry API.

```typescript
import {
  createAsyncRunnerObserver,
  createCatchUpObserver
} from "@eventfabric/opentelemetry";
```

### `createAsyncRunnerObserver(opts)`

```typescript
export type AsyncRunnerOtelOptions = {
  tracer: Tracer;
  meter?: Meter;
  metricPrefix?: string;  // Default: "eventfabric.async_runner"
};

export function createAsyncRunnerObserver(opts: AsyncRunnerOtelOptions): AsyncRunnerObserver;
```

If `meter` is omitted, the observer still produces spans; counters and histograms are no-ops. This lets you opt into metrics separately from tracing.

### `createCatchUpObserver(opts)`

```typescript
export type CatchUpOtelOptions = {
  tracer: Tracer;
  meter?: Meter;
  metricPrefix?: string;  // Default: "eventfabric.catch_up"
};

export function createCatchUpObserver(opts: CatchUpOtelOptions): CatchUpProjectorObserver;
```

### Metrics emitted

#### Async runner metrics (`eventfabric.async_runner.*`)

| Metric name | Type | Attributes | Description |
|-------------|------|------------|-------------|
| `eventfabric.async_runner.batch_claimed` | Counter | `eventfabric.runner`, `eventfabric.worker_id`, `eventfabric.topic` | Total batches claimed |
| `eventfabric.async_runner.events_claimed` | Counter | `eventfabric.runner`, `eventfabric.worker_id`, `eventfabric.topic` | Total events across claimed batches |
| `eventfabric.async_runner.events_handled` | Counter | `eventfabric.runner`, `eventfabric.worker_id`, `eventfabric.projection`, `eventfabric.event_type`, `eventfabric.global_position`, `eventfabric.attempts` | Events successfully handled |
| `eventfabric.async_runner.events_failed` | Counter | (same as handled) + `eventfabric.error_name` | Handler failures |
| `eventfabric.async_runner.messages_acked` | Counter | `eventfabric.runner`, `eventfabric.worker_id` | Messages acknowledged (deleted from outbox) |
| `eventfabric.async_runner.messages_released` | Counter | `eventfabric.runner`, `eventfabric.worker_id`, `eventfabric.error_name` | Messages released for retry |
| `eventfabric.async_runner.messages_dead_lettered` | Counter | `eventfabric.runner`, `eventfabric.worker_id`, `eventfabric.attempts` | Messages moved to DLQ |
| `eventfabric.async_runner.runner_errors` | Counter | `eventfabric.runner`, `eventfabric.worker_id`, `eventfabric.error_name` | Runner-level errors |
| `eventfabric.async_runner.handler_duration_ms` | Histogram (ms) | (same as handled) | Wall-clock duration per handler invocation |

#### Catch-up metrics (`eventfabric.catch_up.*`)

| Metric name | Type | Attributes | Description |
|-------------|------|------------|-------------|
| `eventfabric.catch_up.batches_loaded` | Counter | `eventfabric.runner`, `eventfabric.projection`, `eventfabric.from_position` | Total batches loaded from event store |
| `eventfabric.catch_up.events_loaded` | Counter | (same as batches_loaded) | Total events across loaded batches |
| `eventfabric.catch_up.events_handled` | Counter | `eventfabric.runner`, `eventfabric.projection`, `eventfabric.event_type`, `eventfabric.global_position` | Events successfully handled |
| `eventfabric.catch_up.events_failed` | Counter | (same as handled) + `eventfabric.error_name` | Handler failures |
| `eventfabric.catch_up.checkpoints_advanced` | Counter | `eventfabric.runner`, `eventfabric.projection`, `eventfabric.from_position`, `eventfabric.to_position` | Checkpoint advances |
| `eventfabric.catch_up.projector_errors` | Counter | `eventfabric.runner`, `eventfabric.projection`, `eventfabric.error_name` | Projector-level errors |
| `eventfabric.catch_up.handler_duration_ms` | Histogram (ms) | (same as handled) | Wall-clock duration per handler invocation |

### Span attributes

Both observers set the following attributes on spans created by `runHandler`:

| Attribute | Type | Description |
|-----------|------|-------------|
| `eventfabric.runner` | string | `"async"` or `"catch_up"` |
| `eventfabric.worker_id` | string | Worker ID (async only) |
| `eventfabric.projection` | string | Projection name |
| `eventfabric.event_type` | string | Event type (e.g., `"AccountDeposited"`) |
| `eventfabric.global_position` | string | Global position (stringified bigint) |
| `eventfabric.attempts` | number | Attempt count (async only) |

On failure, the span also records the exception and sets `SpanStatusCode.ERROR`.

### Context propagation

The `runHandler` hook uses `tracer.startActiveSpan`, which sets the new span as the **active span** on the current OpenTelemetry context for the duration of the callback. This means:

- Any OTel-instrumented library used inside the handler body (`pg`, `http`, `fetch`, `redis`, etc.) automatically creates child spans attached to the correct parent.
- You don't need to manually pass span context through your handler code.
- The trace tree accurately reflects the causal relationship: runner -> projection handler -> database query / HTTP call.

```
[async_runner] email-notifications.handle  (parent span)
  ├── [pg] SELECT FROM eventfabric.events   (child span, auto-attached)
  ├── [http] POST https://api.sendgrid.com  (child span, auto-attached)
  └── [pg] DELETE FROM eventfabric.outbox    (child span, auto-attached)
```

## Banking-api wiring example

Full example showing how to wire OpenTelemetry observers into the banking-api:

```typescript
import { trace, metrics } from "@opentelemetry/api";
import {
  createAsyncRunnerObserver,
  createCatchUpObserver
} from "@eventfabric/opentelemetry";
import { createAsyncProjectionRunner, createCatchUpProjector } from "@eventfabric/postgres";
import { sleep } from "@eventfabric/core";
import type { BankingEvent } from "./domain/events";

// Get OTel tracer and meter (configured elsewhere in your OTel setup)
const tracer = trace.getTracer("banking-api");
const meter = metrics.getMeter("banking-api");

// Create observers
const asyncObserver = createAsyncRunnerObserver({ tracer, meter });
const catchUpObserver = createCatchUpObserver({ tracer, meter });

// Wire into async runner
const emailRunner = createAsyncProjectionRunner(pool, store, [emailNotificationProjection], {
  workerId: "email-worker-1",
  batchSize: 10,
  transactionMode: "perRow",
  maxAttempts: 5,
  observer: asyncObserver   // <-- OpenTelemetry observer
});

// Wire into catch-up projector
const catchUpProjector = createCatchUpProjector<BankingEvent>(pool, store);
const catchUpProjections = [
  withdrawalProjection,
  depositProjection,
  completionProjection,
  depositAuditProjection
];

// Start runners
const abortController = new AbortController();

emailRunner.start(abortController.signal).catch(console.error);

(async () => {
  while (!abortController.signal.aborted) {
    try {
      await catchUpProjector.catchUpAll(catchUpProjections, {
        batchSize: 100,
        observer: catchUpObserver   // <-- OpenTelemetry observer
      });
    } catch (err) {
      console.error("Catch-up error:", err);
    }
    try {
      await sleep(500, abortController.signal);
    } catch {
      break;
    }
  }
})();

// Graceful shutdown
process.on("SIGINT", () => {
  abortController.abort();
  pool.end();
});
```

With this wiring:

- Every handler invocation creates a span named `{projection}.handle`.
- Counters track events handled, failed, acked, released, and dead-lettered.
- Histograms record handler duration for P50/P95/P99 latency analysis.
- Child spans from `pg` queries inside handlers auto-attach to the handler span.

## Related docs

- [Async Projections](./projections/async-projections.md) -- the `AsyncProjectionRunner` and `AsyncRunnerOptions`
- [Catch-Up Projections](./projections/catch-up-projections.md) -- the `CatchUpProjector` and `CatchUpOptions`
- [Outbox and DLQ](./outbox-and-dlq.md) -- monitoring outbox backlog and DLQ activity
- [Projections Overview](./projections/overview.md) -- how observability fits into the projection tiers
