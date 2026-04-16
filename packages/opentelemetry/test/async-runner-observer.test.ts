import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan
} from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
  DataPointType
} from "@opentelemetry/sdk-metrics";
import { createAsyncRunnerObserver } from "../src/async-runner-observer";
import type { AsyncHandlerInfo } from "@eventfabric/core";

let exporter: InMemorySpanExporter;
let tracerProvider: BasicTracerProvider;

let metricExporter: InMemoryMetricExporter;
let meterProvider: MeterProvider;
let metricReader: PeriodicExportingMetricReader;

// Install an async-hooks context manager globally once so that
// `trace.getSpan(context.active())` sees the span set by startActiveSpan.
// Without a real context manager, OTel falls back to a NoopContextManager
// that can't track async context switches and every `context.active()`
// returns an empty context.
beforeAll(() => {
  const ctxManager = new AsyncHooksContextManager();
  ctxManager.enable();
  context.setGlobalContextManager(ctxManager);
});

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)]
  });

  metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000
  });
  meterProvider = new MeterProvider({ readers: [metricReader] });
});

const sampleInfo = (): AsyncHandlerInfo => ({
  workerId: "w1",
  projection: "p1",
  eventType: "Tick",
  globalPosition: 42n,
  attempts: 1
});

describe("createAsyncRunnerObserver — tracing", () => {
  it("wraps the handler in an active span and sets OK status on success", async () => {
    const observer = createAsyncRunnerObserver({ tracer: tracerProvider.getTracer("test") });

    await observer.runHandler!(async () => {
      // The handler body runs inside the active span's context.
      const active = trace.getSpan(context.active());
      expect(active).toBeDefined();
    }, sampleInfo());

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span: ReadableSpan = spans[0]!;
    expect(span.name).toBe("p1.handle");
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes["eventfabric.projection"]).toBe("p1");
    expect(span.attributes["eventfabric.event_type"]).toBe("Tick");
    expect(span.attributes["eventfabric.global_position"]).toBe("42");
    expect(span.attributes["eventfabric.worker_id"]).toBe("w1");
    expect(span.attributes["eventfabric.attempts"]).toBe(1);
  });

  it("records the exception and sets ERROR status when the handler throws", async () => {
    const observer = createAsyncRunnerObserver({ tracer: tracerProvider.getTracer("test") });

    await expect(
      observer.runHandler!(async () => {
        throw new Error("handler boom");
      }, sampleInfo())
    ).rejects.toThrow("handler boom");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("handler boom");
    // recordException adds an exception event to the span
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("handler-internal spans attach as children of the handler span (context propagation)", async () => {
    const tracer = tracerProvider.getTracer("test");
    const observer = createAsyncRunnerObserver({ tracer });

    await observer.runHandler!(async () => {
      // Simulates an instrumented library creating a child span inside the handler.
      const child = tracer.startSpan("child-operation");
      child.end();
    }, sampleInfo());

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const child = spans.find((s) => s.name === "child-operation")!;
    const parent = spans.find((s) => s.name === "p1.handle")!;
    expect(child.parentSpanId).toBe(parent.spanContext().spanId);
  });
});

describe("createAsyncRunnerObserver — metrics", () => {
  async function collectMetrics() {
    // forceFlush on the reader triggers a collect+export cycle synchronously.
    await metricReader.forceFlush();
    const records = metricExporter.getMetrics();
    return records.flatMap((m) => m.scopeMetrics.flatMap((s) => s.metrics));
  }

  it("emits counters for handled events and records handler duration", async () => {
    const observer = createAsyncRunnerObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test")
    });

    observer.onEventHandled!({
      workerId: "w1",
      projection: "p1",
      eventType: "Tick",
      globalPosition: 1n,
      attempts: 1,
      durationMs: 12
    });
    observer.onEventHandled!({
      workerId: "w1",
      projection: "p1",
      eventType: "Tick",
      globalPosition: 2n,
      attempts: 1,
      durationMs: 18
    });

    const metrics = await collectMetrics();
    const handled = metrics.find((m) => m.descriptor.name === "eventfabric.async_runner.events_handled");
    expect(handled).toBeDefined();
    // OTel groups counter data points by unique attribute set. The two calls
    // differ in `eventfabric.global_position`, so they split into 2 points
    // each with value 1 — sum across to get total invocations.
    const total = handled!.dataPoints.reduce(
      (sum, dp) => sum + (dp.value as number),
      0
    );
    expect(total).toBe(2);

    const duration = metrics.find(
      (m) => m.descriptor.name === "eventfabric.async_runner.handler_duration_ms"
    );
    expect(duration).toBeDefined();
    expect(duration!.dataPointType).toBe(DataPointType.HISTOGRAM);
  });

  it("emits a failure counter with the error_name attribute", async () => {
    const observer = createAsyncRunnerObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test")
    });

    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomError";
      }
    }

    observer.onEventFailed!({
      workerId: "w1",
      projection: "p1",
      eventType: "Tick",
      globalPosition: 1n,
      attempts: 2,
      durationMs: 5,
      error: new CustomError("boom")
    });

    const metrics = await collectMetrics();
    const failed = metrics.find((m) => m.descriptor.name === "eventfabric.async_runner.events_failed");
    expect(failed).toBeDefined();
    expect(failed!.dataPoints[0]!.value).toBe(1);
    expect(failed!.dataPoints[0]!.attributes["eventfabric.error_name"]).toBe("CustomError");
  });

  it("emits a dead-letter counter with attempts attribute", async () => {
    const observer = createAsyncRunnerObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test")
    });

    observer.onMessageDeadLettered!({
      workerId: "w1",
      outboxId: 42,
      reason: "Exceeded maxAttempts=3",
      attempts: 4
    });

    const metrics = await collectMetrics();
    const dlq = metrics.find(
      (m) => m.descriptor.name === "eventfabric.async_runner.messages_dead_lettered"
    );
    expect(dlq).toBeDefined();
    expect(dlq!.dataPoints[0]!.value).toBe(1);
    expect(dlq!.dataPoints[0]!.attributes["eventfabric.attempts"]).toBe(4);
  });

  it("works without a meter — tracing only, no metric calls", async () => {
    const observer = createAsyncRunnerObserver({ tracer: tracerProvider.getTracer("test") });

    // Should not throw
    observer.onEventHandled!({
      workerId: "w1",
      projection: "p1",
      eventType: "Tick",
      globalPosition: 1n,
      attempts: 1,
      durationMs: 10
    });
    observer.onBatchClaimed!({ workerId: "w1", count: 5, topic: null });
    observer.onMessageAcked!({ workerId: "w1", outboxId: 1 });

    await observer.runHandler!(async () => {}, sampleInfo());

    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });
});
