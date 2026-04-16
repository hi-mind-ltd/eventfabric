/**
 * Database-agnostic query builder interface.
 *
 * Each database adapter (@eventfabric/postgres, a future @eventfabric/mongodb,
 * etc.) implements this interface, translating the fluent API into the
 * target database's query language. Adapter-specific extensions (like raw
 * SQL tagged templates for Postgres) live on the concrete class, not here.
 */

export type AnyRecord = Record<string, unknown>;

// --- Operator type mapping ---

type NumericOperator = "=" | "!=" | ">" | ">=" | "<" | "<=";
type StringOperator = "=" | "!=" | "LIKE" | "ILIKE";
type BooleanOperator = "=" | "!=";
type ArrayOperator = "IN" | "NOT IN";
type NullOperator = "IS" | "IS NOT";

/**
 * Constrains the set of legal comparison operators based on the property's
 * TypeScript type. Numbers get arithmetic comparisons; strings get LIKE;
 * booleans only get equality.
 */
export type OperatorFor<V> =
  V extends number | bigint ? NumericOperator | ArrayOperator | NullOperator :
  V extends string ? StringOperator | ArrayOperator | NullOperator :
  V extends boolean ? BooleanOperator | NullOperator :
  "=" | "!=";

/**
 * Constrains the value type based on the chosen operator. IN/NOT IN require
 * an array; IS/IS NOT require null; everything else takes the field type.
 */
export type ValueFor<V, Op extends string> =
  Op extends "IN" | "NOT IN" ? V[] :
  Op extends "IS" | "IS NOT" ? null :
  V;

export type SortDirection = "asc" | "desc";

/**
 * Database-agnostic query builder. Implementations translate these calls
 * into the target database's query language (SQL, MongoDB filter, etc.).
 *
 * All methods return `this` for chaining. Terminal methods (toList, first,
 * count) execute the query and return results typed as `T`.
 */
export interface QueryBuilder<T extends AnyRecord> {
  where<K extends keyof T & string, Op extends OperatorFor<T[K]>>(
    key: K,
    op: Op,
    value: ValueFor<T[K], Op>
  ): this;

  orWhere<K extends keyof T & string, Op extends OperatorFor<T[K]>>(
    key: K,
    op: Op,
    value: ValueFor<T[K], Op>
  ): this;

  orderBy(key: keyof T & string, direction?: SortDirection): this;

  limit(n: number): this;

  offset(n: number): this;

  /** Execute the query and return all matching rows. */
  toList(): Promise<T[]>;

  /** Execute the query and return the first matching row, or null. */
  first(): Promise<T | null>;

  /** Execute the query and return the count of matching rows. */
  count(): Promise<number>;
}
