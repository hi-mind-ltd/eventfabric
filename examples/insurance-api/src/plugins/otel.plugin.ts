import type { FastifyInstance } from "fastify";
import { type Tracer, SpanStatusCode, trace, context as otelContext, type Context, type Span } from "@opentelemetry/api";

type SpanRef = { span: Span; parentCtx: Context };

declare module "fastify" {
  interface FastifyRequest {
    otelSpan?: Span;
  }
}

/**
 * Fastify plugin: wraps each HTTP request in an active span so the postgres
 * calls inside route handlers attach as child spans automatically. Records
 * the tenant id (if present), route, method, and response status.
 *
 * We store the span + parent context on a private symbol so the onResponse
 * hook can close the span even if the request errors out.
 */
export function registerOtelPlugin(app: FastifyInstance, tracer: Tracer): void {
  const SPAN_REF = Symbol("otel.spanRef");

  app.addHook("onRequest", async (req) => {
    const parentCtx = otelContext.active();
    const span = tracer.startSpan(
      `HTTP ${req.method}`,
      {
        attributes: {
          "http.method": req.method,
          "http.target": req.url,
          "http.scheme": req.protocol
        }
      },
      parentCtx
    );
    const ref: SpanRef = { span, parentCtx };
    (req as unknown as Record<symbol, SpanRef>)[SPAN_REF] = ref;
    req.otelSpan = span;
  });

  app.addHook("preHandler", async (req) => {
    const ref = (req as unknown as Record<symbol, SpanRef | undefined>)[SPAN_REF];
    if (!ref) return;
    if (req.tenantId) {
      ref.span.setAttribute("eventfabric.tenant_id", req.tenantId);
    }
    if (req.routeOptions?.url) {
      ref.span.updateName(`${req.method} ${req.routeOptions.url}`);
      ref.span.setAttribute("http.route", req.routeOptions.url);
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    const ref = (req as unknown as Record<symbol, SpanRef | undefined>)[SPAN_REF];
    if (!ref) return;
    ref.span.setAttribute("http.status_code", reply.statusCode);
    if (reply.statusCode >= 500) {
      ref.span.setStatus({ code: SpanStatusCode.ERROR });
    }
    ref.span.end();
  });

  app.addHook("onError", async (req, _reply, err) => {
    const ref = (req as unknown as Record<symbol, SpanRef | undefined>)[SPAN_REF];
    if (!ref) return;
    ref.span.recordException(err);
    ref.span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  });
}

/**
 * Helper: run `fn` inside a child span anchored to the current request span.
 * Exposes the active context so any postgres / fetch calls inside become
 * children of this span automatically.
 */
export async function withChildSpan<T>(
  tracer: Tracer,
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export { trace };
