# @eventfabric/opentelemetry

OpenTelemetry instrumentation for `@eventfabric/core` projection runners.

Provides drop-in observer factories that wrap projection handler calls in OTel spans and emit counters + histograms via the OTel Metrics API. Any OTel-instrumented library used inside a handler (pg, http, fetch, Redis, etc.) automatically attaches child spans to the correct parent.

## Install

```bash
pnpm add @eventfabric/opentelemetry
pnpm add @opentelemetry/api
```

Peer dependencies:
- `@eventfabric/core` >= 0.1.3
- `@opentelemetry/api` >= 1.9.0

## Async Runner Observer

Instruments the outbox-based `AsyncProjectionRunner`:

```ts
import { createAsyncRunnerObserver } from "@eventfabric/opentelemetry";
import { createAsyncProjectionRunner } from "@eventfabric/postgres";
import { trace, metrics } from "@opentelemetry/api";

const observer = createAsyncRunnerObserver({
  tracer: trace.getTracer("banking-api"),
  meter: metrics.getMeter("banking-api")   // optional — omit for tracing only
});

const runner = createAsyncProjectionRunner(pool, store, [emailProjection], {
  workerId: "email-worker-1",
  batchSize: 10,
  maxAttempts: 5,
  observer
});
```

### What it emits

**Spans** (via `runHandler`):
- Span name: `{projection}.handle` (e.g. `email-notifications.handle`)
- Attributes: `eventfabric.worker_id`, `eventfabric.projection`, `eventfabric.event_type`, `eventfabric.global_position`, `eventfabric.attempts`
- Status: `OK` on success, `ERROR` with recorded exception on failure
- Context propagation: the span is set as the active span, so child spans from instrumented libraries (pg, http, etc.) attach automatically

**Metrics** (via optional `meter`):
| Metric | Type | Description |
|---|---|---|
| `eventfabric.async_runner.batch_claimed` | Counter | Batches claimed from outbox |
| `eventfabric.async_runner.events_claimed` | Counter | Events across all claimed batches |
| `eventfabric.async_runner.events_handled` | Counter | Successfully handled events |
| `eventfabric.async_runner.events_failed` | Counter | Handler failures |
| `eventfabric.async_runner.handler_duration_ms` | Histogram | Wall-clock ms per handler invocation |
| `eventfabric.async_runner.messages_acked` | Counter | Outbox messages acknowledged |
| `eventfabric.async_runner.messages_released` | Counter | Messages released after failure |
| `eventfabric.async_runner.messages_dead_lettered` | Counter | Messages moved to DLQ |
| `eventfabric.async_runner.runner_errors` | Counter | Unhandled runner errors |

## Catch-Up Projector Observer

Instruments the checkpoint-based `CatchUpProjector`:

```ts
import { createCatchUpObserver } from "@eventfabric/opentelemetry";
import { createCatchUpProjector } from "@eventfabric/postgres";
import { trace, metrics } from "@opentelemetry/api";

const observer = createCatchUpObserver({
  tracer: trace.getTracer("banking-api"),
  meter: metrics.getMeter("banking-api")
});

const projector = createCatchUpProjector(pool, store);

// Pass observer when catching up
await projector.catchUpAll(projections, { batchSize: 100, observer });
```

### What it emits

**Spans**: same pattern as async runner — `{projection}.handle` with active span context.

**Metrics**:
| Metric | Type | Description |
|---|---|---|
| `eventfabric.catch_up.batches_loaded` | Counter | Event batches loaded from store |
| `eventfabric.catch_up.events_loaded` | Counter | Events across all loaded batches |
| `eventfabric.catch_up.events_handled` | Counter | Successfully handled events |
| `eventfabric.catch_up.events_failed` | Counter | Handler failures |
| `eventfabric.catch_up.handler_duration_ms` | Histogram | Wall-clock ms per handler invocation |
| `eventfabric.catch_up.checkpoints_advanced` | Counter | Checkpoint advances |
| `eventfabric.catch_up.projector_errors` | Counter | Unhandled projector errors |

## Custom metric prefix

Both factories accept a `metricPrefix` option to namespace metrics:

```ts
const observer = createAsyncRunnerObserver({
  tracer,
  meter,
  metricPrefix: "myapp.outbox"  // default: "eventfabric.async_runner"
});
```

## Tracing only (no metrics)

Omit the `meter` option — the observer still creates spans, and all metric calls become no-ops:

```ts
const observer = createAsyncRunnerObserver({
  tracer: trace.getTracer("banking-api")
  // no meter — spans only
});
```
