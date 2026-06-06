import type { AnyEvent, Transaction, UnitOfWork } from "@eventfabric/core";
import type { Saga } from "./saga";
import type { SagaTransitionStores } from "./saga-runner";
import { applySagaTransition } from "./saga-runner";
import type { SagaTimerStore } from "./saga-timer-store";
import type { SagaObserver } from "./saga-observer";

function safeEmit(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch {
    // swallow — observer is fire-and-forget
  }
}

/**
 * If `uow` is a `TenantScopedUnitOfWorkFactory` (exposes `forTenant`),
 * return the per-tenant view. Otherwise return the original UoW —
 * single-tenant deployments and non-tenant-aware test fixtures continue
 * to work unchanged.
 */
function uowForTenant<TTx extends Transaction>(
  uow: UnitOfWork<TTx>,
  tenantId: string
): UnitOfWork<TTx> {
  const candidate = uow as UnitOfWork<TTx> & {
    forTenant?(tenantId: string): UnitOfWork<TTx>;
  };
  if (typeof candidate.forTenant === "function") {
    return candidate.forTenant(tenantId);
  }
  return uow;
}

export interface SagaTimerHandler<TTx extends Transaction> {
  readonly saga: Saga<any, AnyEvent>;
  readonly stores: SagaTransitionStores<any, TTx>;
}

/**
 * Optional release method on the timer store — the postgres impl exposes
 * one to put a claimed row back to pending. In-memory tests can stub.
 */
interface ReleasableTimerStore<TTx extends Transaction>
  extends SagaTimerStore<TTx> {
  release?(
    tx: TTx,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
    }
  ): Promise<void>;
}

export interface SagaTimerSchedulerOptions {
  /** Max rows to claim per round. Default 32. */
  readonly batchSize?: number;
  /** Sleep between idle rounds. Default 1000ms. */
  readonly idleSleepMs?: number;
  /** Sleep between busy rounds. Default 0ms. */
  readonly busySleepMs?: number;
  /** Time-source override for tests. Default `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Observer for tracing + metrics. Hooks fire per delivered timer.
   * Errors thrown by the observer are swallowed so an instrumentation
   * bug cannot affect scheduler behavior.
   */
  readonly observer?: SagaObserver;
  /**
   * Behavior when the scheduler claims a timer for a saga name that has
   * no registered handler — usually a refactor that renamed/removed a
   * saga while pending timers still exist.
   *
   * - `"fail"` (default, safe): leave the row visible to ops by marking
   *   it `failed`. Operator decides whether to drop it or wire a handler.
   * - `"discard"`: silently `markFired` the row. **Only set this when
   *   you have explicitly accepted the data loss** — silent fire-and-
   *   forget on a code refactor has caused production incidents before.
   *
   * The previous default was "discard"; this is a breaking change to a
   * safer default.
   */
  readonly onOrphanedTimer?: "fail" | "discard";
  /**
   * Hard upper bound on graceful shutdown. After `stop()` is called, the
   * scheduler waits at most `gracefulShutdownMs` for the current batch
   * to complete before returning from `start()`. Default 25_000ms (under
   * a typical 30s SIGTERM-to-SIGKILL window). Set to `Infinity` to keep
   * the legacy "wait forever" behaviour.
   */
  readonly gracefulShutdownMs?: number;
}

export interface TimerSchedulerRoundResult {
  readonly claimed: number;
  readonly fired: number;
  readonly released: number;
  readonly orphaned: number;
}

/**
 * Polls due timer rows and delivers each one to its saga's `reactToTimer`
 * via `applySagaTransition`. State, commands, and the `markFired` for
 * the row commit in one transaction so a delivery is exactly-once with
 * its effects.
 *
 * If a saga is not registered (orphaned timer — the saga code was
 * removed but rows still exist), the row is marked fired anyway so it
 * doesn't loop forever. Operators see this in the count returned from
 * `runOnce()`.
 */
export class SagaTimerScheduler<TTx extends Transaction = Transaction> {
  private readonly batchSize: number;
  private readonly idleSleepMs: number;
  private readonly busySleepMs: number;
  private readonly nowFn: () => Date;
  private readonly observer?: SagaObserver;
  private readonly onOrphanedTimer: "fail" | "discard";
  private readonly gracefulShutdownMs: number;
  private running = false;
  private stopRequested = false;
  private inFlightRound?: Promise<TimerSchedulerRoundResult>;

  constructor(
    private readonly uow: UnitOfWork<TTx>,
    private readonly timerStore: ReleasableTimerStore<TTx>,
    private readonly handlers: Map<string, SagaTimerHandler<TTx>>,
    opts?: SagaTimerSchedulerOptions
  ) {
    this.batchSize = opts?.batchSize ?? 32;
    this.idleSleepMs = opts?.idleSleepMs ?? 1000;
    this.busySleepMs = opts?.busySleepMs ?? 0;
    this.nowFn = opts?.now ?? (() => new Date());
    this.observer = opts?.observer;
    this.onOrphanedTimer = opts?.onOrphanedTimer ?? "fail";
    this.gracefulShutdownMs = opts?.gracefulShutdownMs ?? 25_000;
  }

