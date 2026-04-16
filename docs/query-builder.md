# Query Builder

EventFabric includes a lightweight, type-safe query builder for reading from projection tables and snapshot stores. The core package defines a database-agnostic `QueryBuilder<T>` interface; the `@eventfabric/postgres` package provides `PgQueryBuilder<T>` with a Postgres-specific `.sql` tagged template for raw SQL.

## Core interface

```typescript
// @eventfabric/core

export interface QueryBuilder<T extends AnyRecord> {
  where<K extends keyof T & string, Op extends OperatorFor<T[K]>>(
    key: K, op: Op, value: ValueFor<T[K], Op>
  ): this;

  orWhere<K extends keyof T & string, Op extends OperatorFor<T[K]>>(
    key: K, op: Op, value: ValueFor<T[K], Op>
  ): this;

  orderBy(key: keyof T & string, direction?: SortDirection): this;

  limit(n: number): this;

  offset(n: number): this;

  toList(): Promise<T[]>;
  first(): Promise<T | null>;
  count(): Promise<number>;
}
```

The interface is database-agnostic. Adapters for PostgreSQL, MongoDB, or other databases implement it and translate the fluent calls into the target query language.

## PgQueryBuilder

The PostgreSQL implementation lives in `@eventfabric/postgres`:

```typescript
import { PgQueryBuilder, query } from "@eventfabric/postgres";
```

### `query<T>(pool, table?, opts?)` factory

The entry point for building a query. Two modes:

```typescript
// Mode 1: Fluent builder for single-table queries
query<AccountReadModel>(pool, "account_read")
  .where("balance", ">=", 1000)
  .orderBy("balance", "desc")
  .limit(20)
  .toList();

// Mode 2: Raw SQL only (call .sql`...` next)
query<Result>(pool)
  .sql`SELECT * FROM accounts WHERE balance > ${minBalance}`
  .toList();
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `pool` | `Pool` | A `pg.Pool` instance. |
| `table` | `string` (optional) | Table name for fluent mode. Required if you call `.where()`, `.orderBy()`, etc. |
| `opts` | `PgQueryOptions` (optional) | Options like `{ jsonb: "state" }` for JSONB mode. See below. |

## Fluent builder API

### `.where(key, op, value)`

Adds an `AND` condition. The first `.where()` starts the `WHERE` clause; subsequent calls chain with `AND`.

```typescript
query<AccountReadModel>(pool, "account_read")
  .where("balance", ">=", 1000)
  .where("currency", "=", "USD")
  // WHERE balance >= $1 AND currency = $2
```

### `.orWhere(key, op, value)`

Adds an `OR` condition.

```typescript
query<AccountReadModel>(pool, "account_read")
  .where("currency", "=", "USD")
  .orWhere("currency", "=", "EUR")
  // WHERE currency = $1 OR currency = $2
```

### `.orderBy(key, direction?)`

Adds an `ORDER BY` clause. Direction defaults to `"asc"`. Call multiple times for multi-column sort.

```typescript
query<AccountReadModel>(pool, "account_read")
  .orderBy("balance", "desc")
  .orderBy("account_id", "asc")
  // ORDER BY balance DESC, account_id ASC
```

### `.limit(n)` / `.offset(n)`

Standard pagination.

```typescript
query<AccountReadModel>(pool, "account_read")
  .where("balance", ">=", 0)
  .orderBy("balance", "desc")
  .limit(20)
  .offset(40)
  // LIMIT 20 OFFSET 40
```

## Type-safe operator constraints

### `OperatorFor<V>`

Constrains the set of legal comparison operators based on the property's TypeScript type:

```typescript
export type OperatorFor<V> =
  V extends number | bigint ? "=" | "!=" | ">" | ">=" | "<" | "<=" | "IN" | "NOT IN" | "IS" | "IS NOT" :
  V extends string          ? "=" | "!=" | "LIKE" | "ILIKE" | "IN" | "NOT IN" | "IS" | "IS NOT" :
  V extends boolean         ? "=" | "!=" | "IS" | "IS NOT" :
  "=" | "!=";
```

This means TypeScript catches invalid operators at compile time:

```typescript
type AccountReadModel = {
  account_id: string;
  balance: number;
  currency: string;
};

