import type { AnyEvent, EventEnvelope, Transaction, EventStore } from "../types";
import type { ProjectionCheckpointStore } from "./projection-checkpoint-store";
import type { CatchUpProjection, ProjectionHandleContext } from "./catch-up-projection";
import type { CatchUpProjectorObserver, CatchUpHandlerInfo } from "./catch-up-observer";
import type { TenantScopedUnitOfWorkFactory } from "./catch-up-projector";
import type { HighWaterMark } from "./high-water-mark";
import type {
  ProjectionDeadLetter,
  ProjectionDeadLetterStore,
  ListProjectionDeadLettersOptions
} from "./projection-dead-letter-store";
import { computeBackoffMs, sleep, type BackoffOptions } from "../resilience/backoff";

export type ProjectionDaemonOptions = {
  /** Events read per (projection, tenant) transaction. Default: 500. */
  batchSize?: number;
  /** Sleep between rounds when there was nothing to do. Default: 500 ms. */
  idleSleepMs?: number;
  /** Pass dismissed events to handlers. Default: false (they are skipped, and the checkpoint moves past them). */
  includeDismissed?: boolean;
  /**
   * Handler attempts per event before it is dead-lettered and the checkpoint
   * moves past it. Default: 10.
   */
  maxAttempts?: number;
  /** Delay before retrying a failed event. Default: { minMs: 250, maxMs: 30000, factor: 2, jitter: 0.2 }. */
  backoff?: BackoffOptions;
  /** Observability hooks (same shape as the catch-up projector's, plus onEventDeadLettered). */
  observer?: CatchUpProjectorObserver;
};

/** What happened when one (projection, tenant) batch was attempted. */
type BatchResult =
  | "progress" // events handled and the checkpoint moved
  | "caughtUp" // nothing left up to the high water mark
  | "busy" // another instance holds this checkpoint right now
  | "waiting" // backing off after a failure
  | "failed"; // a handler threw; a retry is scheduled

type FailureState = { position: bigint; attempts: number; lastError: string; retryAt: number };

class HandlerFailure extends Error {
  constructor(readonly env: EventEnvelope<AnyEvent>, readonly cause: Error) {
    super(cause.message);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Resolve after `ms`, or early (without throwing) when `signal` aborts. */
async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, signal);
  } catch {
    // aborted
  }
}

const SEP = "\u0000";
const pairKey = (projection: string, tenantId: string) => `${projection}${SEP}${tenantId}`;
const splitKey = (key: string): [string, string] => {
  const i = key.indexOf(SEP);
  return [key.slice(0, i), key.slice(i + 1)];
};

/**
 * Runs projections continuously against the event log: the equivalent of
 * Marten's async daemon.
 *
 * - **Progress** is a checkpoint per (projection, tenant), so projections
 *   can be added later (they back-fill from the start of the log) and
 *   rebuilt (`rebuild`).
 * - **Late commits**: every read stops at the high water mark, so the
 *   checkpoint never moves past an event whose transaction is still in
 *   flight.
 * - **Several instances** (processes, nodes) can run the same projections:
 *   each batch claims its checkpoint (`ProjectionCheckpointStore.claim`), so
 *   every event is handled by one instance only.
 * - **Failures**: a failing event is retried with backoff. The events before
 *   it in the same batch are committed first, so one bad event only holds
 *   back what comes after it. After `maxAttempts` the event is recorded in
 *   the dead-letter store and the checkpoint moves past it.
 *   `replayDeadLetter` runs it again later.
 *
 * Delivery is at least once (a handler can run again if its transaction
 * fails to commit), so handlers must be idempotent.
 */
export class ProjectionDaemon<E extends AnyEvent, TTx extends Transaction = Transaction> {
  private readonly projections = new Map<string, CatchUpProjection<E, TTx>>();
  private readonly batchSize: number;
  private readonly idleSleepMs: number;
  private readonly includeDismissed: boolean;
  private readonly maxAttempts: number;
  private readonly backoff: BackoffOptions;
  private readonly observer: CatchUpProjectorObserver | undefined;

  /** Highest position up to which tenant discovery has run. */
  private discoveredUpTo = 0n;
  /** (projection, tenant) pairs that may have work. */
  private readonly pending = new Set<string>();
  private readonly failures = new Map<string, FailureState>();

