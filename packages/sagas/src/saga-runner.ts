import type { AnyEvent, EventEnvelope, Transaction } from "@eventfabric/core";
import type {
  Saga,
  SagaInstance,
  SagaReaction,
  TimerMessage,
} from "./saga";
import type { SagaStateStore } from "./saga-state-store";
import type { SagaCommandQueue } from "./saga-command-queue";
import type { SagaTimerStore } from "./saga-timer-store";
import type { SagaObserver } from "./saga-observer";

export type SagaDelivery<TEvent extends AnyEvent> =
  | { kind: "event"; envelope: EventEnvelope<TEvent> }
  | { kind: "timer"; instanceId: string; tenantId: string; timer: TimerMessage };

export interface SagaTransitionStores<TState, TTx extends Transaction> {
  readonly stateStore: SagaStateStore<TState, TTx>;
  readonly commandQueue: SagaCommandQueue<TTx>;
  readonly timerStore: SagaTimerStore<TTx>;
}

export type SagaTransitionOutcome<TState> =
  | { result: "applied"; instance: SagaInstance<TState>; reaction: SagaReaction<TState> }
  | { result: "skipped"; reason: "no-correlation" | "no-instance" | "already-applied" | "instance-terminal" }
  | { result: "concurrent"; instance: SagaInstance<TState> };

interface ApplyOptions {
  readonly now?: () => Date;
  readonly observer?: SagaObserver;
}

function safeEmit(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch {
    // Observer hooks are fire-and-forget — never let an instrumentation
    // bug affect saga runtime.
  }
}

/**
 * Applies one delivery (event or timer) to a saga, all inside the caller's
 * transaction. The order is:
 *
 *   1. Resolve the target instanceId (correlate / explicit-from-timer).
 *   2. Load the instance. Skip or seed-new based on `startsNewInstance`.
 *   3. Idempotency check — events with `globalPosition <= lastEventPos`
 *      are dropped. Timers don't have a position, so they always run.
 *   4. Run the appropriate `react*` method.
 *   5. Persist new state (optimistic CAS), commands, timer changes, and
 *      `lastEventPos` advance — all in `tx`.
 *
 * Concurrency: if the state store's `update` reports a version mismatch,
 * we return `{ result: "concurrent" }` and the caller should release the
 * delivery for retry. (For events on the outbox path that's the natural
 * thing; for timers the scheduler should re-claim later.)
 *
 * The function never opens its own transaction. The caller wires `tx`
 * from the bus / runner / scheduler so all writes share atomicity.
 */
export async function applySagaTransition<
  TState,
  TEvent extends AnyEvent,
  TTx extends Transaction
