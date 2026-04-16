import type { ProjectionCheckpointStore, ProjectionCheckpoint } from "@eventfabric/core";
import type { PgTx } from "../unitofwork/pg-transaction";

export class PgProjectionCheckpointStore implements ProjectionCheckpointStore<PgTx> {
  constructor(private readonly tableName: string = "eventfabric.projection_checkpoints") {}

  async get(tx: PgTx, projectionName: string): Promise<ProjectionCheckpoint> {
    const res = await tx.client.query(
      `SELECT projection_name, last_global_position, updated_at
       FROM ${this.tableName}
       WHERE projection_name = $1`,
      [projectionName]
    );

    if (res.rowCount === 0) {
      await tx.client.query(
        `INSERT INTO ${this.tableName} (projection_name, last_global_position)
         VALUES ($1, 0)
         ON CONFLICT (projection_name) DO NOTHING`,
        [projectionName]
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
      `INSERT INTO ${this.tableName} (projection_name, last_global_position, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (projection_name)
       DO UPDATE SET
         last_global_position = EXCLUDED.last_global_position,
         updated_at = now()
       WHERE ${this.tableName}.last_global_position <= EXCLUDED.last_global_position`,
      [projectionName, lastGlobalPosition.toString()]
    );
  }
}
