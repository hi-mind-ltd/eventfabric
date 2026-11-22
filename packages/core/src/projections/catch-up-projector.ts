import type { AnyEvent, EventEnvelope, Transaction, UnitOfWork, EventStore } from "../types";
import type { ProjectionCheckpointStore } from "./projection-checkpoint-store";
import type { CatchUpProjection } from "./catch-up-projection";
import type { CatchUpProjectorObserver, CatchUpHandlerInfo } from "./catch-up-observer";
import type { HighWaterMark } from "./high-water-mark";

export type CatchUpOptions = {
  batchSize?: number;
  includeDismissed?: boolean;
  maxBatches?: number;
  /**
   * How long to wait, at the start of a catch-up call, for transactions that
   * are in flight right now to finish, so the call can process everything
   * committed before it started. Only used when the projector has a
   * HighWaterMark. Default: 2000. Events not yet safe when the wait ends are
   * picked up by a later call.
   */
  highWaterMarkWaitMs?: number;
  /** Optional observability hooks. See CatchUpProjectorObserver for details. */
  observer?: CatchUpProjectorObserver;
};

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Factory producing tenant-scoped transactions.
 *
 * Two shapes, both needed:
 *
 *  - `forTenant(id)` returns a `UnitOfWork` that opens fresh transactions
 *    scoped to `id`. Used by the catch-up projector, which fans out by
 *    tenant: it knows which tenant each batch belongs to before the tx
 *    begins.
 *
 *  - `narrow(tx, id)` returns a view of an *open* transaction scoped to a
 *    different tenant. Used by the async outbox runner, which claims a
 *    batch of rows spanning multiple tenants in a single tx and needs to
 *    hand each event's handler a tx narrowed to that event's tenant.
 *
 * Backends that do not support multi-tenancy can ignore `tenantId` and
 * return the same UoW / same tx — the orchestrators still work correctly
 * because every tenant resolves to the same scope.
 */
export type TenantScopedUnitOfWorkFactory<TTx extends Transaction = Transaction> = {
  forTenant(tenantId: string): UnitOfWork<TTx>;
  narrow(tx: TTx, tenantId: string): TTx;
};

/**
 * Core orchestration logic for catch-up projections.
 *
 * Multi-tenancy contract:
 *   - Every round, per projection, the projector asks the event store which
 *     tenants have events past the lowest checkpoint for that projection.
 *   - For each active tenant it opens a tenant-scoped transaction, reads
 *     events filtered by that tenant, runs the handler, and advances the
 *     tenant's checkpoint. Tenants are iterated round-robin so one tenant's
 *     volume cannot starve another.
 *   - Per-tenant checkpoints mean a handler failure for tenant A stalls A
 *     only. Other tenants continue making progress.
 *
 * Single-tenant setups see exactly one tenant ("default") discovered every
 * round and behave identically to the pre-multi-tenant projector.
 */
export class CatchUpProjector<E extends AnyEvent, TTx extends Transaction = Transaction> {
  constructor(
    private readonly uowFactory: TenantScopedUnitOfWorkFactory<TTx>,
    private readonly eventStore: EventStore<E, TTx>,
    private readonly checkpoints: ProjectionCheckpointStore<TTx>,
    /**
     * Bounds every read so the checkpoint never moves past a position that
     * an in-flight transaction might still commit. Without it, events whose
     * transaction commits after a higher position was processed are skipped
     * for good. Optional only for backends that assign positions in commit
     * order (and for tests); the Postgres factory always supplies one.
     */
    private readonly highWaterMark?: HighWaterMark
  ) {}

  /** Fire a synchronous lifecycle hook. Never lets observer errors escape. */
  private fireHook<I>(hook: ((info: I) => void) | undefined, info: I): void {
    if (!hook) return;
    try {
      hook(info);
    } catch {
      // Observer errors must never affect projector behavior.
    }
  }

  /** Run `projection.handle(tx, env)` wrapped in the observer's tracing hook (if any) and fire handled/failed hooks. */
  private async runProjectionHandler(
    projection: CatchUpProjection<E, TTx>,
    observer: CatchUpProjectorObserver | undefined,
    tx: TTx,
    env: EventEnvelope<E>
  ): Promise<void> {
    const info: CatchUpHandlerInfo = {
      projection: projection.name,
      eventType: env.payload.type,
      globalPosition: env.globalPosition
    };
    const start = Date.now();
    try {
      if (observer?.runHandler) {
        await observer.runHandler(() => projection.handle(tx, env), info);
      } else {
        await projection.handle(tx, env);
      }
      this.fireHook(observer?.onEventHandled, { ...info, durationMs: Date.now() - start });
    } catch (err) {
      this.fireHook(observer?.onEventFailed, {
        ...info,
        durationMs: Date.now() - start,
        error: toError(err)
      });
      throw err;
    }
  }

