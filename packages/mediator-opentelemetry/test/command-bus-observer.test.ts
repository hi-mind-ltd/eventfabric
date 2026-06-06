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
import type { Command, CommandContext, Transaction } from "@eventfabric/mediator";
import {
  createCommandBusObserver,
  createCommandIdempotencyGauges,
} from "../src";

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

const makeCmd = (overrides: Partial<Command["metadata"]> = {}): Command => ({
  type: "Deposit",
  version: 1,
  payload: { accountId: "a1", amount: 100 },
  metadata: {
    commandId: "cmd-1",
    idempotencyKey: "idem-1",
    issuedAt: "2026-04-29T00:00:00Z",
    ...overrides,
  },
});

const tx = {} as Transaction;
const makeCtx = (cmd: Command): CommandContext => ({ tx, metadata: cmd.metadata });

describe("createCommandBusObserver — tracing", () => {
  it("wraps a command in an active span with command attributes", async () => {
    const observer = createCommandBusObserver({
      tracer: tracerProvider.getTracer("test"),
    });
    const cmd = makeCmd({
      commandId: "cmd-xyz",
      idempotencyKey: "idem-xyz",
      tenantId: "acme",
      principalId: "user-7",
      correlationId: "trace-abc",
    });

    await observer(cmd, makeCtx(cmd), async () => {
      const active = trace.getSpan(context.active());
      expect(active).toBeDefined();
      return { ok: true };
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("command:Deposit");
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes["eventfabric.command_type"]).toBe("Deposit");
    expect(span.attributes["eventfabric.command_id"]).toBe("cmd-xyz");
    expect(span.attributes["eventfabric.idempotency_key"]).toBe("idem-xyz");
    expect(span.attributes["eventfabric.tenant_id"]).toBe("acme");
    expect(span.attributes["eventfabric.principal_id"]).toBe("user-7");
    expect(span.attributes["eventfabric.correlation_id"]).toBe("trace-abc");
  });

  it("records the exception and sets ERROR status when the handler throws", async () => {
    const observer = createCommandBusObserver({
      tracer: tracerProvider.getTracer("test"),
    });
    const cmd = makeCmd();

    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "CustomError";
      }
    }

    await expect(
      observer(cmd, makeCtx(cmd), async () => {
        throw new CustomError("boom");
      })
    ).rejects.toThrow("boom");

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("boom");
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("downstream spans attach as children (context propagation)", async () => {
    const tracer = tracerProvider.getTracer("test");
    const observer = createCommandBusObserver({ tracer });
    const cmd = makeCmd();

    await observer(cmd, makeCtx(cmd), async () => {
      const child = tracer.startSpan("child-pg-call");
      child.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const parent = spans.find((s) => s.name === "command:Deposit")!;
    const child = spans.find((s) => s.name === "child-pg-call")!;
    expect(child.parentSpanId).toBe(parent.spanContext().spanId);
  });
});

describe("createCommandBusObserver — metrics", () => {
  it("emits sent_total counter and duration histogram with result='ok' on success", async () => {
    const observer = createCommandBusObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test"),
    });
    const cmd = makeCmd();
    await observer(cmd, makeCtx(cmd), async () => "result");

    const metrics = await collectMetrics();
    const sent = metrics.find((m) => m.descriptor.name === "eventfabric.command.sent_total");
    expect(sent).toBeDefined();
    expect(sent!.dataPoints[0]!.value).toBe(1);
    expect(sent!.dataPoints[0]!.attributes["eventfabric.result"]).toBe("ok");

    const duration = metrics.find(
      (m) => m.descriptor.name === "eventfabric.command.duration_ms"
    );
    expect(duration).toBeDefined();
    expect(duration!.dataPointType).toBe(DataPointType.HISTOGRAM);
  });

  it("labels result with the error class name when the handler throws", async () => {
    const observer = createCommandBusObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test"),
    });
    const cmd = makeCmd();

    class ConcurrencyError extends Error {
      constructor() {
        super("conflict");
        this.name = "ConcurrencyError";
      }
    }

    await expect(
      observer(cmd, makeCtx(cmd), async () => {
        throw new ConcurrencyError();
      })
    ).rejects.toBeInstanceOf(ConcurrencyError);

    const metrics = await collectMetrics();
    const sent = metrics.find((m) => m.descriptor.name === "eventfabric.command.sent_total")!;
    expect(sent.dataPoints[0]!.attributes["eventfabric.result"]).toBe("ConcurrencyError");
  });
});

describe("createCommandIdempotencyGauges", () => {
  it("registers two observable gauges sourced from the provided callbacks", async () => {
    let inFlightCalls = 0;
    let oldestCalls = 0;
    createCommandIdempotencyGauges({
      meter: meterProvider.getMeter("test"),
      inFlightCount: async () => {
        inFlightCalls++;
        return 3;
      },
      oldestInFlightSeconds: async () => {
        oldestCalls++;
        return 11;
      },
    });

    const metrics = await collectMetrics();
    expect(inFlightCalls).toBeGreaterThan(0);
    expect(oldestCalls).toBeGreaterThan(0);

    const inFlight = metrics.find(
      (m) => m.descriptor.name === "eventfabric.command.idempotency_in_flight_count"
    )!;
    expect(inFlight).toBeDefined();
    expect(inFlight.dataPoints[0]!.value).toBe(3);

    const oldest = metrics.find(
      (m) => m.descriptor.name === "eventfabric.command.idempotency_oldest_in_flight_seconds"
    )!;
    expect(oldest).toBeDefined();
    expect(oldest.dataPoints[0]!.value).toBe(11);
  });

  it("swallows errors thrown by the callbacks instead of crashing the export cycle", async () => {
    createCommandIdempotencyGauges({
      meter: meterProvider.getMeter("test"),
      inFlightCount: async () => {
        throw new Error("db down");
      },
      oldestInFlightSeconds: async () => 5,
    });

    const metrics = await collectMetrics();
    const oldest = metrics.find(
      (m) => m.descriptor.name === "eventfabric.command.idempotency_oldest_in_flight_seconds"
    )!;
    expect(oldest.dataPoints[0]!.value).toBe(5);
  });
});
