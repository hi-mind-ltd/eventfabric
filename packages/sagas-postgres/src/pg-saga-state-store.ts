import type { PgTx } from "@eventfabric/postgres";
import type {
  SagaInstance,
  SagaInstanceStatus,
  SagaStateStore,
} from "@eventfabric/sagas";

export interface PgSagaStateStoreOptions {
  /** Schema-qualified table name. Default: "eventfabric.saga_instances". */
  readonly tableName?: string;
}

interface Row {
  tenant_id: string;
  saga_name: string;
  instance_id: string;
  state: unknown;
  state_version: number;
  status: SagaInstanceStatus;
  schema_version: number;
  last_event_pos: string | null;
  created_at: Date;
  updated_at: Date;
}

const rowToInstance = <TState>(r: Row): SagaInstance<TState> => ({
  tenantId: r.tenant_id,
  sagaName: r.saga_name,
  instanceId: r.instance_id,
  state: r.state as TState,
  stateVersion: Number(r.state_version),
  status: r.status,
  schemaVersion: Number(r.schema_version),
  lastEventPos: r.last_event_pos === null ? null : BigInt(r.last_event_pos),
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

/**
 * Postgres-backed saga state store. Uses optimistic concurrency on
 * `state_version`: each `update` call asserts the row is still at the
 * version we loaded, and bumps it. A version mismatch returns false so
 * the caller (the saga runner) can release the event for redelivery.
 *
 * Inserts are explicit and surface a primary-key violation if the row
 * already exists — the runner only inserts after a `load` returned null,
 * so a violation here means a parallel worker started the same instance
 * concurrently. The runner treats that as a concurrent failure.
 */
export class PgSagaStateStore<TState> implements SagaStateStore<TState, PgTx> {
  private readonly tableName: string;

  constructor(opts?: PgSagaStateStoreOptions) {
    this.tableName = opts?.tableName ?? "eventfabric.saga_instances";
  }

  async load(
    tx: PgTx,
    params: { sagaName: string; instanceId: string; tenantId: string }
  ): Promise<SagaInstance<TState> | null> {
    const res = await tx.client.query(
      `SELECT tenant_id, saga_name, instance_id, state, state_version, status,
              schema_version, last_event_pos, created_at, updated_at
         FROM ${this.tableName}
        WHERE tenant_id = $1 AND saga_name = $2 AND instance_id = $3`,
      [params.tenantId, params.sagaName, params.instanceId]
    );
    if (res.rowCount === 0) return null;
    return rowToInstance<TState>(res.rows[0] as Row);
  }

  async insert(tx: PgTx, instance: SagaInstance<TState>): Promise<void> {
    await tx.client.query(
      `INSERT INTO ${this.tableName}
         (tenant_id, saga_name, instance_id, state, state_version, status,
          schema_version, last_event_pos, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz)`,
      [
        instance.tenantId,
        instance.sagaName,
        instance.instanceId,
        JSON.stringify(instance.state),
        instance.stateVersion,
        instance.status,
        instance.schemaVersion,
        instance.lastEventPos === null ? null : instance.lastEventPos.toString(),
        instance.createdAt,
        instance.updatedAt,
      ]
    );
  }

  async update(
    tx: PgTx,
    instance: SagaInstance<TState>,
    expectedVersion: number
  ): Promise<boolean> {
    const res = await tx.client.query(
      `UPDATE ${this.tableName}
          SET state = $1::jsonb,
              state_version = $2,
              status = $3,
              schema_version = $4,
              last_event_pos = $5,
              updated_at = $6::timestamptz
        WHERE tenant_id = $7
          AND saga_name = $8
          AND instance_id = $9
          AND state_version = $10`,
      [
        JSON.stringify(instance.state),
        instance.stateVersion,
        instance.status,
        instance.schemaVersion,
        instance.lastEventPos === null ? null : instance.lastEventPos.toString(),
        instance.updatedAt,
        instance.tenantId,
        instance.sagaName,
        instance.instanceId,
        expectedVersion,
      ]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Retention: deletes terminal saga instances (status `completed` or
   * `failed`) older than `olderThan`. Call from a cron alongside the
   * other cleanup jobs in the runbook. The instance row itself is
   * removed — the events the saga emitted remain in `eventfabric.events`,
   * so the audit trail is preserved.
   *
   * `statuses` defaults to both terminal statuses; pass a narrower set
   * (e.g. `["completed"]`) if you want to keep `failed` rows around
   * longer for triage. Returns the number of rows deleted.
   */
  async cleanupTerminal(
    tx: PgTx,
    params: {
      olderThan: Date;
      tenantId?: string;
      statuses?: readonly ("completed" | "failed")[];
    }
  ): Promise<number> {
    const statuses = params.statuses ?? ["completed", "failed"];
    if (statuses.length === 0) return 0;
    if (params.tenantId !== undefined) {
      const res = await tx.client.query(
        `DELETE FROM ${this.tableName}
          WHERE status = ANY($1::text[])
            AND updated_at < $2::timestamptz
            AND tenant_id = $3`,
        [[...statuses], params.olderThan.toISOString(), params.tenantId]
      );
      return res.rowCount ?? 0;
    }
    const res = await tx.client.query(
      `DELETE FROM ${this.tableName}
        WHERE status = ANY($1::text[])
          AND updated_at < $2::timestamptz`,
      [[...statuses], params.olderThan.toISOString()]
    );
    return res.rowCount ?? 0;
  }

  /**
   * Ops: flip a `failed` saga instance back to `active` after the
   * operator has triaged + fixed the underlying issue. Bumps
   * `state_version` so any in-flight stale reads CAS-fail and re-load.
   * The instance's state is left as-is — if state itself needs editing,
   * do it in the same transaction before calling this.
   *
   * Returns true if the row was found and reactivated; false if it
   * didn't exist or wasn't in `failed` state.
   */
  async reactivate(
    tx: PgTx,
    params: { sagaName: string; instanceId: string; tenantId: string }
  ): Promise<boolean> {
    const res = await tx.client.query(
      `UPDATE ${this.tableName}
          SET status = 'active',
              state_version = state_version + 1,
              updated_at = NOW()
        WHERE tenant_id = $1
          AND saga_name = $2
          AND instance_id = $3
          AND status = 'failed'`,
      [params.tenantId, params.sagaName, params.instanceId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Ops helper — list active instances for one saga + tenant. Useful for
   * dashboards and stuck-instance investigations.
   */
  async listActive(
    tx: PgTx,
    params: { sagaName: string; tenantId: string }
  ): Promise<SagaInstance<TState>[]> {
    const res = await tx.client.query(
      `SELECT tenant_id, saga_name, instance_id, state, state_version, status,
              schema_version, last_event_pos, created_at, updated_at
         FROM ${this.tableName}
        WHERE tenant_id = $1 AND saga_name = $2 AND status = 'active'
        ORDER BY created_at ASC`,
      [params.tenantId, params.sagaName]
    );
    return res.rows.map((r: Row) => rowToInstance<TState>(r));
  }
}
