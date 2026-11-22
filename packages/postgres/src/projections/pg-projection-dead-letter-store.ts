import type {
  ProjectionDeadLetter,
  ProjectionDeadLetterStore,
  NewProjectionDeadLetter,
  ListProjectionDeadLettersOptions
} from "@eventfabric/core";
import type { PgTx } from "../unitofwork/pg-transaction";

const COLUMNS = `id, projection_name, tenant_id, global_position, event_id, event_type, attempts, last_error, dead_lettered_at`;

/** PostgreSQL storage for projection dead letters (`eventfabric.projection_dead_letters`). */
export class PgProjectionDeadLetterStore implements ProjectionDeadLetterStore<PgTx> {
  constructor(private readonly tableName: string = "eventfabric.projection_dead_letters") {}

  async add(tx: PgTx, item: NewProjectionDeadLetter): Promise<void> {
    await tx.client.query(
      `INSERT INTO ${this.tableName}
         (projection_name, tenant_id, global_position, event_id, event_type, attempts, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (projection_name, tenant_id, global_position)
       DO UPDATE SET attempts = EXCLUDED.attempts,
                     last_error = EXCLUDED.last_error,
                     dead_lettered_at = now()`,
      [
        item.projectionName,
        item.tenantId,
        item.globalPosition.toString(),
        item.eventId,
        item.eventType,
        item.attempts,
        item.lastError
      ]
    );
  }

  async get(tx: PgTx, id: ProjectionDeadLetter["id"]): Promise<ProjectionDeadLetter | null> {
    const res = await tx.client.query(`SELECT ${COLUMNS} FROM ${this.tableName} WHERE id = $1`, [id]);
    return res.rowCount ? this.mapRow(res.rows[0]) : null;
  }

  async list(tx: PgTx, opts: ListProjectionDeadLettersOptions = {}): Promise<ProjectionDeadLetter[]> {
    const res = await tx.client.query(
      `SELECT ${COLUMNS}
       FROM ${this.tableName}
       WHERE ($1::text IS NULL OR projection_name = $1)
         AND ($2::text IS NULL OR tenant_id = $2)
       ORDER BY dead_lettered_at ASC, id ASC
       LIMIT $3 OFFSET $4`,
      [opts.projectionName ?? null, opts.tenantId ?? null, opts.limit ?? 100, opts.offset ?? 0]
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async delete(tx: PgTx, id: ProjectionDeadLetter["id"]): Promise<void> {
    await tx.client.query(`DELETE FROM ${this.tableName} WHERE id = $1`, [id]);
  }

  async purge(tx: PgTx, opts: { projectionName: string; tenantId?: string }): Promise<number> {
    const res = await tx.client.query(
      `DELETE FROM ${this.tableName}
       WHERE projection_name = $1 AND ($2::text IS NULL OR tenant_id = $2)`,
      [opts.projectionName, opts.tenantId ?? null]
    );
    return res.rowCount ?? 0;
  }

  private mapRow(r: any): ProjectionDeadLetter {
    return {
      id: Number(r.id),
      projectionName: r.projection_name,
      tenantId: r.tenant_id,
      globalPosition: BigInt(r.global_position),
      eventId: r.event_id,
      eventType: r.event_type,
      attempts: Number(r.attempts),
      lastError: r.last_error ?? null,
      deadLetteredAt: new Date(r.dead_lettered_at).toISOString()
    };
  }
}
