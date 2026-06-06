import type { Transaction, UnitOfWork, ConcurrencyRetryOptions } from "@eventfabric/core";
import { withConcurrencyRetry } from "@eventfabric/core";
import type { Command } from "./command";
import type {
  CommandContext,
  CommandHandler,
  HandlerRegistrationOptions,
} from "./command-handler";
import type { IdempotencyStore } from "./idempotency-store";
import {
  composeMiddleware,
  createIdempotencyMiddleware,
  type CommandMiddleware,
  type IdempotencyMiddlewareOptions,
} from "./middleware";
import {
  ConcurrentCommandInFlightError,
  MissingTenantIdError,
  NoHandlerRegisteredError,
} from "./errors";

export interface CommandBusOptions<TTx extends Transaction> {
  readonly uow: UnitOfWork<TTx>;
  readonly idempotencyStore: IdempotencyStore<TTx>;
  /**
   * Idempotency middleware tuning. The middleware itself is always
   * installed; this controls its behaviour (wait vs reject, opt-outs).
   */
  readonly idempotencyOptions?: IdempotencyMiddlewareOptions;
  /**
   * Concurrency retry options used by the bus's outer retry loop. The whole
   * transaction (idempotency claim + handler + idempotency complete) is
   * retried as a unit on `ConcurrencyError` from the underlying store.
   */
  readonly retryOptions?: ConcurrencyRetryOptions;
  /**
   * Optional gate run before any middleware. Receives the command and
   * decides whether to allow it; throw to reject. Use this to enforce
   * that `cmd.metadata.tenantId` matches the authenticated caller —
   * **the bus itself trusts `metadata.tenantId` and routes accordingly**,
   * so without this gate a buggy or malicious caller can pivot tenants.
   *
   * The validator runs OUTSIDE the bus's transaction so a thrown error
   * never opens a connection.
   */
  readonly tenantValidator?: (cmd: Command) => void | Promise<void>;
  /**
   * When `true`, every command must carry `metadata.tenantId`. Commands
   * without one throw `MissingTenantIdError` synchronously before any
   * middleware runs. Default `false` for backwards compatibility with
   * single-tenant deployments. Set to `true` in multi-tenant SaaS to
   * surface forgotten-tenant bugs at compile-test time rather than
   * silently running under the UoW's default scope.
   */
  readonly requireTenantId?: boolean;
}

interface RegisteredHandler<TTx extends Transaction> {
  readonly handler: CommandHandler<Command, unknown, TTx>;
  readonly options: Required<HandlerRegistrationOptions>;
}

/**
 * In-process command bus. Routes commands to handlers, runs middleware,
 * enforces idempotency, and wraps each command in a transaction so that
 * the handler's effects and the idempotency record commit together.
 *
 * The bus is generic over the transaction type. Use it with `PgUnitOfWork`
 * + `PgIdempotencyStore` for production, or `InMemoryUnitOfWork` +
 * `InMemoryIdempotencyStore` for unit tests.
 */
export class CommandBus<TTx extends Transaction = Transaction> {
  private readonly handlers = new Map<string, RegisteredHandler<TTx>>();
  private readonly userMiddleware: CommandMiddleware<TTx>[] = [];
  private readonly idempotencyMiddleware: CommandMiddleware<TTx>;
  private readonly skipForCommandTypes: Set<string>;
  private readonly opts: CommandBusOptions<TTx>;

  constructor(opts: CommandBusOptions<TTx>) {
    this.opts = opts;
    this.skipForCommandTypes = new Set(
      opts.idempotencyOptions?.skipForCommandTypes ?? []
    );
    this.idempotencyMiddleware = createIdempotencyMiddleware(opts.idempotencyStore, {
      ...opts.idempotencyOptions,
      skipForCommandTypes: this.skipForCommandTypes,
    });
  }

  register<TCmd extends Command, TResult>(
    handler: CommandHandler<TCmd, TResult, TTx>,
    options: HandlerRegistrationOptions = {}
  ): void {
    if (this.handlers.has(handler.commandType)) {
      throw new Error(
        `Handler for command type "${handler.commandType}" is already registered`
      );
    }
    const resolved: Required<HandlerRegistrationOptions> = {
      idempotency: options.idempotency ?? "required",
    };
    this.handlers.set(handler.commandType, {
      handler: handler as unknown as CommandHandler<Command, unknown, TTx>,
      options: resolved,
    });

    if (resolved.idempotency === "off") {
      this.skipForCommandTypes.add(handler.commandType);
    }
  }

