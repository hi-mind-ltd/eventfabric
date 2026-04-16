import type { Pool } from "pg";
import type {
  QueryBuilder,
  AnyRecord,
  OperatorFor,
  ValueFor,
  SortDirection
} from "@eventfabric/core";

export type PgQueryOptions = {
  /** JSONB column name (e.g. "state"). When set, fluent .where() targets
   *  JSONB path operators instead of flat columns. */
  jsonb?: string;
};

type WhereClause = {
  connector: "AND" | "OR";
  key: string;
  op: string;
  value: unknown;
};

type OrderClause = {
  key: string;
  dir: SortDirection;
};

/**
 * PostgreSQL implementation of the core QueryBuilder interface, plus a
 * Pg-specific `.sql` tagged-template method for raw SQL queries.
 *
 * The two modes (fluent builder vs raw SQL) are mutually exclusive at
 * runtime. Calling `.sql` after `.where` (or vice versa) throws.
 */
export class PgQueryBuilder<T extends AnyRecord> implements QueryBuilder<T> {
  private clauses: WhereClause[] = [];
  private orders: OrderClause[] = [];
  private limitVal: number | null = null;
  private offsetVal: number | null = null;
  private rawSql: string | null = null;
  private rawParams: unknown[] = [];

  constructor(
    private readonly pool: Pool,
    private readonly table: string | null = null,
    private readonly opts: PgQueryOptions = {}
  ) {}

  // --- Core QueryBuilder interface ---

  where<K extends keyof T & string, Op extends OperatorFor<T[K]>>(
    key: K,
    op: Op,
    value: ValueFor<T[K], Op>
  ): this {
    this.assertNotRaw();
    this.clauses.push({ connector: "AND", key, op, value });
    return this;
  }

  orWhere<K extends keyof T & string, Op extends OperatorFor<T[K]>>(
    key: K,
    op: Op,
    value: ValueFor<T[K], Op>
  ): this {
    this.assertNotRaw();
    this.clauses.push({ connector: "OR", key, op, value });
    return this;
  }

  orderBy(key: keyof T & string, direction: SortDirection = "asc"): this {
    this.assertNotRaw();
    this.orders.push({ key, dir: direction });
    return this;
  }

  limit(n: number): this {
    this.assertNotRaw();
    this.limitVal = n;
    return this;
  }

  offset(n: number): this {
    this.assertNotRaw();
    this.offsetVal = n;
    return this;
  }

  async toList(): Promise<T[]> {
    if (this.rawSql !== null) {
      const res = await this.pool.query(this.rawSql, this.rawParams);
      return res.rows as T[];
    }
    const { text, values } = this.buildSelectSql();
    const res = await this.pool.query(text, values);
    return this.unwrapRows(res.rows);
  }

  async first(): Promise<T | null> {
    if (this.rawSql !== null) {
      const wrapped = `SELECT * FROM (${this.rawSql}) AS _q LIMIT 1`;
      const res = await this.pool.query(wrapped, this.rawParams);
      return (res.rows[0] as T) ?? null;
    }
    const saved = this.limitVal;
    this.limitVal = 1;
    const { text, values } = this.buildSelectSql();
    this.limitVal = saved;
    const res = await this.pool.query(text, values);
    const rows = this.unwrapRows(res.rows);
    return rows[0] ?? null;
  }

  async count(): Promise<number> {
    if (this.rawSql !== null) {
      const wrapped = `SELECT COUNT(*)::int AS count FROM (${this.rawSql}) AS _q`;
      const res = await this.pool.query(wrapped, this.rawParams);
      return Number(res.rows[0]?.count ?? 0);
    }
    const { text, values } = this.buildCountSql();
    const res = await this.pool.query(text, values);
    return Number(res.rows[0]?.count ?? 0);
  }

  // --- Pg-specific: raw SQL via tagged template ---