  constructor(
    private readonly uowFactory: TenantScopedUnitOfWorkFactory<TTx>,
    private readonly eventStore: EventStore<E, TTx>,
    private readonly checkpoints: ProjectionCheckpointStore<TTx>,
    private readonly highWaterMark: HighWaterMark,
    private readonly deadLetters: ProjectionDeadLetterStore<TTx>,
    projections: CatchUpProjection<E, TTx>[],
    opts: ProjectionDaemonOptions = {}
  ) {
    for (const p of projections) {
      if (this.projections.has(p.name)) throw new Error(`Duplicate projection name: ${p.name}`);
      this.projections.set(p.name, p);
    }
    this.batchSize = opts.batchSize ?? 500;
    this.idleSleepMs = opts.idleSleepMs ?? 500;
    this.includeDismissed = opts.includeDismissed ?? false;
    this.maxAttempts = opts.maxAttempts ?? 10;
    this.backoff = opts.backoff ?? { minMs: 250, maxMs: 30_000, factor: 2, jitter: 0.2 };
    this.observer = opts.observer;
  }

  /** Run until `signal` aborts. Resolves (does not reject) on abort. */
  async start(signal: AbortSignal): Promise<void> {
    let consecutiveErrors = 0;
    while (!signal.aborted) {
      let didWork = false;
      try {
        didWork = await this.runOnce(signal);
        consecutiveErrors = 0;
      } catch (err) {
        // Infrastructure failure (e.g. database unavailable): back off.
        this.fireHook(this.observer?.onProjectorError, { projection: "*", error: toError(err) });
        consecutiveErrors++;
        await pause(computeBackoffMs(consecutiveErrors - 1, this.backoff), signal); // first retry waits minMs
        continue;
      }
      if (!didWork) await pause(this.idleSleepMs, signal);
    }
  }

  /**
   * One round: read the high water mark, pick up tenants with new events,
   * then process every (projection, tenant) pair with pending work until it
   * is caught up, busy, or failing. Returns true if any batch made progress.
   */
  async runOnce(signal?: AbortSignal): Promise<boolean> {
    const hwm = await this.highWaterMark.safePosition({ waitMs: 0 });
    await this.discover(hwm);
    return this.drain([...this.pending], hwm, signal);
  }

  /**
   * Rebuild one projection from the start of the event log: for every
   * tenant, call `projection.reset(tx)` (if defined), move the checkpoint
   * back to 0 and drop the projection's dead letters, in one transaction
   * per tenant. Then process up to the current high water mark.
   *
   * Other instances running the same projection keep working; they see the
   * reset checkpoint on their next batch. A failing event during the replay
   * is retried and dead-lettered as usual, and `start` (here or elsewhere)
   * finishes whatever is left.
   */
  async rebuild(projectionName: string, opts: { highWaterMarkWaitMs?: number } = {}): Promise<void> {
    const projection = this.requireProjection(projectionName);
    if (!this.checkpoints.reset) {
      throw new Error("The checkpoint store does not support reset(); rebuild is unavailable");
    }
    const hwm = await this.highWaterMark.safePosition({ waitMs: opts.highWaterMarkWaitMs ?? 2000 });
    const tenants = await this.uowFactory.forTenant("default").withTransaction((tx) =>
      this.eventStore.discoverActiveTenants(tx, { fromGlobalPositionExclusive: 0n })
    );

    const keys: string[] = [];
    for (const tenantId of tenants) {
      await this.resetTenant(projection, tenantId);
      const key = pairKey(projectionName, tenantId);
      this.failures.delete(key);
      this.pending.add(key);
      keys.push(key);
    }
    await this.drain(keys, hwm);
  }

  /**
   * Run a dead-lettered event through its projection again, then delete the
   * dead letter. Runs out of order (the checkpoint has already moved past
   * the event). If the handler throws, the dead letter is kept and the error
   * is rethrown.
   */
  async replayDeadLetter(id: ProjectionDeadLetter["id"]): Promise<{ replayed: boolean; reason?: string }> {
    const item = await this.uowFactory.forTenant("default").withTransaction((tx) => this.deadLetters.get(tx, id));
    if (!item) return { replayed: false, reason: "Dead letter not found" };
    const projection = this.projections.get(item.projectionName);
    if (!projection) return { replayed: false, reason: `Projection not registered: ${item.projectionName}` };

    return this.uowFactory.forTenant(item.tenantId).withTransaction(async (tx) => {
      const [env] = await this.eventStore.loadByGlobalPositions(tx, [item.globalPosition]);
      if (!env) return { replayed: false, reason: `Event not found for globalPosition=${item.globalPosition}` };
      await this.runHandler(projection, tx, env, { replay: true });
      await this.deadLetters.delete(tx, id);
      return { replayed: true };
    });
  }

