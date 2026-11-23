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

const OPERATORS: ReadonlySet<string> = new Set([
  "=", "!=", ">", ">=", "<", "<=", "LIKE", "ILIKE", "IN", "NOT IN", "IS", "IS NOT",
]);

/** Unquoted SQL identifier. Anything else is rejected rather than escaped. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertColumn(key: string): void {
  if (typeof key !== "string" || !IDENTIFIER.test(key)) {
    throw new Error(`Invalid column name for query builder: ${JSON.stringify(key)}`);
  }
}

function assertCount(name: string, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${String(n)}`);
  }
}

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
    this.assertClause(key, op);
    this.clauses.push({ connector: "AND", key, op, value });
    return this;
  }

  orWhere<K extends keyof T & string, Op extends OperatorFor<T[K]>>(
    key: K,
    op: Op,
    value: ValueFor<T[K], Op>
  ): this {
    this.assertNotRaw();
    this.assertClause(key, op);
    this.clauses.push({ connector: "OR", key, op, value });
    return this;
  }

  orderBy(key: keyof T & string, direction: SortDirection = "asc"): this {
    this.assertNotRaw();
    if (!this.opts.jsonb) assertColumn(key);
    if (direction !== "asc" && direction !== "desc") {
      throw new Error(`Invalid sort direction: ${JSON.stringify(direction)}`);
    }
    this.orders.push({ key, dir: direction });
    return this;
  }

  limit(n: number): this {
    this.assertNotRaw();
    assertCount("limit", n);
    this.limitVal = n;
    return this;
  }

  offset(n: number): this {
    this.assertNotRaw();
    assertCount("offset", n);
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

  /**
   * Keys and operators are typed at compile time, but at runtime they often
   * come from request input (`?sort=`, filter forms), so they are checked here.
   * JSONB keys are sent as parameters; flat column names must be plain
   * identifiers.
   */
  private assertClause(key: string, op: string): void {
    if (!OPERATORS.has(op)) {
      throw new Error(`Invalid query operator: ${JSON.stringify(op)}`);
    }
    if (!this.opts.jsonb) assertColumn(key);
  }

  /** In JSONB mode, each row is `{ state: {...} }` — unwrap to just the JSONB content. */
  private unwrapRows(rows: any[]): T[] {
    if (!this.opts.jsonb) return rows as T[];
    const col = this.opts.jsonb;
    return rows.map((r) => r[col] as T);
  }

  private columnRef(key: string, values: unknown[], arrow: "->>" | "->" = "->>"): string {
    if (this.opts.jsonb) {
      values.push(key);
      return `${this.opts.jsonb}${arrow}$${values.length}::text`;
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
    this.appendOrderBy(parts, values);
    if (this.limitVal !== null) {
      values.push(this.limitVal);
      parts.push(`LIMIT $${values.length}`);
    }
    if (this.offsetVal !== null) {
      values.push(this.offsetVal);
      parts.push(`OFFSET $${values.length}`);
    }
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
      const col = this.columnRef(clause.key, values);
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

  private appendOrderBy(parts: string[], values: unknown[]): void {
    if (this.orders.length === 0) return;
    const orderParts = this.orders.map((o) => {
      // In JSONB mode, use -> (returns JSONB) instead of ->> (returns text)
      // for ORDER BY. JSONB preserves native numeric/boolean sort order,
      // while ->> casts everything to text (lexicographic, breaks numbers).
      const col = this.columnRef(o.key, values, "->");
      return `${col} ${o.dir === "desc" ? "DESC" : "ASC"}`;
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
