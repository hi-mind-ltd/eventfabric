import type { Pool } from "pg";
import type { AnyEvent, AsyncProjection, AsyncRunnerOptions } from "@eventfabric/core";
import { AsyncProjectionRunner } from "@eventfabric/core";
import { PgUnitOfWork } from "../unitofwork/pg-unit-of-work";
import { PgEventStore } from "../pg-event-store";
import { PgProjectionCheckpointStore } from "./pg-projection-checkpoint-store";
import { PgOutboxStore } from "../outbox/pg-outbox-store";
import type { PgTx } from "../unitofwork/pg-transaction";

/**
 * Factory for a PostgreSQL-backed async projection runner.
 *
 * The runner is tenant-aware: the outer batch tx runs in the "default"
 * tenant (outbox claim/ack/dead-letter are cross-tenant queue ops), and the
 * handler invocation for each event narrows the tx to that event's tenant
 * so `loadStream` / `append` inside the handler see the right tenant's
 * data. Per-tenant checkpoints let one tenant's retry backoff advance
 * independently of other tenants' progress.
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
