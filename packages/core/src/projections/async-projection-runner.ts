import type { AnyEvent, EventEnvelope, Transaction, EventStore } from "../types";
import type { OutboxStore, OutboxRow } from "../outbox/outbox-store";
import type { ProjectionCheckpointStore } from "./projection-checkpoint-store";
import type { AsyncProjection } from "./async-projection";
import type { AsyncRunnerObserver, AsyncHandlerInfo } from "./async-runner-observer";
import type { TenantScopedUnitOfWorkFactory } from "./catch-up-projector";
import { matchesTopic } from "./topic-filter";
import { computeBackoffMs, sleep, type BackoffOptions } from "../resilience/backoff";

export type AsyncRunnerOptions = {
  workerId: string;
  batchSize?: number;
  idleSleepMs?: number;
  claimTopic?: string | null;
  includeDismissed?: boolean;
  maxAttempts?: number;
  transactionMode?: "batch" | "perRow";
  backoff?: BackoffOptions;
  /** Optional observability hooks. See AsyncRunnerObserver for details. */
  observer?: AsyncRunnerObserver;
};

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Core orchestration logic for running asynchronous projections.
 *
 * Multi-tenancy: the runner holds a `TenantScopedUnitOfWorkFactory`. Outbox
 * claim/ack/dead-letter operations run in a "default"-scoped UoW — the
 * outbox is a cross-tenant queue keyed by `global_position`, so these ops
 * don't need tenant filtering. Handler invocations narrow the tx to the
 * event's tenant so `loadStream`/`append` inside the handler read/write the
 * correct tenant's data. Per-tenant checkpoints let one tenant's failing
 * handler advance independently of other tenants.
 */
export class AsyncProjectionRunner<E extends AnyEvent, TTx extends Transaction = Transaction> {
  private readonly uow: { withTransaction<T>(fn: (tx: TTx) => Promise<T>): Promise<T> };

  constructor(
    private readonly uowFactory: TenantScopedUnitOfWorkFactory<TTx>,
    private readonly eventStore: EventStore<E, TTx>,
    private readonly outbox: OutboxStore<TTx>,
    private readonly checkpoints: ProjectionCheckpointStore<TTx>,
    private readonly projections: AsyncProjection<E, TTx>[],
    private readonly opts: AsyncRunnerOptions
  ) {
    // Outbox claim/ack/dead-letter ops are cross-tenant (the outbox is a
    // single queue). Use the default-tenant UoW for the outer batch tx.
    this.uow = uowFactory.forTenant("default");
  }

  /** Fire a synchronous lifecycle hook. Never lets observer errors escape. */
  private fireHook<I>(hook: ((info: I) => void) | undefined, info: I): void {
    if (!hook) return;
    try {
      hook(info);
    } catch {
      // Observer errors must never affect runner behavior.
    }
  }