  /**
   * Switch to raw SQL mode. Accepts a tagged template literal — interpolated
   * values become `$1`, `$2`, ... parameters and are NEVER concatenated into
   * the SQL string. SQL injection is structurally impossible.
   *
   * @example
   * query<Result>(pool)
   *   .sql`SELECT a.*, c.name FROM accounts a JOIN customers c ON c.id = a.customer_id WHERE a.balance > ${min}`
   *   .toList();
   */
  sql(strings: TemplateStringsArray, ...values: unknown[]): this {
    if (this.clauses.length > 0 || this.orders.length > 0) {
      throw new Error("Cannot use .sql() after fluent builder methods (.where, .orderBy, etc.)");
    }
    let text = "";
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) {
        text += `$${i + 1}`;
      }
    }
    this.rawSql = text;
    this.rawParams = values;
    return this;
  }

  // --- SQL generation (fluent mode) ---

  private assertNotRaw(): void {
    if (this.rawSql !== null) {
      throw new Error("Cannot use fluent builder methods after .sql()");
    }
    if (!this.table) {
      throw new Error("Table name is required for fluent builder mode. Pass it to query(pool, table).");
    }
  }

  /** In JSONB mode, each row is `{ state: {...} }` — unwrap to just the JSONB content. */
  private unwrapRows(rows: any[]): T[] {
    if (!this.opts.jsonb) return rows as T[];
    const col = this.opts.jsonb;
    return rows.map((r) => r[col] as T);
  }

  private columnRef(key: string): string {
    if (this.opts.jsonb) {
      return `${this.opts.jsonb}->>'${key}'`;
    }
    return key;
  }

  private castForValue(colRef: string, value: unknown): string {
    if (!this.opts.jsonb) return colRef;
    if (typeof value === "number" || typeof value === "bigint") return `(${colRef})::numeric`;
    if (typeof value === "boolean") return `(${colRef})::boolean`;
    return colRef;
  }

  private buildSelectSql(): { text: string; values: unknown[] } {
    // In JSONB mode, select the JSONB column so we can unwrap it to T.
    // In flat mode, select all columns directly.
    const selectExpr = this.opts.jsonb ? `${this.opts.jsonb}` : "*";
    const parts: string[] = [`SELECT ${selectExpr} FROM ${this.table}`];
    const values: unknown[] = [];
    this.appendWhere(parts, values);
    this.appendOrderBy(parts);
    if (this.limitVal !== null) parts.push(`LIMIT ${this.limitVal}`);
    if (this.offsetVal !== null) parts.push(`OFFSET ${this.offsetVal}`);
    return { text: parts.join(" "), values };
  }

  private buildCountSql(): { text: string; values: unknown[] } {
    const parts: string[] = [`SELECT COUNT(*)::int AS count FROM ${this.table}`];
    const values: unknown[] = [];
    this.appendWhere(parts, values);
    return { text: parts.join(" "), values };
  }

  private appendWhere(parts: string[], values: unknown[]): void {
    if (this.clauses.length === 0) return;

    const conditions: string[] = [];
    for (const clause of this.clauses) {
      const col = this.columnRef(clause.key);
      const castCol = this.castForValue(col, clause.value);

      let condition: string;
      if (clause.op === "IN" || clause.op === "NOT IN") {
        const paramIdx = values.length + 1;
        values.push(clause.value);
        condition = clause.op === "IN"
          ? `${castCol} = ANY($${paramIdx})`
          : `${castCol} != ALL($${paramIdx})`;
      } else if (clause.op === "IS" || clause.op === "IS NOT") {
        condition = `${castCol} ${clause.op} NULL`;
      } else {
        const paramIdx = values.length + 1;
        values.push(clause.value);
        condition = `${castCol} ${clause.op} $${paramIdx}`;
      }

      if (conditions.length === 0) {
        conditions.push(condition);
      } else {
        conditions.push(`${clause.connector} ${condition}`);
      }
    }

    parts.push(`WHERE ${conditions.join(" ")}`);
  }

  private appendOrderBy(parts: string[]): void {
    if (this.orders.length === 0) return;
    const orderParts = this.orders.map((o) => {
      // In JSONB mode, use -> (returns JSONB) instead of ->> (returns text)
      // for ORDER BY. JSONB preserves native numeric/boolean sort order,
      // while ->> casts everything to text (lexicographic, breaks numbers).
      const col = this.opts.jsonb
        ? `${this.opts.jsonb}->'${o.key}'`
        : o.key;
      return `${col} ${o.dir.toUpperCase()}`;
    });
    parts.push(`ORDER BY ${orderParts.join(", ")}`);
  }
}

/**
 * Entry point for building a query. Two modes:
 *
 * - `query<T>(pool, "table_name")` — fluent builder for single-table queries
 * - `query<T>(pool)` — raw SQL only (call `.sql\`...\`` next)
 */
export function query<T extends AnyRecord>(
  pool: Pool,
  table?: string,
  opts?: PgQueryOptions
): PgQueryBuilder<T> {
  return new PgQueryBuilder<T>(pool, table ?? null, opts);
}