  /**
   * Process one batch for a single (projection, tenant). Returns true if any
   * events were processed (checkpoint advanced), false if the tenant has no
   * pending events.
   *
   * A failure inside the handler rolls back this tenant's transaction and
   * re-throws. The outer loop catches it and moves on to the next tenant so
   * one tenant's failure doesn't block other tenants' progress.
   */
  private async processTenantBatch(
    projection: CatchUpProjection<E, TTx>,
    tenantId: string,
    batchSize: number,
    includeDismissed: boolean,
    observer: CatchUpProjectorObserver | undefined,
    upTo: bigint | undefined
  ): Promise<boolean> {
    const uow = this.uowFactory.forTenant(tenantId);
    return uow.withTransaction(async (tx) => {
      // Claim (lock) the checkpoint when the store supports it, so concurrent
      // projector instances never process the same batch. A null claim means
      // another instance is working on this tenant right now: skip it.
      const cp = this.checkpoints.claim
        ? await this.checkpoints.claim(tx, projection.name, tenantId)
        : await this.checkpoints.get(tx, projection.name, tenantId);
      if (!cp) return false;
      if (upTo !== undefined && cp.lastGlobalPosition >= upTo) return false;
      const envs = await this.eventStore.loadGlobal(tx, {
        fromGlobalPositionExclusive: cp.lastGlobalPosition,
        toGlobalPositionInclusive: upTo,
        limit: batchSize,
        includeDismissed,
        tenantId
      });

      if (envs.length === 0) return false;

      this.fireHook(observer?.onBatchLoaded, {
        projection: projection.name,
        count: envs.length,
        fromPosition: cp.lastGlobalPosition
      });

      for (const env of envs) {
        if (env.dismissed && !includeDismissed) continue;
        await this.runProjectionHandler(projection, observer, tx, env);
      }

      const lastPosition = envs[envs.length - 1]!.globalPosition;
      await this.checkpoints.set(tx, projection.name, tenantId, lastPosition);
      this.fireHook(observer?.onCheckpointAdvanced, {
        projection: projection.name,
        fromPosition: cp.lastGlobalPosition,
        toPosition: lastPosition
      });
      return true;
    });
  }

  /**
   * Discover tenants with pending work past the minimum checkpoint for this
   * projection, then round-robin through them. Done in its own transaction
   * so the discovery read is isolated from per-tenant processing txs.
   *
   * Note: we discover from the *lowest* checkpoint across tenants, not from
   * zero, to avoid revisiting already-processed global positions. A new
   * tenant that has events older than the lowest checkpoint will still be
   * picked up because its own checkpoint is 0.
   */
  private async discoverTenants(_projection: CatchUpProjection<E, TTx>, upTo: bigint | undefined): Promise<string[]> {
    // We need a tx to call discoverActiveTenants; use an arbitrary tenant
    // scope ("default") since discovery itself is cross-tenant.
    const uow = this.uowFactory.forTenant("default");
    return uow.withTransaction(async (tx) => {
      return this.eventStore.discoverActiveTenants(tx, {
        fromGlobalPositionExclusive: 0n,
        toGlobalPositionInclusive: upTo
      });
    });
  }

  /**
   * Catch one projection up to the head of the event log for every tenant
   * with pending work. Internally: for each tenant, pull batches until that
   * tenant is caught up, then move on.
   *
   * Per-tenant failures are caught and reported via the observer's
   * `onProjectorError` hook; they do NOT propagate out or halt processing
   * for other tenants.
   */
  async catchUpProjection(projection: CatchUpProjection<E, TTx>, options: CatchUpOptions = {}): Promise<void> {
    const batchSize = options.batchSize ?? 500;
    const includeDismissed = options.includeDismissed ?? false;
    const maxBatches = options.maxBatches;
    const observer = options.observer;

    // Fix the upper bound for the whole call: everything at or below it is
    // final, so the checkpoint can never jump over a late-committing event.
    // Anything above it is left for the next call.
    const upTo = this.highWaterMark
      ? await this.highWaterMark.safePosition({ waitMs: options.highWaterMarkWaitMs ?? 2000 })
      : undefined;
    if (upTo === 0n) return;

    const tenants = await this.discoverTenants(projection, upTo);
    if (tenants.length === 0) return;

    // Round-robin across tenants. One batch per tenant per pass; repeat
    // until all tenants have no pending events in a full pass.
    const pending = new Set(tenants);
    let passes = 0;
    while (pending.size > 0) {
      if (maxBatches !== undefined && passes >= maxBatches) return;
      passes++;

      const drained: string[] = [];
      for (const tenantId of pending) {
        try {
          const didWork = await this.processTenantBatch(
            projection,
            tenantId,
            batchSize,
            includeDismissed,
            observer,
            upTo
          );
          if (!didWork) drained.push(tenantId);
        } catch (err) {
          // Per-tenant failure: isolate. Report and drop this tenant from
          // this round so it doesn't block other tenants. Next catchUp call
          // will rediscover it and try again.
          this.fireHook(observer?.onProjectorError, {
            projection: projection.name,
            error: toError(err)
          });
          drained.push(tenantId);
        }
      }
      for (const t of drained) pending.delete(t);
    }
  }

  /** Catch up multiple projections sequentially. */
  async catchUpAll(projections: CatchUpProjection<E, TTx>[], options: CatchUpOptions = {}): Promise<void> {
    for (const p of projections) {
      await this.catchUpProjection(p, options);
    }
  }
}