  async runOnce(): Promise<TimerSchedulerRoundResult> {
    // Initial claim is tenant-agnostic — `claimDue` selects across all
    // tenants by `fire_at` and operates on the row by PK. No narrowing
    // needed (and the un-narrowed uow's tenant is fine for the claim tx).
    const claimed = await this.uow.withTransaction((tx) =>
      this.timerStore.claimDue(tx, {
        now: this.nowFn(),
        batchSize: this.batchSize,
      })
    );

    if (claimed.length === 0) {
      return { claimed: 0, fired: 0, released: 0, orphaned: 0 };
    }

    let fired = 0;
    let released = 0;
    let orphaned = 0;

    for (const item of claimed) {
      // Narrow the UoW per item so the saga reaction + markFired commit
      // under a tx whose tenantId matches the row. If the UoW is not
      // tenant-aware, fall back to the configured UoW (single-tenant
      // case, or backend that ignores tenant context).
      const itemUow = uowForTenant(this.uow, item.tenantId);

      const handler = this.handlers.get(item.sagaName);
      if (!handler) {
        // Orphan: no saga registered for this timer's name. The default
        // policy is "fail" so the row stays visible to ops and ops can
        // decide whether to drop it or wire a handler. The legacy
        // behaviour ("discard" = silently markFired) is opt-in.
        if (
          this.onOrphanedTimer === "fail" &&
          this.timerStore.markFailed
        ) {
          const orphanError = new Error(
            `No handler registered for saga "${item.sagaName}" (orphaned timer)`
          );
          await itemUow.withTransaction((tx) =>
            this.timerStore.markFailed!(tx, {
              tenantId: item.tenantId,
              sagaName: item.sagaName,
              instanceId: item.instanceId,
              id: item.id,
              error: orphanError,
            })
          );
        } else {
          await itemUow.withTransaction((tx) =>
            this.timerStore.markFired(tx, {
              tenantId: item.tenantId,
              sagaName: item.sagaName,
              instanceId: item.instanceId,
              id: item.id,
            })
          );
        }
        safeEmit(() =>
          this.observer?.onTimerOrphaned?.({
            sagaName: item.sagaName,
            instanceId: item.instanceId,
            tenantId: item.tenantId,
            timerId: item.id,
          })
        );
        orphaned++;
        continue;
      }

      const startedAt = Date.now();
      const baseInfo = {
        sagaName: item.sagaName,
        instanceId: item.instanceId,
        tenantId: item.tenantId,
        timerId: item.id,
      };

      const result = await itemUow.withTransaction(async (tx) => {
        const outcome = await applySagaTransition(
          handler.saga,
          {
            kind: "timer",
            instanceId: item.instanceId,
            tenantId: item.tenantId,
            timer: item.message,
          },
          { tx, tenantId: item.tenantId },
          handler.stores,
          { now: this.nowFn, observer: this.observer }
        );

        if (outcome.result === "concurrent") {
          // The same Tx that loaded the stale state is the one we'd mark
          // fired in — abort by throwing so the Tx rolls back; the row
          // stays in 'claimed' and we release it in a separate Tx below.
          throw new ConcurrentSagaTransitionError();
        }

        // applied | skipped → mark fired in the same Tx so saga state and
        // timer status commit atomically.
        await this.timerStore.markFired(tx, {
          tenantId: item.tenantId,
          sagaName: item.sagaName,
          instanceId: item.instanceId,
          id: item.id,
        });
        return outcome.result;
      }).catch(async (err) => {
        if (err instanceof ConcurrentSagaTransitionError) {
          if (this.timerStore.release) {
            await itemUow.withTransaction((tx) =>
              this.timerStore.release!(tx, {
                tenantId: item.tenantId,
                sagaName: item.sagaName,
                instanceId: item.instanceId,
                id: item.id,
              })
            );
          }
          return "concurrent" as const;
        }
        throw err;
      });

      const durationMs = Date.now() - startedAt;
      if (result === "concurrent") {
        safeEmit(() =>
          this.observer?.onTimerReleased?.({
            ...baseInfo,
            durationMs,
            reason: "concurrent",
          })
        );
        released++;
      } else {
        safeEmit(() =>
          this.observer?.onTimerFired?.({ ...baseInfo, durationMs })
        );
        fired++;
      }
    }

    return { claimed: claimed.length, fired, released, orphaned };
  }

  async start(): Promise<void> {
    if (this.running) throw new Error("SagaTimerScheduler already running");
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
   * Request graceful shutdown. The current round finishes (subject to
   * `gracefulShutdownMs`); the loop exits without starting another.
   * Resolves when the loop has fully stopped, or when the shutdown
   * budget is exceeded (in which case the in-flight round may still be
   * running — but `start()` will have returned).
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
}

class ConcurrentSagaTransitionError extends Error {
  constructor() {
    super("Concurrent saga transition while applying timer");
    this.name = "ConcurrentSagaTransitionError";
  }
}
