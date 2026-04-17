import type { Pool } from "pg";
import { PgUnitOfWork } from "../unitofwork/pg-unit-of-work";

export type OutboxBacklogStats = {
  totalPending: number;
  oldestPendingAt: string | null;
  oldestAgeSeconds: number | null;
  perTopic: { topic: string | null; count: number }[];
};

export class PgOutboxStatsService {
  private readonly uow: PgUnitOfWork;
  constructor(pool: Pool, private readonly outboxTable: string = "eventfabric.outbox", tenantId: string = "default") {
    this.uow = new PgUnitOfWork(pool, tenantId);
  }

  async getBacklogStats(): Promise<OutboxBacklogStats> {
    return this.uow.withTransaction(async (tx) => {
      const main = await tx.client.query(
        `SELECT COUNT(*)::int AS total, MIN(created_at) AS oldest
         FROM ${this.outboxTable}
         WHERE tenant_id = $1 AND dead_lettered_at IS NULL`,
        [tx.tenantId]
      );
      const totalPending = main.rows[0]?.total ?? 0;
      const oldestPendingAt = main.rows[0]?.oldest ? new Date(main.rows[0].oldest).toISOString() : null;
      const oldestAgeSeconds = oldestPendingAt ? Math.floor((Date.now() - Date.parse(oldestPendingAt)) / 1000) : null;

      const topics = await tx.client.query(
        `SELECT topic, COUNT(*)::int AS count
         FROM ${this.outboxTable}
         WHERE tenant_id = $1 AND dead_lettered_at IS NULL
         GROUP BY topic
         ORDER BY count DESC`,
        [tx.tenantId]
      );

      return {
        totalPending,
        oldestPendingAt,
        oldestAgeSeconds,
        perTopic: topics.rows.map((r: any) => ({ topic: r.topic ?? null, count: r.count }))
      };
    });
  }
}
