import type { AnyEvent, EventStore, EventEnvelope, Transaction, UnitOfWork } from "./types";
import type { AggregateRoot } from "./aggregates/aggregate-root";
import type { InlineProjector } from "./projections/inline-projector";
import type { SnapshotStore } from "./snapshots/snapshot-store";
import { shouldSnapshot as shouldSnapshotAt, type SnapshotPolicy } from "./snapshots/snapshot-policy";
import type { AsyncProcessorConfig } from "./projections/async-processor-config";

export class Repository<
  TAgg extends AggregateRoot<S, E>,
  S,
  E extends AnyEvent,
  TTx extends Transaction = Transaction
> {
  constructor(
    private readonly aggregateName: string,
    private readonly uow: UnitOfWork<TTx>,
    private readonly store: EventStore<E, TTx>,
    private readonly make: (id: string, snapshotState?: S) => TAgg,
    private readonly opts: {
      inlineProjector?: InlineProjector<E, TTx>;
      snapshotStore?: SnapshotStore<S, TTx>;
      snapshotPolicy?: SnapshotPolicy;
      snapshotSchemaVersion?: number;
      asyncProcessor?: AsyncProcessorConfig;
    } = {}
  ) {}

  async load(id: string): Promise<TAgg> {
    return this.uow.withTransaction(async (tx) => {
      const snap = this.opts.snapshotStore
        ? await this.opts.snapshotStore.load(tx, this.aggregateName, id)
        : null;

      const baseVersion = snap?.aggregateVersion ?? 0;

      const history = await this.store.loadStream(tx, {
        aggregateName: this.aggregateName,
        aggregateId: id,
        fromVersion: baseVersion + 1,
      });

      const agg = this.make(id, snap?.state);
      agg.version = baseVersion;
      agg.loadFromHistory(history.map((h) => ({ payload: h.payload, aggregateVersion: h.aggregateVersion })));
      return agg;
    });
  }

  async save(
    agg: TAgg,
    params?: {
      meta?: { correlationId?: string; causationId?: string };
      enqueueOutbox?: boolean;
      outboxTopic?: string | null;
      forceSnapshot?: boolean;
    }
  ): Promise<{ appended: EventEnvelope<E>[] } | null> {
    // Leave the aggregate untouched until the commit: if anything below fails
    // (concurrency conflict, projector, snapshot, commit), the transaction
    // rolls back and the aggregate still holds its pending events and old
    // version, so the caller can retry or discard it knowingly.
    const events = agg.peekPendingEvents();
    if (events.length === 0) return null;

    const { appended, nextVersion } = await this.uow.withTransaction(async (tx) => {
      const asyncCfg = this.opts.asyncProcessor ?? { enabled: false as const };
      const enqueueOutbox = params?.enqueueOutbox ?? asyncCfg.enabled;
      const outboxTopic = params?.outboxTopic ?? (asyncCfg.enabled ? (asyncCfg.topic ?? null) : null);

      const res = await this.store.append(tx, {
        aggregateName: this.aggregateName,
        aggregateId: agg.id,
        expectedAggregateVersion: agg.version,
        events: [...events],
        meta: params?.meta,
        enqueueOutbox,
        outboxTopic,
      });

      const nextVersion = res.nextAggregateVersion;

      if (this.opts.inlineProjector) {
        await this.opts.inlineProjector.run(tx, res.appended);
      }

      const policy = this.opts.snapshotPolicy ?? { everyNEvents: 50 };
      const shouldSnapshot =
        !!this.opts.snapshotStore &&
        (params?.forceSnapshot ||
          shouldSnapshotAt(policy, agg.version, nextVersion));

      if (shouldSnapshot && this.opts.snapshotStore) {
        await this.opts.snapshotStore.save(tx, {
          aggregateName: this.aggregateName,
          aggregateId: agg.id,
          aggregateVersion: nextVersion,
          createdAt: new Date().toISOString(),
          snapshotSchemaVersion: this.opts.snapshotSchemaVersion ?? 1,
          state: agg.state,
        });
      }

      return { appended: res.appended, nextVersion };
    });

    agg.markCommitted(events.length, nextVersion);
    return { appended };
  }
}