  /**
   * Adds a user-supplied middleware. Middlewares run outside the
   * idempotency middleware in registration order. Use this for tracing,
   * logging, auth, validation — anything that should observe every command.
   */
  use(middleware: CommandMiddleware<TTx>): void {
    this.userMiddleware.push(middleware);
  }

  async send<TResult = unknown>(cmd: Command): Promise<TResult> {
    const entry = this.handlers.get(cmd.type);
    if (!entry) throw new NoHandlerRegisteredError(cmd.type);

    // Tenant gates run BEFORE any transaction opens. requireTenantId is a
    // structural check; tenantValidator is the application-level hook
    // that confirms cmd.metadata.tenantId matches the authenticated caller.
    // The bus itself routes by metadata.tenantId — without these guards
    // anything in the metadata wins, which is a tenant-pivot risk.
    if (this.opts.requireTenantId && !cmd.metadata.tenantId) {
      throw new MissingTenantIdError(cmd.type);
    }
    if (this.opts.tenantValidator) {
      await this.opts.tenantValidator(cmd);
    }

    const middlewares: CommandMiddleware<TTx>[] = [
      ...this.userMiddleware,
      this.idempotencyMiddleware,
    ];

    const terminal = (c: Command, ctx: CommandContext<TTx>): Promise<unknown> =>
      entry.handler.handle(c, ctx);

    const chain = composeMiddleware(middlewares, terminal);

    // Auto-narrow the UoW per command tenant. If `cmd.metadata.tenantId`
    // is set and the configured UoW exposes `forTenant` (i.e. it is a
    // `TenantScopedUnitOfWorkFactory`, like `PgUnitOfWork`), switch to
    // the tenant-scoped UoW for this call. This is how the bus carries
    // multi-tenant context without forcing callers to repeat the tenant
    // on every send().
    //
    // If the UoW is not tenant-aware, the bus runs the command in the
    // UoW's default scope — the idempotency slot is still keyed by
    // (tenant_id, idempotency_key) in the store, so dedup remains
    // tenant-correct even when transactional isolation is not.
    const uow = resolveTenantScopedUow(this.opts.uow, cmd.metadata.tenantId);

    // In-flight retry loop. The middleware throws
    // `ConcurrentCommandInFlightError` synchronously when the slot is
    // held by another worker; we sleep OUTSIDE the transaction (so the
    // connection + any row locks are released) and retry. With
    // conflictStrategy="reject" the wait budget is 0 — first throw
    // propagates.
    const conflictStrategy =
      this.opts.idempotencyOptions?.conflictStrategy ?? "wait";
    const inFlightWaitMs = this.opts.idempotencyOptions?.inFlightWaitMs ?? 5_000;
    const pollIntervalMs = this.opts.idempotencyOptions?.pollIntervalMs ?? 50;
    const startedAt = Date.now();

    while (true) {
      try {
        const result = await withConcurrencyRetry(
          () =>
            uow.withTransaction((tx) =>
              chain(cmd, { tx, metadata: cmd.metadata })
            ),
          this.opts.retryOptions
        );
        return result as TResult;
      } catch (err) {
        if (!(err instanceof ConcurrentCommandInFlightError)) throw err;
        if (
          conflictStrategy === "reject" ||
          Date.now() - startedAt >= inFlightWaitMs
        ) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }
  }
}

function resolveTenantScopedUow<TTx extends Transaction>(
  uow: UnitOfWork<TTx>,
  tenantId: string | undefined
): UnitOfWork<TTx> {
  if (tenantId === undefined) return uow;
  if (hasForTenant<TTx>(uow)) return uow.forTenant(tenantId);
  return uow;
}

function hasForTenant<TTx extends Transaction>(
  uow: UnitOfWork<TTx>
): uow is UnitOfWork<TTx> & { forTenant(tenantId: string): UnitOfWork<TTx> } {
  return typeof (uow as { forTenant?: unknown }).forTenant === "function";
}
