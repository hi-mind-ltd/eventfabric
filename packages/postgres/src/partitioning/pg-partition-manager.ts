import type { Pool } from "pg";

export type PartitionInfo = {
  name: string;
  from: bigint;
  to: bigint;
  rowEstimate: number;
};

/**
 * Manages range partitioning of the events table by global_position.
 *
 * Partitioning enables:
 * - Archival: detach old partitions and move to cold storage
 * - Faster vacuuming: each partition is vacuumed independently
 * - Bulk deletes: drop a partition instead of DELETE (instant, no dead tuples)
 * - Parallel query: Postgres scans partitions concurrently
 *
 * Prerequisites:
 * - Migration 005 (stream_versions) must be applied
 * - Migration 007 (drop UNIQUE constraints) must be applied
 */
export class PgPartitionManager {
  private readonly qualifiedTable: string;

  constructor(
    private readonly schema: string = "eventfabric",
    private readonly table: string = "events"
  ) {
    this.qualifiedTable = `${schema}.${table}`;
  }

  /**
   * Converts the events table from a regular table to a range-partitioned table.
   * This is a one-time operation that:
   *
   * 1. Renames the existing table as the first partition
   * 2. Creates a new partitioned parent table (reusing the existing sequence)
   * 3. Attaches the old table as the first partition
   * 4. Creates the next empty partition for new writes
   * 5. Re-creates indexes on the parent (propagated to all partitions)
   *
   * Takes an ACCESS EXCLUSIVE lock on the table for the duration.
   * No-op if the table is already partitioned.
   */
  async enablePartitioning(pool: Pool, opts?: { partitionSize?: bigint }): Promise<void> {
    const partitionSize = opts?.partitionSize ?? 1_000_000n;

    if (await this.isPartitioned(pool)) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`LOCK TABLE ${this.qualifiedTable} IN ACCESS EXCLUSIVE MODE`);

      const seqName = await this.getSequenceName(client);
      const maxPos = await this.getMaxPosition(client);

      const boundary = maxPos === 0n
        ? partitionSize
        : ((maxPos / partitionSize) + 1n) * partitionSize;

      const firstPartName = `${this.table}_p0`;
      const nextPartName = `${this.table}_p1`;

      // Rename existing table → first partition
      await client.query(`ALTER TABLE ${this.qualifiedTable} RENAME TO ${firstPartName}`);

      // Create partitioned parent using the existing sequence
      await client.query(`
        CREATE TABLE ${this.qualifiedTable} (
          global_position BIGINT NOT NULL DEFAULT nextval('${seqName}'::regclass),
          event_id UUID NOT NULL,
          aggregate_name TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          aggregate_version INT NOT NULL,
          type TEXT NOT NULL,
          version INT NOT NULL,
          payload JSONB NOT NULL,
          occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          dismissed_at TIMESTAMPTZ NULL,
          dismissed_reason TEXT NULL,
          dismissed_by TEXT NULL,
          correlation_id TEXT NULL,
          causation_id TEXT NULL,
          PRIMARY KEY (global_position)
        ) PARTITION BY RANGE (global_position)
      `);

      // Attach old table as first partition (Postgres validates all rows fit the range)
      await client.query(`
        ALTER TABLE ${this.qualifiedTable}
          ATTACH PARTITION ${this.schema}.${firstPartName}
          FOR VALUES FROM (MINVALUE) TO (${boundary})
      `);

      // Create next partition for new writes
      await client.query(`
        CREATE TABLE ${this.schema}.${nextPartName}
          PARTITION OF ${this.qualifiedTable}
          FOR VALUES FROM (${boundary}) TO (${boundary + partitionSize})
      `);

      // Re-create indexes on the parent (automatically created on all partitions)
      await client.query(`
        CREATE INDEX IF NOT EXISTS events_global_idx
          ON ${this.qualifiedTable} (global_position)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS events_stream_covering_idx
          ON ${this.qualifiedTable} (aggregate_name, aggregate_id, aggregate_version)
          INCLUDE (event_id, type, version, payload, occurred_at,
                   dismissed_at, dismissed_reason, dismissed_by,
                   correlation_id, causation_id)
      `);

      // Reassign sequence ownership to the partitioned table
      await client.query(`
        ALTER SEQUENCE ${seqName} OWNED BY ${this.qualifiedTable}.global_position
      `);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Creates a new partition for the given global_position range.
   * Use this to pre-create partitions before the current one fills up.
   */
  async createPartition(pool: Pool, from: bigint, to: bigint): Promise<string> {
    const name = this.assertSafeIdentifier(`${this.table}_p_${from}_${to}`, "partition name");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.${name}
        PARTITION OF ${this.qualifiedTable}
        FOR VALUES FROM (${from}) TO (${to})
    `);
    return `${this.schema}.${name}`;
  }

  /**
   * Detaches a partition from the parent table. The partition becomes a
   * standalone table that can be archived, moved to cold storage, or dropped.
   */
  async detachPartition(pool: Pool, partitionName: string): Promise<void> {
    const safePartitionName = this.assertSafeIdentifier(partitionName, "partition name");
    await pool.query(`
      ALTER TABLE ${this.qualifiedTable}
        DETACH PARTITION ${this.schema}.${safePartitionName}
    `);
  }

  /** Lists all current partitions with their ranges and estimated row counts. */
  async listPartitions(pool: Pool): Promise<PartitionInfo[]> {
    const res = await pool.query(`
      SELECT
        c.relname AS name,
        pg_get_expr(c.relpartbound, c.oid) AS bounds,
        c.reltuples::bigint AS row_estimate
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE p.relname = $1 AND n.nspname = $2
      ORDER BY c.relname
    `, [this.table, this.schema]);

    return res.rows.map((r: any) => {
      const bounds = r.bounds as string;
      const fromMatch = bounds.match(/FROM \('?(\d+)'?\)/);
      const toMatch = bounds.match(/TO \('?(\d+)'?\)/);
      return {
        name: r.name as string,
        from: fromMatch?.[1] ? BigInt(fromMatch[1]) : 0n,
        to: toMatch?.[1] ? BigInt(toMatch[1]) : 0n,
        rowEstimate: Number(r.row_estimate)
      };
    });
  }

  /** Returns true if the events table is already partitioned. */
  async isPartitioned(pool: Pool): Promise<boolean> {
    const res = await pool.query(`
      SELECT c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND n.nspname = $2
    `, [this.table, this.schema]);
    return res.rows[0]?.relkind === "p";
  }

  /** Returns the current max global_position (or the next sequence value if empty). */
  async getCurrentPosition(pool: Pool): Promise<bigint> {
    return this.getMaxPosition(pool);
  }

  private async getSequenceName(client: { query: Pool["query"] }): Promise<string> {
    const res = await client.query(
      `SELECT pg_get_serial_sequence($1, 'global_position') AS seq`,
      [this.qualifiedTable]
    );
    const seq = res.rows[0]?.seq;
    if (!seq) throw new Error(`No sequence found for ${this.qualifiedTable}.global_position`);
    return seq;
  }

  private async getMaxPosition(client: { query: Pool["query"] }): Promise<bigint> {
    const res = await client.query(
      `SELECT COALESCE(MAX(global_position), 0)::bigint AS max_pos FROM ${this.qualifiedTable}`
    );
    return BigInt(res.rows[0].max_pos);
  }

  private assertSafeIdentifier(value: string, label: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
    return value;
  }
}