  /** Run `projection.handle(tx, env)` wrapped in the observer's tracing hook (if any) and fire handled/failed hooks. */
  private async runProjectionHandler(
    projection: AsyncProjection<E, TTx>,
    tx: TTx,
    env: EventEnvelope<E>,
    attempts: number
  ): Promise<void> {
    const observer = this.opts.observer;
    const info: AsyncHandlerInfo = {
      workerId: this.opts.workerId,
      projection: projection.name,
      eventType: env.payload.type,
      globalPosition: env.globalPosition,
      attempts
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

  async start(signal: AbortSignal): Promise<void> {
    const batchSize = this.opts.batchSize ?? 100;
    const idleSleepMs = this.opts.idleSleepMs ?? 500;
    const includeDismissed = this.opts.includeDismissed ?? false;
    const maxAttempts = this.opts.maxAttempts ?? 10;
    const txMode = this.opts.transactionMode ?? "batch";
    const backoff = this.opts.backoff ?? { minMs: 250, maxMs: 15000, factor: 2, jitter: 0.2 };
    const observer = this.opts.observer;

    let attempt = 0;

    while (!signal.aborted) {
      try {
        const claimed = await this.uow.withTransaction(async (tx) => {
          return this.outbox.claimBatch(tx, {
            batchSize,
            workerId: this.opts.workerId,
            topic: this.opts.claimTopic ?? null
          });
        });

        if (claimed.length === 0) {
          attempt = 0;
          await sleep(idleSleepMs, signal);
          continue;
        }

        this.fireHook(observer?.onBatchClaimed, {
          workerId: this.opts.workerId,
          count: claimed.length,
          topic: this.opts.claimTopic ?? null
        });

        if (txMode === "batch") {
          await this.processBatch(claimed, includeDismissed, maxAttempts);
        } else {
          for (const row of claimed) {
            if (signal.aborted) break;
            await this.processOne(row, includeDismissed, maxAttempts);
          }
        }

        attempt = 0;
      } catch (err) {
        this.fireHook(observer?.onRunnerError, {
          workerId: this.opts.workerId,
          error: toError(err)
        });
        attempt++;
        await sleep(computeBackoffMs(attempt, backoff), signal);
      }
    }
  }

  private async processBatch(claimed: OutboxRow[], includeDismissed: boolean, maxAttempts: number): Promise<void> {
    const observer = this.opts.observer;
    try {
      await this.uow.withTransaction(async (tx) => {
        // Dead letter messages that exceeded max attempts
        for (const row of claimed) {
          if (row.attempts > maxAttempts) {
            const reason = `Exceeded maxAttempts=${maxAttempts}`;
            await this.outbox.deadLetter(tx, row, reason);
            this.fireHook(observer?.onMessageDeadLettered, {
              workerId: this.opts.workerId,
              outboxId: row.id,
              reason,
              attempts: row.attempts
            });
          }
        }

        const remaining = claimed.filter(r => r.attempts <= maxAttempts);
        if (remaining.length === 0) return;

        // Load events for remaining messages
        const envs = await this.eventStore.loadByGlobalPositions(tx, remaining.map(r => r.globalPosition));
        const rowByPos = new Map<string, OutboxRow>();
        for (const r of remaining) rowByPos.set(r.globalPosition.toString(), r);

        // Process each event
        for (const env of envs) {
          const row = rowByPos.get(env.globalPosition.toString());
          if (!row) continue;

          if (env.dismissed && !includeDismissed) {
            await this.outbox.ack(tx, row.id);
            this.fireHook(observer?.onMessageAcked, {
              workerId: this.opts.workerId,
              outboxId: row.id
            });
            continue;
          }

          // Narrow tx to the event's tenant so the handler's loadStream /
          // append calls filter by the correct tenant. Same pg client
          // (same tx), just tenant metadata swapped for scope filtering.
          const scopedTx = this.uowFactory.narrow(tx, env.tenantId);

          for (const p of this.projections) {
            if (!matchesTopic(p.topicFilter, row.topic)) continue;

            // Checkpoints are per-tenant — use the envelope's tenantId, not
            // the outer tx's. The outer tx writes the checkpoint row even
            // though it's for a different tenant; that's fine because
            // projection_checkpoints is keyed by (projection_name, tenant_id)
            // and the writes don't conflict across tenants.
            const cp = await this.checkpoints.get(tx, p.name, env.tenantId);
            if (env.globalPosition <= cp.lastGlobalPosition) continue;

            await this.runProjectionHandler(p, scopedTx, env, row.attempts);
            await this.checkpoints.set(tx, p.name, env.tenantId, env.globalPosition);
          }

          await this.outbox.ack(tx, row.id);
          this.fireHook(observer?.onMessageAcked, {
            workerId: this.opts.workerId,
            outboxId: row.id
          });
        }
      });
    } catch (err: unknown) {
      // Main tx rolled back — release all claimed rows in a fresh tx so they
      // can be reclaimed on the next iteration. Without this, releaseWithError
      // would roll back with the rest of the tx and rows would stay locked
      // forever (claimBatch filters WHERE locked_at IS NULL), stranding the
      // whole batch with no retry and no DLQ path.
      const error = toError(err);
      const msg = error.stack || error.message;
      try {
        await this.uow.withTransaction(async (tx) => {
          for (const row of claimed) {
            await this.outbox.releaseWithError(tx, row.id, msg);
            this.fireHook(observer?.onMessageReleased, {
              workerId: this.opts.workerId,
              outboxId: row.id,
              error
            });
          }
        });
      } catch {
        // Best-effort. If release also fails, the runner backs off on the
        // outer loop and will retry the release on the next failure cycle.
      }
      throw err;
    }
  }

  private async processOne(row: OutboxRow, includeDismissed: boolean, maxAttempts: number): Promise<void> {
    const observer = this.opts.observer;
    try {
      await this.uow.withTransaction(async (tx) => {
        if (row.attempts > maxAttempts) {
          const reason = `Exceeded maxAttempts=${maxAttempts}`;
          await this.outbox.deadLetter(tx, row, reason);
          this.fireHook(observer?.onMessageDeadLettered, {
            workerId: this.opts.workerId,
            outboxId: row.id,
            reason,
            attempts: row.attempts
          });
          return;
        }

        const envs = await this.eventStore.loadByGlobalPositions(tx, [row.globalPosition]);
        const env = envs[0];
        if (!env) {
          const reason = `Event not found for globalPosition=${row.globalPosition.toString()}`;
          await this.outbox.deadLetter(tx, row, reason);
          this.fireHook(observer?.onMessageDeadLettered, {
            workerId: this.opts.workerId,
            outboxId: row.id,
            reason,
            attempts: row.attempts
          });
          return;
        }

        if (env.dismissed && !includeDismissed) {
          await this.outbox.ack(tx, row.id);
          this.fireHook(observer?.onMessageAcked, {
            workerId: this.opts.workerId,
            outboxId: row.id
          });
          return;
        }

        const scopedTx = this.uowFactory.narrow(tx, env.tenantId);

        for (const p of this.projections) {
          if (!matchesTopic(p.topicFilter, row.topic)) continue;

          const cp = await this.checkpoints.get(tx, p.name, env.tenantId);
          if (env.globalPosition <= cp.lastGlobalPosition) continue;

          await this.runProjectionHandler(p, scopedTx, env, row.attempts);
          await this.checkpoints.set(tx, p.name, env.tenantId, env.globalPosition);
        }

        await this.outbox.ack(tx, row.id);
        this.fireHook(observer?.onMessageAcked, {
          workerId: this.opts.workerId,
          outboxId: row.id
        });
      });
    } catch (err: unknown) {
      // Unlock the message in a separate transaction that always commits
      // This ensures the message can be retried even if processing fails
      const error = toError(err);
      const msg = error.stack || error.message;
      await this.uow.withTransaction(async (tx) => {
        await this.outbox.releaseWithError(tx, row.id, msg);
      });
      this.fireHook(observer?.onMessageReleased, {
        workerId: this.opts.workerId,
        outboxId: row.id,
        error
      });
      throw err;
    }
  }
}
