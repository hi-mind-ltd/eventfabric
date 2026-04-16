import type { Pool } from "pg";
import type { AnyEvent, CatchUpProjection, CatchUpOptions } from "@eventfabric/core";
import { CatchUpProjector } from "@eventfabric/core";
import { PgUnitOfWork } from "../unitofwork/pg-unit-of-work";
import { PgEventStore } from "../pg-event-store";
import { PgProjectionCheckpointStore } from "./pg-projection-checkpoint-store";
import type { PgTx } from "../unitofwork/pg-transaction";

/**
 * Factory function to create a PostgreSQL-specific catch-up projector.
 * This wires up all the PostgreSQL implementations with the core catch-up logic.
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
 * This class is kept for backward compatibility but will be removed in a future version.
 */
export class PgCatchUpProjector<E extends AnyEvent> {
  private readonly projector: CatchUpProjector<E, PgTx>;

  constructor(
    private readonly uow: PgUnitOfWork,
    private readonly eventStore: PgEventStore<E>,
    private readonly checkpoints: PgProjectionCheckpointStore
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
