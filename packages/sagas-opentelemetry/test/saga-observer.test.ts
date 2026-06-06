import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
  DataPointType,
} from "@opentelemetry/sdk-metrics";
import { createSagaObserver, createSagaQueueGauges } from "../src";

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
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  meterProvider = new MeterProvider({ readers: [metricReader] });
});

async function collectMetrics() {
  await metricReader.forceFlush();
  const records = metricExporter.getMetrics();
  return records.flatMap((m) => m.scopeMetrics.flatMap((s) => s.metrics));
}

describe("createSagaObserver — tracing", () => {
  it("runReact wraps the saga reaction in an active span", async () => {
    const observer = createSagaObserver({
      tracer: tracerProvider.getTracer("test"),
    });

    await observer.runReact!(async () => {
      const active = trace.getSpan(context.active());
      expect(active).toBeDefined();
      return { newState: {} };
    }, {
      sagaName: "FundsTransfer",
      instanceId: "i-1",
      tenantId: "default",
      delivery: "event",
      trigger: "TransactionStarted",
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("saga:FundsTransfer.react");
    expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
    expect(spans[0]!.attributes["eventfabric.saga"]).toBe("FundsTransfer");
    expect(spans[0]!.attributes["eventfabric.delivery"]).toBe("event");
    expect(spans[0]!.attributes["eventfabric.trigger"]).toBe("TransactionStarted");
  });

  it("runReact records exceptions and sets ERROR status when the saga throws", async () => {
    const observer = createSagaObserver({
      tracer: tracerProvider.getTracer("test"),
    });

    await expect(
      observer.runReact!(async () => {
        throw new Error("react boom");
      }, {
        sagaName: "S",
        instanceId: "i",
        tenantId: "t",
        delivery: "timer",
        trigger: "withdraw-timeout",
      })
    ).rejects.toThrow("react boom");

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("react boom");
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("runDispatch wraps bus.send in an active span and propagates context", async () => {
    const tracer = tracerProvider.getTracer("test");
    const observer = createSagaObserver({ tracer });

    await observer.runDispatch!(async () => {
      const child = tracer.startSpan("child-pg-call");
      child.end();
      return undefined;
    }, {
      sagaName: "FundsTransfer",
      instanceId: "i-1",
      tenantId: "default",
      rowId: "42",
      commandType: "WithdrawFromAccount",
      attempts: 1,
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const parent = spans.find((s) => s.name === "saga:FundsTransfer.dispatch")!;
    const child = spans.find((s) => s.name === "child-pg-call")!;
    expect(child.parentSpanId).toBe(parent.spanContext().spanId);
  });
});

describe("createSagaObserver — metrics", () => {
  it("emits started/completed counters and the age histogram on lifecycle hooks", async () => {
    const observer = createSagaObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test"),
    });

    observer.onInstanceStarted!({
      sagaName: "FundsTransfer",
      instanceId: "i-1",
      tenantId: "default",
    });
    observer.onInstanceCompleted!({
      sagaName: "FundsTransfer",
      instanceId: "i-1",
      tenantId: "default",
      ageMs: 12_345,
    });

    const metrics = await collectMetrics();
    const started = metrics.find(
      (m) => m.descriptor.name === "eventfabric.saga.instances_started"
    );
    expect(started).toBeDefined();
    expect(started!.dataPoints[0]!.value).toBe(1);

    const completed = metrics.find(
      (m) => m.descriptor.name === "eventfabric.saga.instances_completed"
    );
    expect(completed).toBeDefined();

    const age = metrics.find(
      (m) => m.descriptor.name === "eventfabric.saga.instance_age_seconds"
    );
    expect(age).toBeDefined();
    expect(age!.dataPointType).toBe(DataPointType.HISTOGRAM);
  });

  it("labels command_dispatch_total by result and emits the duration histogram", async () => {
    const observer = createSagaObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test"),
    });

    observer.onCommandDispatched!({
      sagaName: "FundsTransfer",
      instanceId: "i-1",
      tenantId: "default",
      rowId: "1",
      commandType: "WithdrawFromAccount",
      attempts: 1,
      durationMs: 7,
    });
    observer.onCommandReleased!({
      sagaName: "FundsTransfer",
      instanceId: "i-1",
      tenantId: "default",
      rowId: "2",
      commandType: "WithdrawFromAccount",
      attempts: 2,
      durationMs: 9,
      error: new Error("transient"),
    });
    observer.onCommandFailed!({
      sagaName: "FundsTransfer",
      instanceId: "i-1",
      tenantId: "default",
      rowId: "3",
      commandType: "WithdrawFromAccount",
      attempts: 5,
      durationMs: 11,
      error: new Error("dead"),
    });

    const metrics = await collectMetrics();
    const dispatch = metrics.find(
      (m) => m.descriptor.name === "eventfabric.saga.command_dispatch_total"
    )!;
    expect(dispatch).toBeDefined();
    const results = dispatch.dataPoints.map(
      (dp) => dp.attributes["eventfabric.result"] as string
    );
    expect(results.sort()).toEqual(["dispatched", "failed", "released"]);

    const duration = metrics.find(
      (m) => m.descriptor.name === "eventfabric.saga.command_dispatch_duration_ms"
    );
    expect(duration!.dataPointType).toBe(DataPointType.HISTOGRAM);
  });

  it("labels timer_fire_total by result", async () => {
    const observer = createSagaObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test"),
    });

    observer.onTimerFired!({
      sagaName: "S",
      instanceId: "i",
      tenantId: "t",
      timerId: "tick",
      durationMs: 4,
    });
    observer.onTimerReleased!({
      sagaName: "S",
      instanceId: "i",
      tenantId: "t",
      timerId: "tock",
      durationMs: 6,
      reason: "concurrent",
    });
    observer.onTimerOrphaned!({
      sagaName: "S",
      instanceId: "i",
      tenantId: "t",
      timerId: "ghost",
    });

    const metrics = await collectMetrics();
    const fire = metrics.find(
      (m) => m.descriptor.name === "eventfabric.saga.timer_fire_total"
    )!;
    const results = fire.dataPoints.map(
      (dp) => dp.attributes["eventfabric.result"] as string
    );
    expect(results.sort()).toEqual(["fired", "orphaned", "released"]);
  });
});

