import type { Transaction } from "@eventfabric/core";
import type { Command } from "./command";
import type { CommandMiddleware } from "./middleware";

/**
 * The shape this middleware logs against. `console` satisfies it without
 * any wrapping. Pinos, bunyans, winstons all satisfy it after you map
 * their level methods to `log` / `error`.
 */
export interface LoggerLike {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export type LoggingEvent =
  | { phase: "started"; cmd: Command }
  | { phase: "succeeded"; cmd: Command; durationMs: number }
  | { phase: "failed"; cmd: Command; durationMs: number; error: Error };

export interface LoggingMiddlewareOptions {
  /** Logger to write to. Default: `console`. */
  readonly logger?: LoggerLike;
  /**
   * Prefix prepended to every line. Default: empty. Useful when you have
   * multiple buses and want to disambiguate logs by service.
   */
  readonly prefix?: string;
  /**
   * Structured-logging hook. When set, the middleware calls
   * `logger.log(message, fields)` (and `logger.error` for failures),
   * passing the fields object you return. Use this with pino / bunyan /
   * winston to emit JSON instead of a single concatenated string.
   *
   * If omitted, the middleware emits a human-readable single-string line
   * (the default behaviour suitable for `console`).
   */
  readonly logFields?: (event: LoggingEvent) => Record<string, unknown>;
}

/**
 * A minimal logging middleware for the command bus.
 *
 * Emits two or three lines per command:
 *   - `→ command <type> (id=<commandId> tenant=<tenantId>)`
 *   - on success: `✓ command <type> (<durationMs>ms)`
 *   - on failure: `✗ command <type> (<durationMs>ms) <ErrorName>: <message>` to logger.error
 *
 * Durations are measured with `performance.now()` so wall-clock jumps
 * (NTP step, suspend/resume) cannot produce negative values.
 *
 * Register it before any other middleware so the log line covers the
 * full pipeline:
 *
 * ```ts
 * bus.use(createLoggingMiddleware());
 * bus.use(createCommandBusObserver({ tracer, meter }));
 * ```
 *
 * For structured logging (pino, bunyan, winston), pass a `logger` that
 * adapts its methods to the `LoggerLike` shape AND a `logFields`
 * callback that returns the structured payload.
 */
export function createLoggingMiddleware<TTx extends Transaction = Transaction>(
  opts: LoggingMiddlewareOptions = {}
): CommandMiddleware<TTx> {
  const logger = opts.logger ?? console;
  const prefix = opts.prefix ?? "";
  const logFields = opts.logFields;

  return async (cmd, _ctx, next) => {
    const tenantPart = cmd.metadata.tenantId
      ? ` tenant=${cmd.metadata.tenantId}`
      : "";
    const startLine = `${prefix}→ command ${cmd.type} (id=${cmd.metadata.commandId}${tenantPart})`;
    if (logFields) {
      logger.log(startLine, logFields({ phase: "started", cmd }));
    } else {
      logger.log(startLine);
    }

    const startedAt = performance.now();
    try {
      const result = await next();
      const durationMs = Math.round(performance.now() - startedAt);
      const okLine = `${prefix}✓ command ${cmd.type} (${durationMs}ms)`;
      if (logFields) {
        logger.log(okLine, logFields({ phase: "succeeded", cmd, durationMs }));
      } else {
        logger.log(okLine);
      }
      return result;
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      const error = err instanceof Error ? err : new Error(String(err));
      const errLine = `${prefix}✗ command ${cmd.type} (${durationMs}ms) ${error.name}: ${error.message}`;
      if (logFields) {
        logger.error(
          errLine,
          logFields({ phase: "failed", cmd, durationMs, error })
        );
      } else {
        logger.error(errLine);
      }
      throw err;
    }
  };
}
