import type { Pool } from "pg";
import type { AnyEvent, CatchUpProjection, CatchUpOptions } from "@eventfabric/core";
import { CatchUpProjector } from "@eventfabric/core";
import { PgUnitOfWork } from "../unitofwork/pg-unit-of-work";
import { PgEventStore } from "../pg-event-store";
import { PgProjectionCheckpointStore } from "./pg-projection-checkpoint-store";
import type { PgTx } from "../unitofwork/pg-transaction";

/**
 * Factory for a PostgreSQL-backed catch-up projector.
 *
 * The returned projector is tenant-aware: for each round it discovers
 * tenants with pending work, opens one tx per tenant, and advances a
 * per-tenant checkpoint. A single UoW seeded with `"default"` is passed to
 * the core projector — it calls `.forTenant(id)` per round to get a tx
 * whose `tenantId` matches the one being processed.
 */
export function createCatchUpProjector<E extends AnyEvent>(
  pool: Pool,
  eventStore: PgEventStore<E>
): CatchUpProjector<E, PgTx> {
  const uow = new PgUnitOfWork(pool);
  const checkpoints = new PgProjectionCheckpointStore();

  return new CatchUpProjector(uow, eventStore, checkpoints);
}

/**
 * @deprecated Use createCatchUpProjector instead.
 */
export class PgCatchUpProjector<E extends AnyEvent> {
  private readonly projector: CatchUpProjector<E, PgTx>;

  constructor(
    uow: PgUnitOfWork,
    eventStore: PgEventStore<E>,
    checkpoints: PgProjectionCheckpointStore
  ) {
    this.projector = new CatchUpProjector(uow, eventStore, checkpoints);
  }

  async catchUpProjection(projection: CatchUpProjection<E, PgTx>, options: CatchUpOptions = {}): Promise<void> {
    return this.projector.catchUpProjection(projection, options);
  }

  async catchUpAll(projections: CatchUpProjection<E, PgTx>[], options: CatchUpOptions = {}): Promise<void> {
    return this.projector.catchUpAll(projections, options);
  }
}
