/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI provides one). Migrates a
 * throwaway empty database to prove the migrations apply from scratch, then checks the
 * constraints, cascades and indexes the data layer relies on.
 */
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const withDb = (base: string, name: string) => {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
};

describe.skipIf(!url)("expense schema (Postgres)", () => {
  const name = `schema_fresh_${randomBytes(4).toString("hex")}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const rid = "0b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f";

  const expense = (over: Record<string, unknown> = {}) => ({
    owner_id: "s-alice",
    merchant: "Cafe",
    spent_on: "2026-11-01",
    amount_minor: 1240,
    currency: "USD",
    category: "meals",
    source: "manual",
    ...over,
  });
  const insertExpense = (row: Record<string, unknown>) =>
    sql`insert into expense ${sql(row as Record<string, string | number | null>)}`;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const conn = postgres(withDb(url!, name), { max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle(conn), { migrationsFolder: "./drizzle" });
    } finally {
      await conn.end();
    }
    sql = postgres(withDb(url!, name), { max: 1, onnotice: () => {} });
    for (const id of ["s-alice", "s-bob"]) {
      await sql`insert into "user" (id, name, email) values (${id}, ${id}, ${id + "@test.local"})`;
    }
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("removed the template's item table and created the expense tables", async () => {
    const rows = await sql`select table_name from information_schema.tables where table_schema = 'public'`;
    const names = rows.map((r) => r.table_name);
    expect(names).not.toContain("item");
    for (const t of ["expense", "receipt", "daily_usage", "rate_event"]) expect(names).toContain(t);
  });

  it("uses millisecond-precision timestamptz for conflict tokens", async () => {
    const rows = await sql`
      select table_name, column_name, datetime_precision, data_type from information_schema.columns
      where table_name in ('expense','receipt') and column_name in ('created_at','updated_at')`;
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.data_type).toBe("timestamp with time zone");
      expect(r.datetime_precision).toBe(3);
    }
  });

  it("accepts a valid expense and enforces amount, currency, category, source and length checks", async () => {
    await insertExpense(expense());
    const bad: Record<string, unknown>[] = [
      { amount_minor: 0 },
      { amount_minor: 100_000_001 },
      { tax_minor: -1 },
      { currency: "JPY" },
      { currency: "usd" },
      { category: "yachts" },
      { source: "email" },
      { ai_mode: "maybe" },
      { merchant: "" },
      { merchant: "x".repeat(121) },
      { note: "x".repeat(501) },
    ];
    for (const over of bad) await expect(insertExpense(expense(over)), JSON.stringify(over)).rejects.toThrow();
    await insertExpense(expense({ merchant: "x".repeat(120), note: "n".repeat(500), amount_minor: 100_000_000, tax_minor: 0 }));
  });

  it("checks receipt type, status, size and that the key is u/<owner>/<id>", async () => {
    const receipt = (over: Record<string, unknown> = {}) => ({
      id: rid,
      owner_id: "s-alice",
      object_key: `u/s-alice/${rid}`,
      content_type: "image/jpeg",
      size_bytes: 1000,
      ...over,
    });
    const ins = (r: Record<string, unknown>) => sql`insert into receipt ${sql(r as Record<string, string | number>)}`;
    for (const over of [
      { content_type: "text/html" },
      { status: "approved" },
      { size_bytes: 0 },
      { size_bytes: 5 * 1024 * 1024 + 1 },
      { object_key: `u/s-bob/${rid}` },
      { object_key: `u/s-alice/${rid}.jpg` },
      { extraction_mode: "guess" },
    ]) {
      await expect(ins(receipt(over)), JSON.stringify(over)).rejects.toThrow();
    }
    await ins(receipt());
    await expect(ins(receipt())).rejects.toThrow(); // duplicate id / key
    const [r] = await sql`select status, created_at from receipt where id = ${rid}`;
    expect(r.status).toBe("uploading");
  });

  it("won't let an expense reference another user's receipt, and a purge only nulls receipt_id", async () => {
    const rid2 = "1b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f";
    await sql`insert into receipt (id, owner_id, object_key, content_type, size_bytes)
      values (${rid2}, 's-alice', ${"u/s-alice/" + rid2}, 'image/png', 10)`;
    await expect(insertExpense(expense({ owner_id: "s-bob", receipt_id: rid2, source: "receipt" }))).rejects.toThrow(/foreign key/i);
    await insertExpense(expense({ merchant: "Linked", receipt_id: rid2, source: "receipt" }));
    await sql`delete from receipt where id = ${rid2}`;
    const [e] = await sql`select owner_id, receipt_id from expense where merchant = 'Linked'`;
    expect(e).toEqual({ owner_id: "s-alice", receipt_id: null });
  });

  it("links one expense per receipt, nulls the link when the receipt goes, and cascades with the user", async () => {
    await insertExpense(expense({ receipt_id: rid, source: "receipt" }));
    await expect(insertExpense(expense({ receipt_id: rid, source: "receipt" }))).rejects.toThrow();
    await sql`delete from receipt where id = ${rid}`;
    const [e] = await sql`select receipt_id from expense where receipt_id is null and source = 'receipt'`;
    expect(e.receipt_id).toBeNull();

    await sql`insert into rate_event (user_id, kind) values ('s-bob', 'upload')`;
    await expect(sql`insert into rate_event (user_id, kind) values ('s-bob', 'hack')`).rejects.toThrow();
    await insertExpense(expense({ owner_id: "s-bob" }));
    await sql`delete from "user" where id = 's-bob'`;
    expect(await sql`select 1 from expense where owner_id = 's-bob'`).toHaveLength(0);
    expect(await sql`select 1 from rate_event where user_id = 's-bob'`).toHaveLength(0);
  });

  it("limits daily_usage to known kinds with one row per day and kind", async () => {
    await sql`insert into daily_usage (day, kind, count) values ('2026-11-08', 'upload', 1)`;
    await expect(sql`insert into daily_usage (day, kind, count) values ('2026-11-08', 'upload', 1)`).rejects.toThrow();
    await expect(sql`insert into daily_usage (day, kind, count) values ('2026-11-08', 'bogus', 1)`).rejects.toThrow();
    await expect(sql`insert into daily_usage (day, kind, count) values ('2026-11-09', 'extract', -1)`).rejects.toThrow();
  });

  it("has the indexes for the owner-scoped queries", async () => {
    const rows = await sql`select indexname from pg_indexes where schemaname = 'public'`;
    const names = rows.map((r) => r.indexname);
    for (const i of ["expense_owner_spent_idx", "expense_owner_category_idx", "receipt_owner_status_created_idx", "rate_event_user_kind_at_idx", "expense_receipt_id_uq"]) {
      expect(names).toContain(i);
    }
  });
});
