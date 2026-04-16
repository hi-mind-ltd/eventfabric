import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality
} from "@opentelemetry/sdk-metrics";
import { createCatchUpObserver } from "../src/catch-up-observer";

let exporter: InMemorySpanExporter;
let tracerProvider: BasicTracerProvider;
let metricExporter: InMemoryMetricExporter;
let meterProvider: MeterProvider;
let metricReader: PeriodicExportingMetricReader;

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

describe("createCatchUpObserver", () => {
  it("runHandler wraps in an active span with OK status on success", async () => {
    const observer = createCatchUpObserver({ tracer: tracerProvider.getTracer("test") });

    await observer.runHandler!(
      async () => {},
      { projection: "cp1", eventType: "Tick", globalPosition: 7n }
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("cp1.handle");
    expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
    expect(spans[0]!.attributes["eventfabric.projection"]).toBe("cp1");
    expect(spans[0]!.attributes["eventfabric.global_position"]).toBe("7");
  });

  it("runHandler records ERROR status and exception event on failure", async () => {
    const observer = createCatchUpObserver({ tracer: tracerProvider.getTracer("test") });

    await expect(
      observer.runHandler!(
        async () => {
          throw new Error("cp-fail");
        },
        { projection: "cp1", eventType: "Tick", globalPosition: 1n }
      )
    ).rejects.toThrow("cp-fail");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("emits handled, failed, and checkpoint counters", async () => {
    const observer = createCatchUpObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test")
    });

    observer.onEventHandled!({
      projection: "cp1",
      eventType: "Tick",
      globalPosition: 1n,
      durationMs: 5
    });
    observer.onEventFailed!({
      projection: "cp1",
      eventType: "Tick",
      globalPosition: 2n,
      durationMs: 3,
      error: new Error("x")
    });
    observer.onCheckpointAdvanced!({
      projection: "cp1",
      fromPosition: 0n,
      toPosition: 10n
    });

    await metricReader.forceFlush();
    const all = metricExporter
      .getMetrics()
      .flatMap((m) => m.scopeMetrics.flatMap((s) => s.metrics));

    expect(all.find((m) => m.descriptor.name === "eventfabric.catch_up.events_handled")).toBeDefined();
    expect(all.find((m) => m.descriptor.name === "eventfabric.catch_up.events_failed")).toBeDefined();
    expect(
      all.find((m) => m.descriptor.name === "eventfabric.catch_up.checkpoints_advanced")
    ).toBeDefined();
  });
});
