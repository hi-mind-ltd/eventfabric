import type { PgTx } from "../unitofwork/pg-transaction";

export type Snapshot<S> = {
  aggregateName: string;
  aggregateId: string;
  aggregateVersion: number;
  createdAt: string;
  snapshotSchemaVersion: number;
  state: S;
};

export type SnapshotUpcaster<S> = (input: unknown) => S;
export type SnapshotUpcasters<S> = { [schemaVersion: number]: SnapshotUpcaster<S> };

export type PgSnapshotStoreOptions<S> = {
  /** Schema-qualified snapshots table name. Default: "eventfabric.snapshots" */
  tableName?: string;
  /** Current snapshot schema version. Default: 1 */
  currentSchemaVersion?: number;
  /** Upcasters for migrating old snapshot versions to current. */
  upcasters?: SnapshotUpcasters<S>;
};

export class PgSnapshotStore<SCurrent> {
  private readonly tableName: string;
  private readonly currentSchemaVersion: number;
  private readonly upcasters: SnapshotUpcasters<SCurrent>;

  constructor(opts?: PgSnapshotStoreOptions<SCurrent>) {
    this.tableName = opts?.tableName ?? "eventfabric.snapshots";
    this.currentSchemaVersion = opts?.currentSchemaVersion ?? 1;
    this.upcasters = opts?.upcasters ?? {};
  }

  async load(tx: PgTx, aggregateName: string, aggregateId: string): Promise<Snapshot<SCurrent> | null> {
    const res = await tx.client.query(
      `SELECT aggregate_name, aggregate_id, aggregate_version, created_at, snapshot_schema_version, state
       FROM ${this.tableName}
       WHERE tenant_id = $1 AND aggregate_name = $2 AND aggregate_id = $3`,
      [tx.tenantId, aggregateName, aggregateId]
    );
    if (res.rowCount === 0) return null;
    const r: any = res.rows[0];
    const schemaVersion = Number(r.snapshot_schema_version);
    const state = this.upcastState(schemaVersion, r.state);
    return {
      aggregateName: r.aggregate_name,
      aggregateId: r.aggregate_id,
      aggregateVersion: Number(r.aggregate_version),
      createdAt: new Date(r.created_at).toISOString(),
      snapshotSchemaVersion: this.currentSchemaVersion,
      state
    };
  }

  async save(tx: PgTx, snapshot: Snapshot<SCurrent>): Promise<void> {
    await tx.client.query(
      `INSERT INTO ${this.tableName}
        (tenant_id, aggregate_name, aggregate_id, aggregate_version, created_at, snapshot_schema_version, state)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7::jsonb)
       ON CONFLICT (tenant_id, aggregate_name, aggregate_id)
       DO UPDATE SET
         aggregate_version = EXCLUDED.aggregate_version,
         created_at = EXCLUDED.created_at,
         snapshot_schema_version = EXCLUDED.snapshot_schema_version,
         state = EXCLUDED.state
       WHERE ${this.tableName}.aggregate_version <= EXCLUDED.aggregate_version`,
      [
        tx.tenantId,
        snapshot.aggregateName,
        snapshot.aggregateId,
        snapshot.aggregateVersion,
        snapshot.createdAt,
        snapshot.snapshotSchemaVersion,
        JSON.stringify(snapshot.state)
      ]
    );
  }

  private upcastState(schemaVersion: number, rawState: unknown): SCurrent {
    if (schemaVersion === this.currentSchemaVersion) return rawState as SCurrent;
    const up = this.upcasters[schemaVersion];
    if (!up) throw new Error(`No snapshot upcaster for schema version ${schemaVersion}`);
    return up(rawState);
  }
}
