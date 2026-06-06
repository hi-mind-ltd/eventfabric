import type { Transaction } from "@eventfabric/core";
import type { Command } from "./command";
import type { CommandContext } from "./command-handler";
import type { IdempotencyStore } from "./idempotency-store";
import { ConcurrentCommandInFlightError } from "./errors";

/**
 * A middleware wraps the rest of the chain. Each middleware decides whether
 * to call `next()` (continuing the chain) or short-circuit with its own
 * value. The same shape as Koa/Express middleware.
 */
export type CommandMiddleware<TTx extends Transaction = Transaction> = (
  cmd: Command,
  ctx: CommandContext<TTx>,
  next: () => Promise<unknown>
) => Promise<unknown>;

/**
 * Composes a list of middlewares around a terminal step. The terminal is the
 * handler invocation; each middleware in the list runs outermost-first.
 */
export function composeMiddleware<TTx extends Transaction>(
  middlewares: readonly CommandMiddleware<TTx>[],
  terminal: (cmd: Command, ctx: CommandContext<TTx>) => Promise<unknown>
): (cmd: Command, ctx: CommandContext<TTx>) => Promise<unknown> {
  return (cmd, ctx) => {
    let i = -1;
    const dispatch = async (idx: number): Promise<unknown> => {
      if (idx <= i) throw new Error("next() called multiple times in middleware");
      i = idx;
      const fn = middlewares[idx];
      if (!fn) return terminal(cmd, ctx);
      return fn(cmd, ctx, () => dispatch(idx + 1));
    };
    return dispatch(0);
  };
}

export interface IdempotencyMiddlewareOptions {
  /**
   * Strategy when the slot is held by another in-flight worker.
   *
   * - "wait" (default): throw `ConcurrentCommandInFlightError`; the bus
   *   catches this, sleeps **outside** the transaction so connection +
   *   row locks are released, and retries up to `inFlightWaitMs`. This
   *   is the user-friendly behaviour for load-balancer duplicates and
   *   double-clicks.
   * - "reject": throw `ConcurrentCommandInFlightError` immediately;
   *   the bus does not retry.
   */
  readonly conflictStrategy?: "wait" | "reject";
  /** Total wait budget when conflictStrategy is "wait". Default 5000ms. */
  readonly inFlightWaitMs?: number;
  /** Poll interval between bus-level retries while waiting. Default 50ms. */
  readonly pollIntervalMs?: number;
  /**
   * Set of command types that opt out of idempotency entirely. The middleware
   * passes them through to the handler without consulting the store.
   */
  readonly skipForCommandTypes?: ReadonlySet<string>;
}

/**
 * Idempotency middleware. Claims the slot for the command's idempotencyKey
 * inside the bus's open transaction, runs the handler, then either marks
 * the slot completed (handler returned) or releases it (handler threw).
 *
 * If the slot already shows `completed`, the stored result is returned and
 * the handler is not invoked — this is the exactly-once-effect property.
 * If the slot is `in_flight` from a concurrent worker, the strategy in
 * options decides whether to wait or reject.
 */
export function createIdempotencyMiddleware<TTx extends Transaction>(
  store: IdempotencyStore<TTx>,
  options: IdempotencyMiddlewareOptions = {}
): CommandMiddleware<TTx> {
  const skipForCommandTypes = options.skipForCommandTypes ?? new Set<string>();

  return async (cmd, ctx, next) => {
    if (skipForCommandTypes.has(cmd.type)) {
      return next();
    }

    const claimParams = {
      key: cmd.metadata.idempotencyKey,
      commandType: cmd.type,
      commandId: cmd.metadata.commandId,
      tenantId: cmd.metadata.tenantId,
    };

    // Single claim attempt per middleware call. If the slot is held by
    // another worker, throw — the bus catches and decides whether to
    // sleep OUTSIDE this transaction and retry. This avoids holding a
    // DB connection (and conflicting row locks) while polling.
    const claim = await store.claim(ctx.tx, claimParams);

    if (claim.state === "in_flight") {
      throw new ConcurrentCommandInFlightError(cmd.metadata.idempotencyKey);
    }

    if (claim.state === "completed") {
      return claim.result;
    }

    try {
      const result = await next();
      await store.complete(ctx.tx, {
        key: cmd.metadata.idempotencyKey,
        tenantId: cmd.metadata.tenantId,
        result,
      });
      return result;
    } catch (err) {
      await store.release(ctx.tx, {
        key: cmd.metadata.idempotencyKey,
        tenantId: cmd.metadata.tenantId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      throw err;
    }
  };
}