>(
  saga: Saga<TState, TEvent>,
  delivery: SagaDelivery<TEvent>,
  ctx: { tx: TTx; tenantId: string },
  stores: SagaTransitionStores<TState, TTx>,
  opts: ApplyOptions = {}
): Promise<SagaTransitionOutcome<TState>> {
  const now = opts.now ?? (() => new Date());

  let instanceId: string;
  let isFreshlyCreated = false;
  let instance: SagaInstance<TState> | null;

  if (delivery.kind === "event") {
    const correlated = saga.correlate(delivery.envelope);
    if (correlated === null) return { result: "skipped", reason: "no-correlation" };
    instanceId = correlated;
    instance = await stores.stateStore.load(ctx.tx, {
      sagaName: saga.name,
      instanceId,
      tenantId: ctx.tenantId,
    });

    if (!instance) {
      if (!saga.startsNewInstance(delivery.envelope)) {
        return { result: "skipped", reason: "no-instance" };
      }
      const nowIso = now().toISOString();
      instance = {
        sagaName: saga.name,
        instanceId,
        tenantId: ctx.tenantId,
        state: saga.initialState(delivery.envelope),
        stateVersion: 0,
        status: "active",
        schemaVersion: saga.version,
        lastEventPos: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await stores.stateStore.insert(ctx.tx, instance);
      isFreshlyCreated = true;
    }

    if (instance.status !== "active") {
      return { result: "skipped", reason: "instance-terminal" };
    }

    if (
      instance.lastEventPos !== null &&
      delivery.envelope.globalPosition <= instance.lastEventPos
    ) {
      return { result: "skipped", reason: "already-applied" };
    }
  } else {
    instanceId = delivery.instanceId;
    instance = await stores.stateStore.load(ctx.tx, {
      sagaName: saga.name,
      instanceId,
      tenantId: delivery.tenantId,
    });
    if (!instance) return { result: "skipped", reason: "no-instance" };
    if (instance.status !== "active") {
      return { result: "skipped", reason: "instance-terminal" };
    }
  }

  // Schema upcasting: if the persisted instance was stored under an
  // older saga version, transform its state to the current shape before
  // the reaction sees it. The runner persists the upgraded state on the
  // next CAS update — so old-shape rows are gradually rewritten as
  // their sagas advance, without a bulk migration step.
  if (
    !isFreshlyCreated &&
    saga.upcaster &&
    instance.schemaVersion < saga.version
  ) {
    const upcastState = saga.upcaster(instance.state, instance.schemaVersion);
    instance = {
      ...instance,
      state: upcastState,
      schemaVersion: saga.version,
    };
  }

  const reactCtx = {
    metadata: {
      correlationId:
        delivery.kind === "event"
          ? delivery.envelope.correlationId ?? instanceId
          : instanceId,
      instanceId,
      tenantId: ctx.tenantId,
    },
  };

  if (isFreshlyCreated) {
    safeEmit(() =>
      opts.observer?.onInstanceStarted?.({
        sagaName: saga.name,
        instanceId,
        tenantId: ctx.tenantId,
      })
    );
  }

  const runReactStep = async (): Promise<SagaReaction<TState>> => {
    if (delivery.kind === "event") {
      return saga.reactToEvent(instance!.state, delivery.envelope, reactCtx);
    }
    if (saga.reactToTimer) {
      return saga.reactToTimer(instance!.state, delivery.timer, reactCtx);
    }
    return { newState: instance!.state };
  };

  const reactInfo = {
    sagaName: saga.name,
    instanceId,
    tenantId: ctx.tenantId,
    delivery: delivery.kind,
    trigger:
      delivery.kind === "event"
        ? delivery.envelope.payload.type
        : delivery.timer.id,
  } as const;

  const reaction = opts.observer?.runReact
    ? await opts.observer.runReact(runReactStep, reactInfo)
    : await runReactStep();

  // Persist commands first, then timers, then state. Order within the
  // single transaction doesn't matter for atomicity, but doing state last
  // means a hypothetical mid-tx error before the state CAS leaves nothing
  // observable — the queues are not yet visible to drainers either,
  // since they are inside the same tx.
  if (reaction.commands && reaction.commands.length > 0) {
    // Causation: when the trigger was an event, that event's eventId is
    // the cause of every command this transition produced. Stamped onto
    // the queue row so the dispatcher can carry it onto cmd.metadata.
    // Timer-triggered transitions have no upstream event in scope —
    // causation falls back to null (the timer itself wasn't an event).
    const causationEventId =
      delivery.kind === "event" ? delivery.envelope.eventId : null;
    for (const cmd of reaction.commands) {
      await stores.commandQueue.enqueue(ctx.tx, {
        tenantId: ctx.tenantId,
        sagaName: saga.name,
        instanceId,
        command: cmd,
        causationEventId,
      });
    }
  }

  if (reaction.cancel && reaction.cancel.length > 0) {
    await stores.timerStore.cancel(ctx.tx, {
      tenantId: ctx.tenantId,
      sagaName: saga.name,
      instanceId,
      ids: reaction.cancel,
    });
  }

  if (reaction.schedule && reaction.schedule.length > 0) {
    for (const sched of reaction.schedule) {
      const fireAt =
        sched.fireAt instanceof Date
          ? sched.fireAt
          : new Date(now().getTime() + sched.fireAt.afterMs);
      await stores.timerStore.schedule(ctx.tx, {
        tenantId: ctx.tenantId,
        sagaName: saga.name,
        instanceId,
        id: sched.id,
        fireAt,
        message: sched.message,
      });
    }
  }

  const updated: SagaInstance<TState> = {
    ...instance,
    state: reaction.newState,
    stateVersion: instance.stateVersion + 1,
    status: reaction.end ? "completed" : instance.status,
    lastEventPos:
      delivery.kind === "event"
        ? delivery.envelope.globalPosition
        : instance.lastEventPos,
    updatedAt: now().toISOString(),
  };

  if (isFreshlyCreated) {
    // The insert just happened; CAS the freshly-inserted row from version 0.
    const ok = await stores.stateStore.update(ctx.tx, updated, instance.stateVersion);
    if (!ok) return { result: "concurrent", instance };
  } else {
    const ok = await stores.stateStore.update(ctx.tx, updated, instance.stateVersion);
    if (!ok) return { result: "concurrent", instance };
  }

  if (reaction.end) {
    const createdAtMs = Date.parse(instance.createdAt);
    const ageMs = Number.isNaN(createdAtMs)
      ? 0
      : now().getTime() - createdAtMs;
    safeEmit(() =>
      opts.observer?.onInstanceCompleted?.({
        sagaName: saga.name,
        instanceId,
        tenantId: ctx.tenantId,
        ageMs,
      })
    );
  }

  return { result: "applied", instance: updated, reaction };
}