  /** List dead letters (oldest first). */
  async listDeadLetters(opts?: ListProjectionDeadLettersOptions): Promise<ProjectionDeadLetter[]> {
    return this.uowFactory.forTenant("default").withTransaction((tx) => this.deadLetters.list(tx, opts));
  }

  // ---------------------------------------------------------------------------

  private requireProjection(name: string): CatchUpProjection<E, TTx> {
    const p = this.projections.get(name);
    if (!p) throw new Error(`Projection not registered: ${name}`);
    return p;
  }

  /** Find tenants with events in (discoveredUpTo, hwm] and mark their pairs pending. */
  private async discover(hwm: bigint): Promise<void> {
    if (hwm <= this.discoveredUpTo) return;
    const from = this.discoveredUpTo;
    const tenants = await this.uowFactory.forTenant("default").withTransaction((tx) =>
      this.eventStore.discoverActiveTenants(tx, { fromGlobalPositionExclusive: from, toGlobalPositionInclusive: hwm })
    );
    for (const tenantId of tenants) {
      for (const name of this.projections.keys()) this.pending.add(pairKey(name, tenantId));
    }
    this.discoveredUpTo = hwm;
  }

  /**
   * Round-robin over `keys`, one batch per pair per pass, until every pair is
   * caught up or cannot progress this round. Infrastructure errors on one
   * pair are reported and that pair is retried next round.
   */
  private async drain(keys: string[], hwm: bigint, signal?: AbortSignal): Promise<boolean> {
    let didWork = false;
    let working = keys;
    while (working.length > 0 && !signal?.aborted) {
      const next: string[] = [];
      for (const key of working) {
        if (signal?.aborted) break;
        const [name, tenantId] = splitKey(key);
        let result: BatchResult;
        try {
          result = await this.processBatch(name, tenantId, hwm);
        } catch (err) {
          this.fireHook(this.observer?.onProjectorError, { projection: name, error: toError(err) });
          continue; // stays pending
        }
        if (result === "progress") {
          didWork = true;
          next.push(key);
        } else if (result === "caughtUp") {
          this.pending.delete(key);
        } else if (result === "failed") {
          didWork = true;
        }
        // busy / waiting / failed: stays pending, retried next round
      }
      working = next;
    }
    return didWork;
  }

