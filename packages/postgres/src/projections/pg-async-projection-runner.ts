import type { Pool } from "pg";
import type { AnyEvent, AsyncProjection, AsyncRunnerOptions } from "@eventfabric/core";
import { AsyncProjectionRunner } from "@eventfabric/core";
import { PgUnitOfWork } from "../unitofwork/pg-unit-of-work";
import { PgEventStore } from "../pg-event-store";
import { PgProjectionCheckpointStore } from "./pg-projection-checkpoint-store";
import { PgOutboxStore } from "../outbox/pg-outbox-store";
import type { PgTx } from "../unitofwork/pg-transaction";

/**
 * Factory function to create a PostgreSQL-specific async projection runner.
 * This wires up all the PostgreSQL implementations with the core orchestration logic.
 */
export function createAsyncProjectionRunner<E extends AnyEvent>(
  pool: Pool,
  eventStore: PgEventStore<E>,
  projections: AsyncProjection<E, PgTx>[],
  opts: AsyncRunnerOptions
): AsyncProjectionRunner<E, PgTx> {
  const uow = new PgUnitOfWork(pool);
  const outbox = new PgOutboxStore();
  const checkpoints = new PgProjectionCheckpointStore();

  return new AsyncProjectionRunner(
    uow,
    eventStore,
    outbox,
    checkpoints,
    projections,
    opts
  );
}

/**
 * @deprecated Use createAsyncProjectionRunner instead.
 * This class is kept for backward compatibility but will be removed in a future version.
 */
export class PgAsyncProjectionRunner<E extends AnyEvent> {
  private readonly runner: AsyncProjectionRunner<E, PgTx>;

  constructor(
    pool: Pool,
    eventStore: PgEventStore<E>,
    projections: AsyncProjection<E, PgTx>[],
    opts: AsyncRunnerOptions
  ) {
    this.runner = createAsyncProjectionRunner(pool, eventStore, projections, opts);
  }

  async start(signal: AbortSignal): Promise<void> {
    return this.runner.start(signal);
  }
}
