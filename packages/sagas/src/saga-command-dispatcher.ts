import type { Transaction, UnitOfWork } from "@eventfabric/core";
import type { Command, CommandBus } from "@eventfabric/mediator";
import type { SagaCommandQueue, SagaCommandQueueItem } from "./saga-command-queue";
import type { SagaObserver } from "./saga-observer";

export interface SagaCommandDispatcherOptions {
  /** Max rows to claim per round. Default 32. */
  readonly batchSize?: number;
  /**
   * Number of attempts before a row is permanently marked as failed (no
   * further auto-retry). Default 5.
   */
  readonly maxAttempts?: number;
  /** Sleep between rounds when there's no work. Default 1000ms. */
  readonly idleSleepMs?: number;
  /** Sleep between rounds when a round did work. Default 0ms. */
  readonly busySleepMs?: number;
  /**
   * Observer for tracing + metrics. Hooks fire per dispatched row. Errors
   * thrown by the observer are swallowed so an instrumentation bug
   * cannot affect dispatch behavior.
   */
  readonly observer?: SagaObserver;
  /**
   * Delay (in ms) to apply before the next retry after a failed
   * dispatch. Receives the row's `attempts` count (1-indexed after the
   * just-claimed attempt). Default is exponential backoff capped at
   * 60s: `Math.min(60_000, 250 * 2 ** (attempts - 1))`. Return `0` to
   * disable the backoff (next claim is immediate). The dispatcher writes
   * `next_attempt_at = now + delay` on `releaseWithError`; the queue's
   * claim query skips rows held back.
   */
  readonly retryBackoffMs?: (attempts: number) => number;
  /**
   * Hard upper bound on graceful shutdown. After `stop()` is called, the
   * dispatcher waits at most `gracefulShutdownMs` for the current batch
   * to finish before returning from `start()`. Default 25_000ms (under
   * a typical 30s SIGTERM-to-SIGKILL window). Set to `Infinity` to keep
   * the legacy "wait forever" behaviour.
   */
  readonly gracefulShutdownMs?: number;
}

function safeEmit(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch {
    // swallow — observer is fire-and-forget
  }
}

/**
 * Optional escape hatch for the dispatcher's "permanently failed" path.
 * When present, `markFailed` is invoked instead of leaving the row in
 * `claimed` status; the postgres queue exposes this. In-memory tests can
 * implement it as a stub.
 */
export interface FailableSagaCommandQueue<TTx extends Transaction>
  extends SagaCommandQueue<TTx> {
  markFailed?(tx: TTx, params: { id: string; error: Error }): Promise<void>;
}

export interface DispatcherRoundResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly released: number;
}

/**
 * Drains the saga command queue by dispatching each claimed row through
 * the CommandBus. The bus's idempotency middleware dedups based on the
 * dispatcher's rewritten idempotency key (`saga:${name}:${id}:${rowId}`),
 * so a worker crash mid-dispatch never produces duplicate effects.
 *
 * Workflow per round:
 *   1. Claim a batch (own transaction, marks rows 'claimed').
 *   2. For each claimed row, send through the bus (its own transaction).
 *   3. On bus success: ack (DELETE) in a fresh transaction.
 *   4. On bus failure with attempts < maxAttempts: release back to pending.
 *   5. On bus failure with attempts >= maxAttempts: markFailed (or
 *      release if the queue does not support markFailed).
 */
export class SagaCommandDispatcher<TTx extends Transaction = Transaction> {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly idleSleepMs: number;
  private readonly busySleepMs: number;
  private readonly observer?: SagaObserver;
  private readonly retryBackoffMs: (attempts: number) => number;
  private readonly gracefulShutdownMs: number;
  private running = false;
  private stopRequested = false;
  private inFlightRound?: Promise<DispatcherRoundResult>;

  constructor(
    private readonly uow: UnitOfWork<TTx>,
    private readonly queue: FailableSagaCommandQueue<TTx>,
    private readonly bus: CommandBus<TTx>,
    opts?: SagaCommandDispatcherOptions
  ) {
    this.batchSize = opts?.batchSize ?? 32;
    this.maxAttempts = opts?.maxAttempts ?? 5;
    this.idleSleepMs = opts?.idleSleepMs ?? 1000;
    this.busySleepMs = opts?.busySleepMs ?? 0;
    this.observer = opts?.observer;
    this.retryBackoffMs =
      opts?.retryBackoffMs ??
      ((attempts) => Math.min(60_000, 250 * 2 ** Math.max(0, attempts - 1)));
    this.gracefulShutdownMs = opts?.gracefulShutdownMs ?? 25_000;
  }