  /**
   * Process one batch for (projection, tenant), reading no further than
   * `upTo`. On a handler failure, the events before the failing one are
   * committed straight away and a retry is scheduled for the failing one.
   */
  private async processBatch(
    projectionName: string,
    tenantId: string,
    upTo: bigint,
    ignoreBackoff = false
  ): Promise<BatchResult> {
    const key = pairKey(projectionName, tenantId);
    const projection = this.requireProjection(projectionName);
    const failure = this.failures.get(key);
    if (failure && !ignoreBackoff && Date.now() < failure.retryAt) return "waiting";

    let lastHandled: bigint | undefined;
    try {
      const result = await this.uowFactory.forTenant(tenantId).withTransaction(async (tx): Promise<BatchResult> => {
        const cp = this.checkpoints.claim
          ? await this.checkpoints.claim(tx, projectionName, tenantId)
          : await this.checkpoints.get(tx, projectionName, tenantId);
        if (!cp) return "busy";
        if (cp.lastGlobalPosition >= upTo) return "caughtUp";

        // Load dismissed events too and skip them here, so a batch made of
        // dismissed events still moves the checkpoint.
        const envs = await this.eventStore.loadGlobal(tx, {
          fromGlobalPositionExclusive: cp.lastGlobalPosition,
          toGlobalPositionInclusive: upTo,
          limit: this.batchSize,
          includeDismissed: true,
          tenantId
        });
        if (envs.length === 0) return "caughtUp";

        this.fireHook(this.observer?.onBatchLoaded, {
          projection: projectionName,
          count: envs.length,
          fromPosition: cp.lastGlobalPosition
        });

        for (const env of envs) {
          if (env.dismissed && !this.includeDismissed) continue;

          if (failure && failure.position === env.globalPosition && failure.attempts >= this.maxAttempts) {
            await this.deadLetters.add(tx, {
              projectionName,
              tenantId,
              globalPosition: env.globalPosition,
              eventId: env.eventId,
              eventType: env.payload.type,
              attempts: failure.attempts,
              lastError: failure.lastError
            });
            this.fireHook(this.observer?.onEventDeadLettered, {
              projection: projectionName,
              eventType: env.payload.type,
              globalPosition: env.globalPosition,
              tenantId,
              attempts: failure.attempts,
              lastError: failure.lastError
            });
            // End the batch here so the dead letter commits on its own. If a
            // later event in this batch failed, the rollback would undo the
            // dead letter and reset the failure state to that later event.
            lastHandled = env.globalPosition;
            break;
          }

          try {
            await this.runHandler(projection, tx, env, { replay: false });
          } catch (err) {
            throw new HandlerFailure(env as EventEnvelope<AnyEvent>, toError(err));
          }
        }

        lastHandled ??= envs[envs.length - 1]!.globalPosition;
        await this.checkpoints.set(tx, projectionName, tenantId, lastHandled);
        this.fireHook(this.observer?.onCheckpointAdvanced, {
          projection: projectionName,
          fromPosition: cp.lastGlobalPosition,
          toPosition: lastHandled
        });
        return "progress";
      });

      // The failing event was handled or dead-lettered: clear its state.
      if (failure && lastHandled !== undefined && lastHandled >= failure.position) this.failures.delete(key);
      return result;
    } catch (err) {
      if (!(err instanceof HandlerFailure)) throw err;

      const position = err.env.globalPosition;
      const attempts = failure && failure.position === position ? failure.attempts + 1 : 1;
      this.failures.set(key, {
        position,
        attempts,
        lastError: err.cause.stack || err.cause.message,
        retryAt: Date.now() + computeBackoffMs(attempts - 1, this.backoff)
      });

      // Commit everything before the failing event now, so a poison event
      // only holds back the events after it.
      if (position > 1n) {
        while ((await this.processBatch(projectionName, tenantId, position - 1n, true)) === "progress") {
          // keep going until caught up to just before the failing event
        }
      }
      return "failed";
    }
  }

  /** Move one tenant's checkpoint back to 0 under its claim, clearing the read model and dead letters. */
  private async resetTenant(projection: CatchUpProjection<E, TTx>, tenantId: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const done = await this.uowFactory.forTenant(tenantId).withTransaction(async (tx) => {
        const cp = this.checkpoints.claim
          ? await this.checkpoints.claim(tx, projection.name, tenantId)
          : await this.checkpoints.get(tx, projection.name, tenantId);
        if (!cp) return false; // another instance is mid-batch; try again shortly
        if (projection.reset) await projection.reset(tx);
        await this.checkpoints.reset!(tx, projection.name, tenantId);
        await this.deadLetters.purge(tx, { projectionName: projection.name, tenantId });
        return true;
      });
      if (done) return;
      if (attempt >= 50) {
        throw new Error(`Could not claim ${projection.name} for tenant ${tenantId} to rebuild it: another instance keeps it busy`);
      }
      await pause(100);
    }
  }

  private async runHandler(
    projection: CatchUpProjection<E, TTx>,
    tx: TTx,
    env: EventEnvelope<E>,
    ctx: ProjectionHandleContext
  ): Promise<void> {
    const info: CatchUpHandlerInfo = {
      projection: projection.name,
      eventType: env.payload.type,
      globalPosition: env.globalPosition
    };
    const start = Date.now();
    try {
      if (this.observer?.runHandler) {
        await this.observer.runHandler(() => projection.handle(tx, env, ctx), info);
      } else {
        await projection.handle(tx, env, ctx);
      }
      this.fireHook(this.observer?.onEventHandled, { ...info, durationMs: Date.now() - start });
    } catch (err) {
      this.fireHook(this.observer?.onEventFailed, { ...info, durationMs: Date.now() - start, error: toError(err) });
      throw err;
    }
  }

  private fireHook<I>(hook: ((info: I) => void) | undefined, info: I): void {
    if (!hook) return;
    try {
      hook(info);
    } catch {
      // Observer errors never affect the daemon.
    }
  }
}
