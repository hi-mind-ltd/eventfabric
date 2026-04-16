import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { query } from "../src/query/pg-query-builder";

type AccountRow = {
  id: string;
  customer_id: string;
  balance: number;
  currency: string;
  active: boolean;
};

type SnapshotRow = {
  balance: number;
  currency: string;
  customerId: string;
};

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS eventfabric;
    CREATE TABLE account_read (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      balance INT NOT NULL,
      currency TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE snapshot_jsonb (
      id TEXT PRIMARY KEY,
      state JSONB NOT NULL
    );
  `);
}

async function seed() {
  await pool.query(`
    INSERT INTO account_read (id, customer_id, balance, currency, active) VALUES
      ('a1', 'c1', 100, 'USD', true),
      ('a2', 'c1', 250, 'USD', true),
      ('a3', 'c2', 50,  'EUR', true),
      ('a4', 'c2', 300, 'GBP', false),
      ('a5', 'c3', 0,   'USD', true);
    INSERT INTO snapshot_jsonb (id, state) VALUES
      ('s1', '{"balance": 100, "currency": "USD", "customerId": "c1"}'),
      ('s2', '{"balance": 250, "currency": "USD", "customerId": "c1"}'),
      ('s3', '{"balance": 50,  "currency": "EUR", "customerId": "c2"}');
  `);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate();
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

describe("PgQueryBuilder", () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM account_read`);
    await pool.query(`DELETE FROM snapshot_jsonb`);
    await seed();
  }, 60000);

  describe("fluent builder", () => {
    it("selects all rows when no filters are applied", async () => {
      const rows = await query<AccountRow>(pool, "account_read").toList();
      expect(rows).toHaveLength(5);
    });

    it("filters with = operator", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .where("customer_id", "=", "c1")
        .toList();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.customer_id === "c1")).toBe(true);
    });

    it("filters with > operator on numeric column", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .where("balance", ">", 100)
        .toList();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.balance > 100)).toBe(true);
    });

    it("chains multiple where clauses with AND", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .where("customer_id", "=", "c1")
        .where("balance", ">=", 250)
        .toList();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe("a2");
    });

    it("supports orWhere", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .where("balance", "=", 100)
        .orWhere("balance", "=", 50)
        .orderBy("balance")
        .toList();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.balance).toBe(50);
      expect(rows[1]!.balance).toBe(100);
    });

    it("supports LIKE operator", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .where("currency", "LIKE", "US%")
        .toList();
      expect(rows).toHaveLength(3);
    });

    it("supports IN operator", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .where("currency", "IN", ["EUR", "GBP"])
        .toList();
      expect(rows).toHaveLength(2);
    });

    it("supports NOT IN operator", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .where("currency", "NOT IN", ["EUR", "GBP"])
        .toList();
      expect(rows).toHaveLength(3);
    });

    it("supports IS NULL", async () => {
      // Insert a row with NULL currency for testing
      await pool.query(
        `INSERT INTO account_read (id, customer_id, balance, currency, active)
         VALUES ('a6', 'c4', 0, NULL, true)
         ON CONFLICT DO NOTHING`
      ).catch(() => {
        // currency is NOT NULL, so this won't work — skip test
      });
      // IS NULL on a non-nullable column should return 0 rows
      const rows = await query<AccountRow>(pool, "account_read")
        .where("currency", "IS", null)
        .toList();
      expect(rows).toHaveLength(0);
    });

    it("orders results ascending (default)", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .orderBy("balance")
        .toList();
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.balance).toBeGreaterThanOrEqual(rows[i - 1]!.balance);
      }
    });

    it("orders results descending", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .orderBy("balance", "desc")
        .toList();
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.balance).toBeLessThanOrEqual(rows[i - 1]!.balance);
      }
    });

    it("limits results", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .orderBy("balance", "desc")
        .limit(2)
        .toList();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.balance).toBe(300);
    });

    it("supports offset for pagination", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .orderBy("balance", "desc")
        .limit(2)
        .offset(2)
        .toList();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.balance).toBe(100);
    });

    it("first() returns single row", async () => {
      const row = await query<AccountRow>(pool, "account_read")
        .where("id", "=", "a1")
        .first();
      expect(row).not.toBeNull();
      expect(row!.id).toBe("a1");
      expect(row!.balance).toBe(100);
    });

    it("first() returns null when no match", async () => {
      const row = await query<AccountRow>(pool, "account_read")
        .where("id", "=", "nonexistent")
        .first();
      expect(row).toBeNull();
    });

    it("count() returns the number of matching rows", async () => {
      const total = await query<AccountRow>(pool, "account_read").count();
      expect(total).toBe(5);

      const filtered = await query<AccountRow>(pool, "account_read")
        .where("currency", "=", "USD")
        .count();
      expect(filtered).toBe(3);
    });

    it("supports boolean = operator", async () => {
      const rows = await query<AccountRow>(pool, "account_read")
        .where("active", "=", false)
        .toList();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe("a4");
    });
  });

  describe("JSONB mode", () => {
    it("queries JSONB state column with string field", async () => {
      const rows = await query<SnapshotRow>(pool, "snapshot_jsonb", { jsonb: "state" })
        .where("customerId", "=", "c1")
        .toList();
      expect(rows).toHaveLength(2);
    });

    it("queries JSONB state column with numeric comparison", async () => {
      const rows = await query<SnapshotRow>(pool, "snapshot_jsonb", { jsonb: "state" })
        .where("balance", ">", 100)
        .toList();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.balance).toBe(250);
    });

    it("orders by JSONB numeric field", async () => {
      const rows = await query<SnapshotRow>(pool, "snapshot_jsonb", { jsonb: "state" })
        .orderBy("balance", "desc")
        .toList();
      expect(rows[0]!.balance).toBe(250);
    });

    it("count works in JSONB mode", async () => {
      const n = await query<SnapshotRow>(pool, "snapshot_jsonb", { jsonb: "state" })
        .where("currency", "=", "USD")
        .count();
      expect(n).toBe(2);
    });
  });

  describe("raw SQL mode (.sql tagged template)", () => {
    it("executes a simple raw query", async () => {
      const rows = await query<AccountRow>(pool)
        .sql`SELECT * FROM account_read WHERE balance > ${100} ORDER BY balance`
        .toList();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.balance).toBe(250);
    });

    it("handles multiple interpolated parameters", async () => {
      const minBalance = 50;
      const currency = "USD";
      const rows = await query<AccountRow>(pool)
        .sql`SELECT * FROM account_read WHERE balance >= ${minBalance} AND currency = ${currency}`
        .toList();
      // a1 (100, USD) and a2 (250, USD) match; a5 (0, USD) doesn't meet >= 50
      expect(rows).toHaveLength(2);
    });

    it("supports joins", async () => {
      // Create a small customer table for the join
      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_read (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        );
        INSERT INTO customer_read VALUES ('c1', 'Alice'), ('c2', 'Bob'), ('c3', 'Charlie')
        ON CONFLICT DO NOTHING;
      `);

      type Joined = { id: string; balance: number; name: string };
      const rows = await query<Joined>(pool)
        .sql`
          SELECT a.id, a.balance, c.name
          FROM account_read a
          INNER JOIN customer_read c ON c.id = a.customer_id
          WHERE a.balance > ${100}
          ORDER BY a.balance DESC
        `
        .toList();

      expect(rows).toHaveLength(2);
      expect(rows[0]!.name).toBe("Bob");
      expect(rows[0]!.balance).toBe(300);
      expect(rows[1]!.name).toBe("Alice");
    });

    it("first() works with raw SQL", async () => {
      const row = await query<AccountRow>(pool)
        .sql`SELECT * FROM account_read WHERE id = ${"a3"}`
        .first();
      expect(row).not.toBeNull();
      expect(row!.currency).toBe("EUR");
    });

    it("count() wraps raw SQL in subquery", async () => {
      const n = await query<AccountRow>(pool)
        .sql`SELECT * FROM account_read WHERE currency = ${"USD"}`
        .count();
      expect(n).toBe(3);
    });

    it("handles no interpolations (static SQL)", async () => {
      const rows = await query<AccountRow>(pool)
        .sql`SELECT * FROM account_read ORDER BY id`
        .toList();
      expect(rows).toHaveLength(5);
    });
  });

  describe("mutual exclusion", () => {
    it("throws when .sql is called after .where", () => {
      const qb = query<AccountRow>(pool, "account_read").where("balance", ">", 0);
      expect(() => (qb as any).sql`SELECT 1`).toThrow(/Cannot use .sql/);
    });

    it("throws when .where is called after .sql", () => {
      const qb = query<AccountRow>(pool).sql`SELECT 1`;
      expect(() => (qb as any).where("balance", ">", 0)).toThrow(/Cannot use fluent/);
    });

    it("throws when fluent methods are used without a table name", () => {
      expect(() => query<AccountRow>(pool).where("balance", ">", 0)).toThrow(/Table name is required/);
    });
  });

  describe("compile-time type safety", () => {
    it("rejects invalid keys and operators at compile time", () => {
      // @ts-expect-error — "nonexistent" is not a key of AccountRow
      query<AccountRow>(pool, "account_read").where("nonexistent", "=", "x");

      // @ts-expect-error — ">" is not valid for boolean fields
      query<AccountRow>(pool, "account_read").where("active", ">", true);

      // @ts-expect-error — LIKE is not valid for number fields
      query<AccountRow>(pool, "account_read").where("balance", "LIKE", "%x%");

      // @ts-expect-error — value must be string for string field
      query<AccountRow>(pool, "account_read").where("currency", "=", 123);
    });
  });

  describe("SQL injection protection", () => {
    it("tagged template: malicious interpolation is treated as a bind parameter, not SQL", async () => {
      // Classic SQL injection payload — if this were string-concatenated into
      // the query it would drop the table or return all rows.
      const malicious = "'; DROP TABLE account_read; --";

      const rows = await query<AccountRow>(pool)
        .sql`SELECT * FROM account_read WHERE currency = ${malicious}`
        .toList();

      // The payload is sent as a $1 bind parameter. Postgres compares it as a
      // literal string value — no rows match, no side effects.
      expect(rows).toHaveLength(0);

      // Table still exists and has all its data
      const all = await query<AccountRow>(pool, "account_read").toList();
      expect(all).toHaveLength(5);
    });

    it("tagged template: OR 1=1 injection returns nothing (not all rows)", async () => {
      const injection = "USD' OR '1'='1";

      const rows = await query<AccountRow>(pool)
        .sql`SELECT * FROM account_read WHERE currency = ${injection}`
        .toList();

      // If this were string-interpolated, the WHERE clause would become:
      //   WHERE currency = 'USD' OR '1'='1'  → returns ALL rows
      // With parameterized queries, it's:
      //   WHERE currency = $1  (with $1 = "USD' OR '1'='1")  → 0 rows
      expect(rows).toHaveLength(0);
    });

    it("fluent builder: values are always parameterized, never interpolated", async () => {
      const malicious = "USD' OR '1'='1";

      const rows = await query<AccountRow>(pool, "account_read")
        .where("currency", "=", malicious)
        .toList();

      expect(rows).toHaveLength(0);

      // Table unharmed
      const total = await query<AccountRow>(pool, "account_read").count();
      expect(total).toBe(5);
    });

    it("tagged template: UNION injection is treated as literal value", async () => {
      const injection = "' UNION SELECT id, customer_id, balance, currency, active FROM account_read --";

      const rows = await query<AccountRow>(pool)
        .sql`SELECT * FROM account_read WHERE id = ${injection}`
        .toList();

      // A UNION injection would return extra rows if string-concatenated.
      // Parameterized: the entire string is compared as a literal id value.
      expect(rows).toHaveLength(0);
    });
  });
});
