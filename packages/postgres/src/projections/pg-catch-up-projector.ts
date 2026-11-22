import type { Pool } from "pg";
import type { AnyEvent, CatchUpProjection, CatchUpOptions } from "@eventfabric/core";
import { CatchUpProjector } from "@eventfabric/core";
import { PgUnitOfWork } from "../unitofwork/pg-unit-of-work";
import { PgEventStore } from "../pg-event-store";
import { PgProjectionCheckpointStore } from "./pg-projection-checkpoint-store";
import { PgHighWaterMark, type PgHighWaterMarkOptions } from "./pg-high-water-mark";
import type { PgTx } from "../unitofwork/pg-transaction";

/**
 * Factory for a PostgreSQL-backed catch-up projector.
 *
 * The returned projector is tenant-aware: for each round it discovers
 * tenants with pending work, opens one tx per tenant, and advances a
 * per-tenant checkpoint. A single UoW seeded with `"default"` is passed to
 * the core projector — it calls `.forTenant(id)` per round to get a tx
 * whose `tenantId` matches the one being processed.
 *
 * Reads are bounded by a `PgHighWaterMark`, so an event whose transaction
 * commits after a higher position was processed is still picked up.
 */
export function createCatchUpProjector<E extends AnyEvent>(
  pool: Pool,
  eventStore: PgEventStore<E>,
  opts: { highWaterMark?: Omit<PgHighWaterMarkOptions, "eventsTable"> } = {}
): CatchUpProjector<E, PgTx> {
  const uow = new PgUnitOfWork(pool);
  const checkpoints = new PgProjectionCheckpointStore();
  const hwm = new PgHighWaterMark(pool, { ...opts.highWaterMark, eventsTable: eventStore.eventsTableName });

  return new CatchUpProjector(uow, eventStore, checkpoints, hwm);
}

/**
 * @deprecated Use createCatchUpProjector instead.
 */
export class PgCatchUpProjector<E extends AnyEvent> {
  private readonly projector: CatchUpProjector<E, PgTx>;

  constructor(
    uow: PgUnitOfWork,
    eventStore: PgEventStore<E>,
    checkpoints: PgProjectionCheckpointStore,
    pool?: Pool
  ) {
    // Pass the pool to get high-water-mark protection against late commits.
    const hwm = pool ? new PgHighWaterMark(pool, { eventsTable: eventStore.eventsTableName }) : undefined;
    this.projector = new CatchUpProjector(uow, eventStore, checkpoints, hwm);
  }

  async catchUpProjection(projection: CatchUpProjection<E, PgTx>, options: CatchUpOptions = {}): Promise<void> {
    return this.projector.catchUpProjection(projection, options);
  }

  async catchUpAll(projections: CatchUpProjection<E, PgTx>[], options: CatchUpOptions = {}): Promise<void> {
    return this.projector.catchUpAll(projections, options);
  }
}
