import { SpanStatusCode, type Attributes, type Meter, type Tracer } from "@opentelemetry/api";
import type { CommandMiddleware } from "@eventfabric/mediator";

export type CommandBusOtelOptions = {
  tracer: Tracer;
  meter?: Meter;
  /** Prefix applied to all emitted metric names. Default: "eventfabric.command". */
  metricPrefix?: string;
};

/**
 * Builds a `CommandMiddleware` that wraps every command in an OpenTelemetry
 * span and (optionally) emits metrics.
 *
 * Register it on the bus before any business-logic middleware so the span
 * covers the full pipeline — including idempotency middleware, retries,
 * and the handler itself:
 *
 * ```ts
 * import { createCommandBusObserver } from "@eventfabric/mediator-opentelemetry";
 *
 * const bus = new CommandBus({ uow, idempotencyStore });
 * bus.use(createCommandBusObserver({ tracer, meter }));
 * ```
 *
 * Spans are named `command:${cmd.type}`. Attributes include:
 *  - `eventfabric.command_type`
 *  - `eventfabric.command_id`
 *  - `eventfabric.idempotency_key`
 *  - `eventfabric.tenant_id` (when set on the command)
 *  - `eventfabric.principal_id` (when set)
 *  - `eventfabric.correlation_id` (when set)
 *
 * Metrics emitted (when `meter` is supplied):
 *  - `eventfabric.command.sent_total{command_type, result}` — counter
 *  - `eventfabric.command.duration_ms{command_type, result}` — histogram
 *
 * `result` is `"ok"` on success and the error class name on failure
 * (e.g. `"ConcurrentCommandInFlightError"`, `"NoHandlerRegisteredError"`,
 * `"ConcurrencyError"`, or whatever the handler threw).
 */
export function createCommandBusObserver(opts: CommandBusOtelOptions): CommandMiddleware {
  const { tracer, meter } = opts;
  const prefix = opts.metricPrefix ?? "eventfabric.command";

  const sentCounter = meter?.createCounter(`${prefix}.sent_total`, {
    description: "Total commands processed by the bus, labelled by command type and result",
  });
  const durationHistogram = meter?.createHistogram(`${prefix}.duration_ms`, {
    description: "Wall-clock milliseconds per command (full middleware chain + handler)",
    unit: "ms",
  });

  return async (cmd, _ctx, next) => {
    const baseAttrs: Attributes = {
      "eventfabric.command_type": cmd.type,
      "eventfabric.command_id": cmd.metadata.commandId,
      "eventfabric.idempotency_key": cmd.metadata.idempotencyKey,
    };
    if (cmd.metadata.tenantId !== undefined) {
      baseAttrs["eventfabric.tenant_id"] = cmd.metadata.tenantId;
    }
    if (cmd.metadata.principalId !== undefined) {
      baseAttrs["eventfabric.principal_id"] = cmd.metadata.principalId;
    }
    if (cmd.metadata.correlationId !== undefined) {
      baseAttrs["eventfabric.correlation_id"] = cmd.metadata.correlationId;
    }

    return tracer.startActiveSpan(`command:${cmd.type}`, { attributes: baseAttrs }, async (span) => {
      const startedAt = Date.now();
      try {
        const result = await next();
        const durationMs = Date.now() - startedAt;
        span.setStatus({ code: SpanStatusCode.OK });
        sentCounter?.add(1, { ...baseAttrs, "eventfabric.result": "ok" });
        durationHistogram?.record(durationMs, { ...baseAttrs, "eventfabric.result": "ok" });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const durationMs = Date.now() - startedAt;
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        const resultAttrs: Attributes = {
          ...baseAttrs,
          "eventfabric.result": error.name,
        };
        sentCounter?.add(1, resultAttrs);
        durationHistogram?.record(durationMs, resultAttrs);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}