describe("createSagaQueueGauges", () => {
  it("registers two observable gauges sourced from the provided callbacks", async () => {
    let lagCalls = 0;
    let overdueCalls = 0;
    createSagaQueueGauges({
      meter: meterProvider.getMeter("test"),
      pendingCommandsLagSeconds: async () => {
        lagCalls++;
        return 42;
      },
      overdueScheduledMessagesCount: async () => {
        overdueCalls++;
        return 7;
      },
    });

    const metrics = await collectMetrics();
    expect(lagCalls).toBeGreaterThan(0);
    expect(overdueCalls).toBeGreaterThan(0);

    const lag = metrics.find(
      (m) => m.descriptor.name === "eventfabric.saga.pending_commands_lag_seconds"
    )!;
    expect(lag).toBeDefined();
    expect(lag.dataPoints[0]!.value).toBe(42);

    const overdue = metrics.find(
      (m) => m.descriptor.name === "eventfabric.saga.scheduled_messages_overdue_count"
    )!;
    expect(overdue).toBeDefined();
    expect(overdue.dataPoints[0]!.value).toBe(7);
  });

  it("swallows errors thrown by the callbacks instead of crashing the export cycle", async () => {
    createSagaQueueGauges({
      meter: meterProvider.getMeter("test"),
      pendingCommandsLagSeconds: async () => {
        throw new Error("db down");
      },
      overdueScheduledMessagesCount: async () => 3,
    });

    // Should not throw.
    const metrics = await collectMetrics();
    const overdue = metrics.find(
      (m) => m.descriptor.name === "eventfabric.saga.scheduled_messages_overdue_count"
    )!;
    expect(overdue.dataPoints[0]!.value).toBe(3);
  });
});
