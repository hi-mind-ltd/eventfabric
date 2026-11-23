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
  /**
   * How long a claimed outbox row stays locked before another worker may
   * reclaim it, in milliseconds. Recovers rows held by a worker that crashed
   * (or lost its connection) after claiming. Must comfortably exceed the
   * worst-case time to process one claimed batch, otherwise a slow-but-alive
   * worker's rows can be reclaimed and processed twice. Default: 300000 (5 min).
   */
  leaseMs?: number;
  /** Optional observability hooks. See AsyncRunnerObserver for details. */
  observer?: AsyncRunnerObserver;
};

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

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
 * correct tenant's data.
 *
 * Delivery tracking: the outbox row is the only record of whether an event
 * still has to be delivered. A row is acked in the same transaction as the
 * handlers that processed it, so a committed handler run and a deleted row
 * always go together. The runner deliberately does NOT consult projection
 * checkpoints: global positions are allocated at INSERT, not at COMMIT, so a
 * "position <= checkpoint means already handled" rule would silently drop
 * events that commit late, rows requeued from the DLQ, and rows processed
 * out of order by concurrent workers.
 */
export class AsyncProjectionRunner<E extends AnyEvent, TTx extends Transaction = Transaction> {
  private readonly uow: { withTransaction<T>(fn: (tx: TTx) => Promise<T>): Promise<T> };

  constructor(
    private readonly uowFactory: TenantScopedUnitOfWorkFactory<TTx>,
    private readonly eventStore: EventStore<E, TTx>,
    private readonly outbox: OutboxStore<TTx>,
    /**
     * @deprecated Ignored. The async runner no longer reads or writes
     * projection checkpoints; the outbox row alone tracks delivery. Kept
     * so existing call sites compile; will be removed in a future release.
     */
    _checkpoints: ProjectionCheckpointStore<TTx> | undefined,
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
    const leaseMs = this.opts.leaseMs ?? DEFAULT_LEASE_MS;
    const observer = this.opts.observer;

    let attempt = 0;

    while (!signal.aborted) {
      try {
        const claimed = await this.uow.withTransaction(async (tx) => {
          return this.outbox.claimBatch(tx, {
            batchSize,
            workerId: this.opts.workerId,
            topic: this.opts.claimTopic ?? null,
            leaseMs
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
          // Count rows whose processing was started; processOne acks,
          // dead-letters or releases those itself. Anything after that point
          // (abort, or a failure that ends the loop) must be handed back, or
          // it stays locked until the lease expires.
          let started = 0;
          try {
            for (const row of claimed) {
              if (signal.aborted) break;
              started++;
              await this.processOne(row, includeDismissed, maxAttempts);
            }
          } finally {
            await this.releaseUnattempted(claimed.slice(started));
          }
        }

        attempt = 0;
      } catch (err) {
        this.fireHook(observer?.onRunnerError, {
          workerId: this.opts.workerId,
          error: toError(err)
        });
        attempt++;
        await sleep(computeBackoffMs(attempt - 1, backoff), signal); // first retry waits minMs
      }
    }
  }

  /**
   * Hand back claimed rows that were never attempted. Best-effort: if this
   * fails too, the rows are recovered once their lease expires.
   */
  private async releaseUnattempted(rows: OutboxRow[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.uow.withTransaction((tx) => this.outbox.release(tx, rows.map(r => r.id), this.opts.workerId));
    } catch {
      // Swallow: must not mask the error that ended the batch.
    }
  }

  private async processBatch(claimed: OutboxRow[], includeDismissed: boolean, maxAttempts: number): Promise<void> {
    const observer = this.opts.observer;
    // The row being worked on when the batch tx fails. Only that row is
    // charged an attempt; the others are handed back uncharged, so one
    // failing row cannot push healthy rows claimed with it to maxAttempts.
    let current: OutboxRow | undefined;
    try {
      await this.uow.withTransaction(async (tx) => {
        // Dead letter messages that exceeded max attempts
        for (const row of claimed) {
          if (row.attempts > maxAttempts) {
            current = row;
            const reason = `Exceeded maxAttempts=${maxAttempts}`;
            await this.outbox.deadLetter(tx, row, reason, this.opts.workerId);
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

        // Rows whose event no longer exists can never succeed. Dead-letter
        // them (as perRow mode does) instead of leaving them locked.
        const loaded = new Set(envs.map(e => e.globalPosition.toString()));
        for (const row of remaining) {
          if (loaded.has(row.globalPosition.toString())) continue;
          current = row;
          const reason = `Event not found for globalPosition=${row.globalPosition.toString()}`;
          await this.outbox.deadLetter(tx, row, reason, this.opts.workerId);
          this.fireHook(observer?.onMessageDeadLettered, {
            workerId: this.opts.workerId,
            outboxId: row.id,
            reason,
            attempts: row.attempts
          });
        }

        // Process each event
        for (const env of envs) {
          const row = rowByPos.get(env.globalPosition.toString());
          if (!row) continue;
          current = row;

          if (env.dismissed && !includeDismissed) {
            await this.outbox.ack(tx, row.id, this.opts.workerId);
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
            await this.runProjectionHandler(p, scopedTx, env, row.attempts);
          }

          await this.outbox.ack(tx, row.id, this.opts.workerId);
          this.fireHook(observer?.onMessageAcked, {
            workerId: this.opts.workerId,
            outboxId: row.id
          });
        }
        current = undefined;
      });
    } catch (err: unknown) {
      // Main tx rolled back — release all claimed rows in a fresh tx so they
      // can be reclaimed on the next iteration. Without this, releaseWithError
      // would roll back with the rest of the tx and rows would stay locked
      // until their lease expires.
      const error = toError(err);
      const msg = error.stack || error.message;
      try {
        await this.uow.withTransaction(async (tx) => {
          // A failure tied to one row charges that row only. A failure not
          // tied to a row (e.g. loading the events) charges them all.
          const charged = current ? [current] : claimed;
          const uncharged = current ? claimed.filter(r => r !== current) : [];
          for (const row of charged) {
            await this.outbox.releaseWithError(tx, row.id, msg, this.opts.workerId);
            this.fireHook(observer?.onMessageReleased, {
              workerId: this.opts.workerId,
              outboxId: row.id,
              error
            });
          }
          await this.outbox.release(tx, uncharged.map(r => r.id), this.opts.workerId);
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
          await this.outbox.deadLetter(tx, row, reason, this.opts.workerId);
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
          await this.outbox.deadLetter(tx, row, reason, this.opts.workerId);
          this.fireHook(observer?.onMessageDeadLettered, {
            workerId: this.opts.workerId,
            outboxId: row.id,
            reason,
            attempts: row.attempts
          });
          return;
        }

        if (env.dismissed && !includeDismissed) {
          await this.outbox.ack(tx, row.id, this.opts.workerId);
          this.fireHook(observer?.onMessageAcked, {
            workerId: this.opts.workerId,
            outboxId: row.id
          });
          return;
        }

        const scopedTx = this.uowFactory.narrow(tx, env.tenantId);

        for (const p of this.projections) {
          if (!matchesTopic(p.topicFilter, row.topic)) continue;
          await this.runProjectionHandler(p, scopedTx, env, row.attempts);
        }

        await this.outbox.ack(tx, row.id, this.opts.workerId);
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
        await this.outbox.releaseWithError(tx, row.id, msg, this.opts.workerId);
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
