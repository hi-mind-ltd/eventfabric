import type { ProjectionCheckpointStore, ProjectionCheckpoint } from "@eventfabric/core";
import type { PgTx } from "../unitofwork/pg-transaction";

export class PgProjectionCheckpointStore implements ProjectionCheckpointStore<PgTx> {
  constructor(private readonly tableName: string = "eventfabric.projection_checkpoints") {}

  async get(tx: PgTx, projectionName: string): Promise<ProjectionCheckpoint> {
    const res = await tx.client.query(
      `SELECT projection_name, last_global_position, updated_at
       FROM ${this.tableName}
       WHERE tenant_id = $1 AND projection_name = $2`,
      [tx.tenantId, projectionName]
    );

    if (res.rowCount === 0) {
      await tx.client.query(
        `INSERT INTO ${this.tableName} (tenant_id, projection_name, last_global_position)
         VALUES ($1, $2, 0)
         ON CONFLICT (tenant_id, projection_name) DO NOTHING`,
        [tx.tenantId, projectionName]
      );
      return { projectionName, lastGlobalPosition: 0n, updatedAt: new Date().toISOString() };
    }

    const r: any = res.rows[0];
    return {
      projectionName: r.projection_name,
      lastGlobalPosition: BigInt(r.last_global_position),
      updatedAt: new Date(r.updated_at).toISOString()
    };
  }

  async set(tx: PgTx, projectionName: string, lastGlobalPosition: bigint): Promise<void> {
    await tx.client.query(
      `INSERT INTO ${this.tableName} (tenant_id, projection_name, last_global_position, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, projection_name)
       DO UPDATE SET
         last_global_position = EXCLUDED.last_global_position,
         updated_at = now()
       WHERE ${this.tableName}.last_global_position <= EXCLUDED.last_global_position`,
      [tx.tenantId, projectionName, lastGlobalPosition.toString()]
    );
  }
}