query<AccountReadModel>(pool, "account_read")
  .where("balance", ">", 100)        // OK: number supports >
  .where("currency", "ILIKE", "%usd%") // OK: string supports ILIKE
  .where("balance", "ILIKE", "%foo%")  // ERROR: number doesn't support ILIKE
```

### `ValueFor<V, Op>`

Constrains the value type based on the chosen operator:

```typescript
export type ValueFor<V, Op extends string> =
  Op extends "IN" | "NOT IN" ? V[] :
  Op extends "IS" | "IS NOT" ? null :
  V;
```

- `IN` / `NOT IN` require an array of the field type.
- `IS` / `IS NOT` require `null`.
- All other operators require the field type directly.

```typescript
query<AccountReadModel>(pool, "account_read")
  .where("currency", "IN", ["USD", "EUR", "GBP"])   // OK: string[]
  .where("balance", "IS", null)                       // OK: null check
  .where("currency", "IN", "USD")                     // ERROR: needs string[]
```

## Terminal methods

### `.toList(): Promise<T[]>`

Executes the query and returns all matching rows.

### `.first(): Promise<T | null>`

Executes the query with `LIMIT 1` and returns the first row, or `null` if no rows match.

### `.count(): Promise<number>`

Executes `SELECT COUNT(*)::int AS count` with the same `WHERE` clause and returns the count.

## Raw SQL via `.sql` tagged template

For queries that need joins, subqueries, CTEs, or any SQL that the fluent builder can't express, use the `.sql` tagged template:

```typescript
type AccountWithCustomer = {
  account_id: string;
  balance: number;
  currency: string;
  customer_id: string;
  customer_name: string;
};

const accounts = await query<AccountWithCustomer>(pool)
  .sql`
    SELECT a.account_id, a.balance, a.currency,
           a.customer_id, c.name AS customer_name
    FROM account_read a
    LEFT JOIN customer_read c ON c.id = a.customer_id
    WHERE a.balance >= ${minBalance}
    ORDER BY a.balance DESC
  `
  .toList();
```

Note that `query<T>(pool)` is called **without a table name** -- in raw SQL mode, the table comes from the SQL string itself.

### SQL injection protection

The `.sql` method uses a **tagged template literal**. This is structurally safe against SQL injection because of how JavaScript tagged templates work:

```typescript
sql(strings: TemplateStringsArray, ...values: unknown[]): this {
  let text = "";
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      text += `$${i + 1}`;  // placeholder, not the value
    }
  }
  this.rawSql = text;
  this.rawParams = values;  // values passed separately to pg
  return this;
}
```

When you write:

```typescript
.sql`SELECT * FROM users WHERE name = ${userInput} AND age > ${age}`
```

JavaScript calls the `sql` function with:

- `strings`: `["SELECT * FROM users WHERE name = ", " AND age > ", ""]`
- `values`: `[userInput, age]`

The function replaces each interpolated value with a `$N` placeholder and passes the values array separately to `pg`. The interpolated values **never** become part of the SQL string. They are always sent as parameters.

This means even deliberately malicious input is safe:

```typescript
const evil = "'; DROP TABLE users; --";
const result = await query<User>(pool)
  .sql`SELECT * FROM users WHERE name = ${evil}`
  .toList();

// Generates: SELECT * FROM users WHERE name = $1
// Parameters: ["'; DROP TABLE users; --"]
// pg sends the value as a parameter, not as SQL text.
// The DROP TABLE never executes.
```

SQL injection is **structurally impossible** because the template literal syntax guarantees that user-provided values never touch the SQL string.

## JSONB mode

For snapshot queries, enable JSONB mode by passing `{ jsonb: "state" }`:

```typescript
type AccountState = {
  customerId: string;
  balance: number;
  currency: string;
  region: string;
  isClosed: boolean;
};

const results = await query<AccountState>(pool, "eventfabric.snapshots", { jsonb: "state" })
  .where("balance", ">=", 1000)
  .orderBy("balance", "desc")
  .limit(10)
  .toList();
