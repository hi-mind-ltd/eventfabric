import type { AnyEvent, EventEnvelope, Transaction, UnitOfWork, EventStore } from "../types";
import type { ProjectionCheckpointStore } from "./projection-checkpoint-store";
import type { CatchUpProjection } from "./catch-up-projection";
import type { CatchUpProjectorObserver, CatchUpHandlerInfo } from "./catch-up-observer";

export type CatchUpOptions = {
  batchSize?: number;
  includeDismissed?: boolean;
  maxBatches?: number;
  /** Optional observability hooks. See CatchUpProjectorObserver for details. */
  observer?: CatchUpProjectorObserver;
};

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Core orchestration logic for catch-up projections.
 * This class is database-agnostic and works with any implementation of the required interfaces.
 */
export class CatchUpProjector<E extends AnyEvent, TTx extends Transaction = Transaction> {
  constructor(
    private readonly uow: UnitOfWork<TTx>,
    private readonly eventStore: EventStore<E, TTx>,
    private readonly checkpoints: ProjectionCheckpointStore<TTx>
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
   * Catches up a single projection by processing events from its last checkpoint forward.
   */
  async catchUpProjection(projection: CatchUpProjection<E, TTx>, options: CatchUpOptions = {}): Promise<void> {
    const batchSize = options.batchSize ?? 500;
    const includeDismissed = options.includeDismissed ?? false;
    const maxBatches = options.maxBatches;
    const observer = options.observer;

    let batches = 0;
    while (true) {
      if (maxBatches !== undefined && batches >= maxBatches) return;
      batches++;

      try {
        const didWork = await this.uow.withTransaction(async (tx) => {
          const cp = await this.checkpoints.get(tx, projection.name);
          const envs = await this.eventStore.loadGlobal(tx, {
            fromGlobalPositionExclusive: cp.lastGlobalPosition,
            limit: batchSize,
            includeDismissed
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

          // Update checkpoint to the last processed position
          const lastPosition = envs[envs.length - 1]!.globalPosition;
          await this.checkpoints.set(tx, projection.name, lastPosition);
          this.fireHook(observer?.onCheckpointAdvanced, {
            projection: projection.name,
            fromPosition: cp.lastGlobalPosition,
            toPosition: lastPosition
          });
          return true;
        });

        if (!didWork) return;
      } catch (err) {
        this.fireHook(observer?.onProjectorError, {
          projection: projection.name,
          error: toError(err)
        });
        throw err;
      }
    }
  }

  /**
   * Catches up multiple projections sequentially.
   */
  async catchUpAll(projections: CatchUpProjection<E, TTx>[], options: CatchUpOptions = {}): Promise<void> {
    for (const p of projections) {
      await this.catchUpProjection(p, options);
    }
  }
}