  /**
   * Run a single round: claim → dispatch → ack/release. Returns counts
   * suitable for monitoring.
   */
  async runOnce(): Promise<DispatcherRoundResult> {
    const claimed = await this.uow.withTransaction((tx) =>
      this.queue.claimBatch(tx, { batchSize: this.batchSize })
    );

    if (claimed.length === 0) {
      return { claimed: 0, dispatched: 0, failed: 0, released: 0 };
    }

    let dispatched = 0;
    let failed = 0;
    let released = 0;

    for (const row of claimed) {
      const startedAt = Date.now();
      const baseInfo = {
        sagaName: row.sagaName,
        instanceId: row.instanceId,
        tenantId: row.tenantId,
        rowId: row.id,
        commandType: row.command.type,
        attempts: row.attempts,
      };
      try {
        const send = () => this.bus.send(this.rewriteCommand(row));
        if (this.observer?.runDispatch) {
          await this.observer.runDispatch(send, baseInfo);
        } else {
          await send();
        }
        await this.uow.withTransaction((tx) =>
          this.queue.ack(tx, { id: row.id })
        );
        const durationMs = Date.now() - startedAt;
        safeEmit(() =>
          this.observer?.onCommandDispatched?.({ ...baseInfo, durationMs })
        );
        dispatched++;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const durationMs = Date.now() - startedAt;
        if (row.attempts >= this.maxAttempts) {
          await this.uow.withTransaction((tx) =>
            this.queue.markFailed
              ? this.queue.markFailed(tx, { id: row.id, error })
              : this.queue.releaseWithError(tx, { id: row.id, error })
          );
          safeEmit(() =>
            this.observer?.onCommandFailed?.({ ...baseInfo, durationMs, error })
          );
          failed++;
        } else {
          const backoffMs = this.retryBackoffMs(row.attempts);
          const delayUntil =
            backoffMs > 0 ? new Date(Date.now() + backoffMs) : undefined;
          await this.uow.withTransaction((tx) =>
            this.queue.releaseWithError(tx, { id: row.id, error, delayUntil })
          );
          safeEmit(() =>
            this.observer?.onCommandReleased?.({ ...baseInfo, durationMs, error })
          );
          released++;
        }
      }
    }

    return { claimed: claimed.length, dispatched, failed, released };
  }

  /**
   * Run forever (until `stop()` is called). Sleeps between rounds.
   */
  async start(): Promise<void> {
    if (this.running) throw new Error("SagaCommandDispatcher already running");
    this.running = true;
    this.stopRequested = false;

    try {
      while (!this.stopRequested) {
        this.inFlightRound = this.runOnce();
        const round = await this.inFlightRound;
        this.inFlightRound = undefined;
        const sleepMs = round.claimed > 0 ? this.busySleepMs : this.idleSleepMs;
        if (sleepMs > 0 && !this.stopRequested) {
          await new Promise((r) => setTimeout(r, sleepMs));
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Request graceful shutdown. The current batch finishes (subject to
   * `gracefulShutdownMs`); the loop exits without starting another.
   * Resolves once the loop has stopped — or after the shutdown budget,
   * whichever is first.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (!this.inFlightRound) return;
    if (!isFinite(this.gracefulShutdownMs)) {
      await this.inFlightRound.catch(() => undefined);
      return;
    }
    await Promise.race([
      this.inFlightRound.catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, this.gracefulShutdownMs)),
    ]);
  }

  /**
   * Rewrites the command's idempotency key so the bus dedups on the
   * dispatcher's row id. The original key (saga-author supplied) is
   * irrelevant for dispatch — the row id is what makes "this dispatch"
   * exactly-once.
   *
   * **Always overrides `metadata.tenantId` with the row's tenant.** Saga
   * authors cannot emit cross-tenant commands; a saga running in tenant
   * `acme` cannot escape and execute under `contoso` by setting metadata.
   * The bus uses `metadata.tenantId` to auto-narrow its UoW per command,
   * so this row-sourced value makes the dispatch transaction land in the
   * correct tenant. If the author did set a (possibly mismatching) value
   * we silently replace it — the row is the source of truth.
   *
   * Causation: stamps `causationId` from `row.causationEventId` so the
   * resulting events trace back to the event that triggered the saga
   * reaction. Author-supplied causationId wins (the saga may chain it
   * from an even earlier cause).
   */
  private rewriteCommand(row: SagaCommandQueueItem): Command {
    const dispatchKey = `saga:${row.sagaName}:${row.instanceId}:${row.id}`;
    return {
      ...row.command,
      metadata: {
        ...row.command.metadata,
        idempotencyKey: dispatchKey,
        // Saga is the cause of this command; its instanceId is the
        // correlation. Preserve any existing correlationId on the command,
        // since the saga itself may have sourced it from an upstream event.
        correlationId: row.command.metadata.correlationId ?? row.instanceId,
        // Propagate causation: when the saga emitted this command in
        // reaction to an event, that event's eventId is the cause of the
        // resulting commands. Author-supplied causationId wins.
        causationId:
          row.command.metadata.causationId ?? row.causationEventId ?? undefined,
        // Row's tenant ALWAYS wins. Author cannot pivot tenants.
        tenantId: row.tenantId,
      },
    };
  }
}