```

In JSONB mode:

- **`SELECT`** selects the JSONB column (`state`), and the builder unwraps it so you get `T` directly.
- **`WHERE`** uses JSONB path operators: `state->>'balance'` instead of `balance`. Numeric comparisons cast to `::numeric`, boolean to `::boolean`.
- **`ORDER BY`** uses `state->'key'` (with `->`, not `->>`) to preserve native JSONB sort order. The `->>` operator returns text, which sorts lexicographically and breaks numeric ordering. The `->` operator returns JSONB, which preserves numeric/boolean sort order.

### JSONB ORDER BY: `->` vs `->>`

This is a subtle PostgreSQL behavior:

| Operator | Returns | Sort order | Example |
|----------|---------|------------|---------|
| `->` | `jsonb` | Native (numeric for numbers) | `state->'balance'` sorts 9 < 10 < 100 |
| `->>` | `text` | Lexicographic | `state->>'balance'` sorts "10" < "100" < "9" |

EventFabric's JSONB mode uses `->` for `ORDER BY` and `->>` for `WHERE`, ensuring correct sort order for numeric fields.

## Mutual exclusion: fluent vs raw SQL

The fluent builder and raw SQL modes are **mutually exclusive** at runtime:

```typescript
// This throws at runtime:
query<T>(pool, "table")
  .where("id", "=", 1)
  .sql`SELECT * FROM table`  // ERROR: Cannot use .sql() after fluent builder methods

// This also throws:
query<T>(pool)
  .sql`SELECT * FROM table`
  .where("id", "=", 1)       // ERROR: Cannot use fluent builder methods after .sql()
```

This prevents accidental mixing of two incompatible query construction approaches.

## When to use QueryBuilder vs a full ORM

EventFabric's query builder is intentionally minimal. It covers the common cases for read-model queries without adding a heavy ORM dependency.

| Need | QueryBuilder | Full ORM (Drizzle/Kysely/Prisma) |
|------|-------------|----------------------------------|
| Simple single-table queries with type-safe filters | Yes | Overkill |
| Joins, subqueries, CTEs | Use `.sql` tagged template | Yes |
| Schema migrations | No | Yes |
| Relation mapping, lazy loading | No | Yes |
| Works with existing `pg.Pool` | Yes | Depends on adapter |
| JSONB snapshot queries | Yes (built-in) | Needs manual setup |
| Zero additional dependencies | Yes | No |

**Use the query builder** for read-model queries against projection tables and snapshot stores. These are typically simple single-table queries or occasional joins that `.sql` handles well.

**Use a full ORM** when your application has complex relational needs beyond event sourcing read models -- e.g., a large CRUD surface, complex migrations, or cross-database support.

The two are not mutually exclusive. You can use EventFabric's query builder for event-sourcing-related queries and Drizzle/Kysely/Prisma for everything else, all sharing the same `pg.Pool`.

## Full examples from banking-api

### `/accounts/search` -- fluent builder

```typescript
type AccountReadModel = {
  account_id: string;
  customer_id: string;
  balance: number;
  currency: string;
  updated_at: string;
};

app.get("/accounts/search", async (req, res) => {
  const minBalance = Number(req.query.min_balance ?? 0);
  const currency = req.query.currency as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const offset = Number(req.query.offset ?? 0);

  let qb = query<AccountReadModel>(pool, "account_read")
    .where("balance", ">=", minBalance);

  if (currency) {
    qb = qb.where("currency", "=", currency);
  }

  const accounts = await qb
    .orderBy("balance", "desc")
    .limit(limit)
    .offset(offset)
    .toList();

  const total = await query<AccountReadModel>(pool, "account_read")
    .where("balance", ">=", minBalance)
    .count();

  res.json({ accounts, total, limit, offset });
});
```

### `/accounts/with-customers` -- raw SQL join

```typescript
app.get("/accounts/with-customers", async (req, res) => {
  const minBalance = Number(req.query.min_balance ?? 0);

  type AccountWithCustomer = {
    account_id: string;
    balance: number;
    currency: string;
    customer_id: string;
    customer_name: string;
  };

  const accounts = await query<AccountWithCustomer>(pool)
    .sql`
      SELECT a.account_id, a.balance, a.currency,
             a.customer_id, c.name AS customer_name
      FROM account_read a
      LEFT JOIN customer_read c ON c.id = a.customer_id
      WHERE a.balance >= ${minBalance}
      ORDER BY a.balance DESC
    `
    .toList();

  res.json({ accounts });
});
```

## Related docs

- [Inline Projections](./projections/inline-projections.md) -- building the read model tables that QueryBuilder queries
- [Projections Overview](./projections/overview.md) -- how read models fit into the projection tiers
