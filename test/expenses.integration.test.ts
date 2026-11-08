/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI provides one), with the local
 * storage driver in a temp directory. Proves the owner-only rules, upload caps and verification,
 * conflict tokens, CSV safety and object lifecycle of the expenses and receipts data layer.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("expenses and receipts data layer (Postgres, local storage)", () => {
  let sql: postgres.Sql;
  let dir: string;
  let ex: typeof import("@/lib/expenses");
  let rc: typeof import("@/lib/receipts");
  let st: typeof import("@/lib/storage");
  let envMod: typeof import("@/lib/env");

  const alice = { id: "ex-alice", role: "user" as const };
  const bob = { id: "ex-bob", role: "user" as const };
  const admin = { id: "ex-admin", role: "admin" as const };

  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1200, 7)]);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 3)]);
  const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(200, 1)]);
  const HTML = Buffer.from("<html><script>alert(1)</script></html>".padEnd(800, " "));

  const input = (over: Record<string, unknown> = {}) => ({ merchant: "Bluebird Coffee", spentOn: "2026-10-14", amount: "12.40", ...over });
  const keyOf = (userId: string, receiptId: string) => st.objectKeyFor(userId, receiptId);

  /** Reserve an upload and put the bytes the way the browser's PUT would; returns the receipt id. */
  async function upload(actor: typeof alice, bytes: Buffer, type: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg", declared = bytes.length) {
    const t = await rc.initUpload(actor, { contentType: type, sizeBytes: declared });
    await st.storage().put(keyOf(actor.id, t.receiptId), bytes, type);
    return t.receiptId;
  }
  /** A confirmed (ready) draft. */
  async function draft(actor: typeof alice, bytes = JPEG, type: "image/jpeg" | "image/png" = "image/jpeg") {
    const id = await upload(actor, bytes, type);
    await rc.verifyUpload(actor, id);
    return id;
  }
  const objectExists = async (userId: string, id: string) => (await st.storage().head(keyOf(userId, id))) !== null;

  async function wipe() {
    await sql`delete from expense where owner_id like 'ex-%'`;
    await sql`delete from receipt where owner_id like 'ex-%'`;
    await sql`delete from rate_event where user_id like 'ex-%'`;
    await sql`delete from daily_usage`;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "expenses-it-"));
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: "e".repeat(40),
      APP_URL: "http://localhost:3000",
      STORAGE_LOCAL_DIR: dir,
    });
    delete process.env.STORAGE_BUCKET;
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'ex-%'`;
    for (const u of [alice, bob, admin]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@exp-test.local"}, ${u.role})`;
    }
    envMod = await import("@/lib/env");
    envMod.resetEnvCache();
    st = await import("@/lib/storage");
    st.resetStorage();
    ex = await import("@/lib/expenses");
    rc = await import("@/lib/receipts");
  });

  beforeEach(async () => {
    delete process.env.STORAGE_MAX_BYTES;
    envMod.resetEnvCache();
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await sql`delete from "user" where id like 'ex-%'`;
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  describe("owner-only access (admin included)", () => {
    it("is 404 for another user and for admin on get, patch, delete and list", async () => {
      const e = await ex.createExpense(alice, input());
      for (const other of [bob, admin]) {
        await expect(ex.getExpense(other, e.id)).rejects.toMatchObject({ status: 404 });
        await expect(ex.updateExpense(other, e.id, { note: "x", updatedAt: e.updatedAt.toISOString() })).rejects.toMatchObject({ status: 404 });
        await expect(ex.deleteExpense(other, e.id)).rejects.toMatchObject({ status: 404 });
        expect((await ex.listExpenses(other)).items).toEqual([]);
      }
      expect((await ex.getExpense(alice, e.id)).id).toBe(e.id);
      expect(await sql`select 1 from expense where id = ${e.id}`).toHaveLength(1);
    });

    it("is 404 for another user and admin on the signed URL, confirm, discard and draft attach", async () => {
      const id = await draft(alice);
      for (const other of [bob, admin]) {
        await expect(rc.signReceiptUrl(other, id)).rejects.toMatchObject({ status: 404 });
        await expect(rc.verifyUpload(other, id)).rejects.toMatchObject({ status: 404 });
        await expect(rc.discardDraft(other, id)).rejects.toMatchObject({ status: 404 });
        await expect(ex.createExpense(other, input({ receiptId: id }))).rejects.toMatchObject({ status: 404 });
      }
      expect(await objectExists(alice.id, id)).toBe(true);
      expect((await sql`select count(*)::int as n from expense where owner_id like 'ex-%'`)[0].n).toBe(0);
    });

    it("treats a malformed id as 404, not a server error", async () => {
      await expect(ex.getExpense(alice, "nope")).rejects.toMatchObject({ status: 404 });
      await expect(rc.signReceiptUrl(alice, "nope")).rejects.toMatchObject({ status: 404 });
    });

    it("gives the owner a 300-second signed URL", async () => {
      const id = await draft(alice);
      const { url: link, expiresAt } = await rc.signReceiptUrl(alice, id);
      expect(link).toContain(`/api/storage/local/u/${alice.id}/${id}`);
      const secs = (new Date(expiresAt).getTime() - Date.now()) / 1000;
      expect(secs).toBeGreaterThan(295);
      expect(secs).toBeLessThanOrEqual(300);
    });

    it("limits signed URLs to 120 per user per hour", async () => {
      const id = await draft(alice);
      await sql`insert into rate_event (user_id, kind) select ${alice.id}, 'download' from generate_series(1, 120)`;
      await expect(rc.signReceiptUrl(alice, id)).rejects.toMatchObject({ status: 429 });
      await sql`update rate_event set at = now() - interval '61 minutes' where user_id = ${alice.id}`;
      await expect(rc.signReceiptUrl(alice, id)).resolves.toHaveProperty("url");
    });
  });

  describe("expenses", () => {
    it("stores money as integer minor units and returns decimal strings", async () => {
      const e = await ex.createExpense(alice, input({ amount: "12.4", tax: "0.95", currency: "EUR", category: "meals" }));
      expect(e).toMatchObject({ amountMinor: 1240, taxMinor: 95, amount: "12.40", tax: "0.95", currency: "EUR", source: "manual", receiptId: null });
      await expect(ex.createExpense(alice, input({ amount: "12.345" }))).rejects.toThrow();
      await expect(ex.createExpense(alice, input({ amount: 12.4 }))).rejects.toThrow();
      await expect(ex.createExpense(alice, input({ amount: "0.00" }))).rejects.toThrow();
      await expect(ex.createExpense(alice, input({ amount: "10000000" }))).rejects.toThrow();
      await expect(ex.createExpense(alice, input({ currency: "XYZ" }))).rejects.toThrow();
      await expect(ex.createExpense(alice, input({ spentOn: "2026-02-31" }))).rejects.toThrow();
      await expect(ex.createExpense(alice, input({ ownerId: bob.id }))).rejects.toThrow();
    });

    it("rejects a stale updatedAt with 409 and advances the token on every write", async () => {
      const e = await ex.createExpense(alice, input());
      const first = await ex.updateExpense(alice, e.id, { note: "one", updatedAt: e.updatedAt.toISOString() });
      expect(first.updatedAt.getTime()).toBeGreaterThan(e.updatedAt.getTime());
      await expect(ex.updateExpense(alice, e.id, { note: "two", updatedAt: e.updatedAt.toISOString() })).rejects.toMatchObject({ status: 409 });
      // Back-to-back writes in the same millisecond still move the token.
      const second = await ex.updateExpense(alice, e.id, { note: "two", updatedAt: first.updatedAt.toISOString() });
      expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
      expect((await ex.getExpense(alice, e.id)).note).toBe("two");
    });

    it("filters by month and category, pages, and totals by category per currency", async () => {
      await ex.createExpense(alice, input({ spentOn: "2026-10-31", amount: "10.00", category: "meals" }));
      await ex.createExpense(alice, input({ spentOn: "2026-10-01", amount: "5.50", category: "meals" }));
      await ex.createExpense(alice, input({ spentOn: "2026-10-15", amount: "100.00", category: "travel" }));
      await ex.createExpense(alice, input({ spentOn: "2026-10-15", amount: "20.00", category: "travel", currency: "EUR" }));
      await ex.createExpense(alice, input({ spentOn: "2026-11-01", amount: "99.00", category: "meals" }));
      await ex.createExpense(alice, input({ spentOn: "2026-09-30", amount: "98.00", category: "meals" }));
      await ex.createExpense(bob, input({ spentOn: "2026-10-15", amount: "1.00" }));

      expect((await ex.listExpenses(alice, "2026-10")).total).toBe(4);
      expect((await ex.listExpenses(alice, "2026-10", "meals")).items.map((i) => i.amount)).toEqual(["10.00", "5.50"]);
      expect((await ex.listExpenses(alice)).total).toBe(6);
      const p2 = await ex.listExpenses(alice, undefined, undefined, 2, 4);
      expect(p2).toMatchObject({ total: 6, page: 2, pageSize: 4 });
      expect(p2.items).toHaveLength(2);
      await expect(ex.listExpenses(alice, "2026-13")).rejects.toThrow();

      const s = await ex.monthlySummary(alice, "2026-10");
      const usd = s.currencies.find((c) => c.currency === "USD")!;
      expect(usd).toMatchObject({ totalMinor: 11550, total: "115.50", count: 3 });
      expect(usd.categories.map((c) => [c.category, c.total])).toEqual([["travel", "100.00"], ["meals", "15.50"]]);
      expect(s.currencies.find((c) => c.currency === "EUR")).toMatchObject({ total: "20.00", count: 1 });
    });

    it("caps expenses at 500 per user", async () => {
      await sql`insert into expense (owner_id, merchant, spent_on, amount_minor) select ${alice.id}, 'm', '2026-10-01', 100 from generate_series(1, 500)`;
      await expect(ex.createExpense(alice, input())).rejects.toMatchObject({ status: 409 });
      await expect(ex.createExpense(bob, input())).resolves.toHaveProperty("id");
    });

    it("attaches only the actor's own ready draft, once", async () => {
      const id = await draft(alice);
      const e = await ex.createExpense(alice, input({ receiptId: id }));
      expect(e).toMatchObject({ receiptId: id, source: "receipt" });
      await expect(ex.createExpense(alice, input({ receiptId: id }))).rejects.toMatchObject({ status: 409 });
      const pending = await rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 100 });
      await expect(ex.createExpense(alice, input({ receiptId: pending.receiptId }))).rejects.toMatchObject({ status: 409 });
      await expect(rc.discardDraft(alice, id)).rejects.toMatchObject({ status: 409 });
    });

    it("deleting an expense deletes its receipt object and row first", async () => {
      const id = await draft(alice);
      const e = await ex.createExpense(alice, input({ receiptId: id }));
      expect(await objectExists(alice.id, id)).toBe(true);
      await ex.deleteExpense(alice, e.id);
      expect(await objectExists(alice.id, id)).toBe(false);
      expect(await sql`select 1 from receipt where id = ${id}`).toHaveLength(0);
      expect(await sql`select 1 from expense where id = ${e.id}`).toHaveLength(0);
    });

    it("keeps the expense when the object can't be removed (502)", async () => {
      const id = await draft(alice);
      const e = await ex.createExpense(alice, input({ receiptId: id }));
      const driver = st.storage();
      const original = driver.remove;
      driver.remove = async () => {
        throw new Error("storage down");
      };
      try {
        await expect(ex.deleteExpense(alice, e.id)).rejects.toMatchObject({ status: 502 });
      } finally {
        driver.remove = original;
      }
      expect(await sql`select 1 from expense where id = ${e.id}`).toHaveLength(1);
      expect(await objectExists(alice.id, id)).toBe(true);
    });

    it("discards an unattached draft: object then row", async () => {
      const id = await draft(alice);
      await rc.discardDraft(alice, id);
      expect(await objectExists(alice.id, id)).toBe(false);
      expect(await sql`select 1 from receipt where id = ${id}`).toHaveLength(0);
    });
  });

  describe("upload init and caps", () => {
    it("returns the signed ticket with the headers the browser must send", async () => {
      const t = await rc.initUpload(alice, { contentType: "image/png", sizeBytes: 4000 });
      expect(t).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/png", "x-goog-content-length-range": "1,4000" } });
      expect(t.url).toContain(t.receiptId);
      const [row] = await sql`select status, size_bytes, object_key from receipt where id = ${t.receiptId}`;
      expect(row).toMatchObject({ status: "uploading", size_bytes: 4000, object_key: `u/${alice.id}/${t.receiptId}` });
    });

    it("refuses a bad type, 0 bytes, and 5 MB + 1 byte, and reserves nothing", async () => {
      const max = 5 * 1024 * 1024;
      await expect(rc.initUpload(alice, { contentType: "image/gif", sizeBytes: 100 })).rejects.toThrow();
      await expect(rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 0 })).rejects.toThrow();
      await expect(rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: max + 1 })).rejects.toThrow();
      await expect(rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 1.5 })).rejects.toThrow();
      await expect(rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: max })).resolves.toHaveProperty("receiptId");
      expect((await sql`select count(*)::int as n from receipt where owner_id = ${alice.id}`)[0].n).toBe(1);
    });

    it("refuses the 31st receipt for one user but not for another", async () => {
      await sql`insert into receipt (id, owner_id, object_key, content_type, size_bytes, status)
        select g, ${alice.id}, 'u/' || ${alice.id} || '/' || g::text, 'image/jpeg', 100, 'ready' from (select gen_random_uuid() as g from generate_series(1, 30)) t`;
      await expect(rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 100 })).rejects.toMatchObject({ status: 409 });
      await expect(rc.initUpload(bob, { contentType: "image/jpeg", sizeBytes: 100 })).resolves.toHaveProperty("receiptId");
    });

    it("refuses the 101st upload of the day, app-wide, and does not count refused ones", async () => {
      await sql`insert into daily_usage (day, kind, count) values ((now() at time zone 'utc')::date, 'upload', 99)`;
      await expect(rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 100 })).resolves.toHaveProperty("receiptId");
      await expect(rc.initUpload(bob, { contentType: "image/jpeg", sizeBytes: 100 })).rejects.toMatchObject({ status: 429 });
      const [row] = await sql`select count from daily_usage where kind = 'upload'`;
      expect(row.count).toBe(100);
      expect((await sql`select count(*)::int as n from receipt where owner_id = ${bob.id}`)[0].n).toBe(0);
      expect((await sql`select count(*)::int as n from rate_event where user_id = ${bob.id}`)[0].n).toBe(0);
    });

    it("rate-limits uploads per user per hour", async () => {
      for (let i = 0; i < 20; i++) await rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 100 });
      await expect(rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 100 })).rejects.toMatchObject({ status: 429 });
      await expect(rc.initUpload(bob, { contentType: "image/jpeg", sizeBytes: 100 })).resolves.toHaveProperty("receiptId");
      await sql`update rate_event set at = now() - interval '61 minutes' where user_id = ${alice.id}`;
      await expect(rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 100 })).resolves.toHaveProperty("receiptId");
    });

    it("refuses an upload that would pass the app-wide byte cap", async () => {
      process.env.STORAGE_MAX_BYTES = "2000";
      envMod.resetEnvCache();
      await rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 1500 });
      await expect(rc.initUpload(bob, { contentType: "image/jpeg", sizeBytes: 600 })).rejects.toMatchObject({ status: 429 });
      await expect(rc.initUpload(bob, { contentType: "image/jpeg", sizeBytes: 500 })).resolves.toHaveProperty("receiptId");
    });
  });

  describe("verification", () => {
    it("accepts JPEG, PNG and WebP and records the REAL size, not the declared one", async () => {
      for (const [bytes, type] of [[JPEG, "image/jpeg"], [PNG, "image/png"], [WEBP, "image/webp"]] as const) {
        const id = await upload(alice, bytes, type, 5000);
        const { receipt, bytes: read } = await rc.verifyUpload(alice, id);
        expect(receipt).toMatchObject({ status: "ready", sizeBytes: bytes.length });
        expect(read.equals(bytes)).toBe(true);
      }
      const stats = await rc.adminStats(admin);
      expect(stats.receipts).toBe(3);
      expect(stats.receiptBytes).toBe(JPEG.length + PNG.length + WEBP.length);
    });

    it("caps use real sizes: a small real file frees reserved bytes", async () => {
      process.env.STORAGE_MAX_BYTES = "3000";
      envMod.resetEnvCache();
      const id = await upload(alice, JPEG, "image/jpeg", 2500);
      await expect(rc.initUpload(bob, { contentType: "image/jpeg", sizeBytes: 1000 })).rejects.toMatchObject({ status: 429 });
      await rc.verifyUpload(alice, id);
      await expect(rc.initUpload(bob, { contentType: "image/jpeg", sizeBytes: 1000 })).resolves.toHaveProperty("receiptId");
    });

    it("rejects a disguised HTML file, deletes the object and the row, and returns 422", async () => {
      const id = await upload(alice, HTML, "image/jpeg");
      expect(await objectExists(alice.id, id)).toBe(true);
      await expect(rc.verifyUpload(alice, id)).rejects.toMatchObject({ status: 422 });
      expect(await objectExists(alice.id, id)).toBe(false);
      expect(await sql`select 1 from receipt where id = ${id}`).toHaveLength(0);
      await expect(rc.verifyUpload(alice, id)).rejects.toMatchObject({ status: 404 });
    });

    it("rejects a real PNG declared as JPEG", async () => {
      const id = await upload(alice, PNG, "image/jpeg");
      await expect(rc.verifyUpload(alice, id)).rejects.toMatchObject({ status: 422 });
      expect(await objectExists(alice.id, id)).toBe(false);
    });

    it("rejects an object larger than the size it reserved", async () => {
      const id = await upload(alice, JPEG, "image/jpeg", 500);
      await expect(rc.verifyUpload(alice, id)).rejects.toMatchObject({ status: 422 });
      expect(await objectExists(alice.id, id)).toBe(false);
      expect(await sql`select 1 from receipt where id = ${id}`).toHaveLength(0);
    });

    it("is 409 (and keeps the row) when nothing was uploaded yet", async () => {
      const t = await rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 1000 });
      await expect(rc.verifyUpload(alice, t.receiptId)).rejects.toMatchObject({ status: 409 });
      expect(await sql`select 1 from receipt where id = ${t.receiptId}`).toHaveLength(1);
    });
  });

  describe("sweep", () => {
    it("removes only stale rows: old unconfirmed uploads and old unused drafts", async () => {
      const staleUpload = await upload(alice, JPEG);
      const freshUpload = await upload(alice, JPEG);
      const staleDraft = await draft(alice);
      const freshDraft = await draft(alice);
      const oldAttached = await draft(alice);
      const e = await ex.createExpense(alice, input({ receiptId: oldAttached }));
      const midDraft = await draft(alice); // 2 hours old: a draft only goes after 24 h
      await sql`update receipt set created_at = now() - interval '61 minutes' where id = ${staleUpload}`;
      await sql`update receipt set created_at = now() - interval '25 hours' where id in (${staleDraft}, ${oldAttached})`;
      await sql`update receipt set created_at = now() - interval '2 hours' where id = ${midDraft}`;

      expect(await rc.sweepStaleReceipts()).toBe(2);
      const left = (await sql`select id from receipt where owner_id = ${alice.id}`).map((r) => r.id).sort();
      expect(left).toEqual([freshUpload, freshDraft, oldAttached, midDraft].sort());
      expect(await objectExists(alice.id, staleUpload)).toBe(false);
      expect(await objectExists(alice.id, staleDraft)).toBe(false);
      for (const id of [freshUpload, freshDraft, oldAttached, midDraft]) expect(await objectExists(alice.id, id)).toBe(true);
      expect((await ex.getExpense(alice, e.id)).receiptId).toBe(oldAttached);
    });

    it("works in batches of at most 50 and can be scoped to one owner", async () => {
      await sql`insert into receipt (id, owner_id, object_key, content_type, size_bytes, status, created_at)
        select g, o, 'u/' || o || '/' || g::text, 'image/jpeg', 10, 'uploading', now() - interval '2 hours'
        from (select gen_random_uuid() as g, case when i <= 3 then ${bob.id} else ${alice.id} end as o from generate_series(1, 60) i) t`;
      expect(await rc.sweepStaleReceipts({ ownerId: bob.id })).toBe(3);
      expect(await rc.sweepStaleReceipts()).toBe(50);
      expect(await rc.sweepStaleReceipts()).toBe(7);
    });
  });

  describe("CSV export", () => {
    it("escapes formula cells and quotes, and contains only the actor's rows", async () => {
      await ex.createExpense(alice, input({ merchant: "=HYPERLINK(\"http://evil\")", note: "+1 and, a comma" }));
      await ex.createExpense(alice, input({ merchant: "@SUM(A1)", note: "-2\nnew line" }));
      await ex.createExpense(alice, input({ merchant: "Tabby", note: "\tTab\rCR" }));
      await ex.createExpense(alice, input({ merchant: "Plain", note: 'say "hi"' }));
      await ex.createExpense(alice, input({ merchant: "CRNote", note: "\rStartsCR" }));
      await ex.createExpense(bob, input({ merchant: "BobsSecretMerchant" }));
      const csv = await ex.exportCsv(alice);
      expect(csv.split("\r\n")[0]).toBe("Date,Merchant,Category,Amount,Tax,Currency,Note,Source,Has receipt");
      expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
      expect(csv).toContain(`'@SUM(A1)`);
      expect(csv).toContain(`"'\tTab\rCR"`);
      expect(csv).toContain(`"'\rStartsCR"`);
      expect(csv).toContain(`"'+1 and, a comma"`);
      expect(csv).toContain(`"'-2\nnew line"`);
            expect(csv).toContain(`"say ""hi"""`);
      expect(csv).not.toContain("BobsSecretMerchant");
      // No cell starts with a bare formula character.
      for (const field of csv.match(/(?:^|,)(?:"(?:[^"]|"")*"|[^,\r\n]*)/gm) ?? []) {
        expect(field.replace(/^,/, "").replace(/^"/, "")).not.toMatch(/^[=+\-@\t\r]/);
      }
      expect(await ex.exportCsv(admin)).not.toContain("Bluebird");
    });

    it("filters by date range", async () => {
      await ex.createExpense(alice, input({ spentOn: "2026-01-05", merchant: "JanShop" }));
      await ex.createExpense(alice, input({ spentOn: "2026-03-05", merchant: "MarShop" }));
      const csv = await ex.exportCsv(alice, "2026-02-01", "2026-12-31");
      expect(csv).toContain("MarShop");
      expect(csv).not.toContain("JanShop");
      await expect(ex.exportCsv(alice, "yesterday")).rejects.toThrow();
    });
  });

  describe("purge and user removal", () => {
    async function withReceipts(actor: typeof alice) {
      const a = await draft(actor);
      const b = await draft(actor, PNG, "image/png");
      const e = await ex.createExpense(actor, input({ receiptId: a }));
      return { a, b, e };
    }

    it("purgeUserReceipts deletes objects and rows but keeps expenses with receipt_id nulled", async () => {
      const { a, b, e } = await withReceipts(alice);
      const other = await draft(bob);
      expect(await rc.purgeUserReceipts(alice.id)).toBe(2);
      for (const id of [a, b]) expect(await objectExists(alice.id, id)).toBe(false);
      expect(await sql`select 1 from receipt where owner_id = ${alice.id}`).toHaveLength(0);
      const kept = await ex.getExpense(alice, e.id);
      expect(kept.receiptId).toBeNull();
      expect(kept.merchant).toBe("Bluebird Coffee");
      expect(await objectExists(bob.id, other)).toBe(true);
    });

    it("admin purge works for admin only, 404s for a missing user, and stops on storage failure", async () => {
      const { a } = await withReceipts(alice);
      await expect(rc.adminPurgeReceipts(bob, alice.id)).rejects.toMatchObject({ status: 403 });
      await expect(rc.adminPurgeReceipts(alice, alice.id)).rejects.toMatchObject({ status: 403 });
      await expect(rc.adminPurgeReceipts(admin, "ex-nobody")).rejects.toMatchObject({ status: 404 });
      const driver = st.storage();
      const original = driver.remove;
      driver.remove = async () => {
        throw new Error("storage down");
      };
      try {
        await expect(rc.adminPurgeReceipts(admin, alice.id)).rejects.toMatchObject({ status: 502 });
      } finally {
        driver.remove = original;
      }
      expect(await sql`select 1 from receipt where owner_id = ${alice.id}`).toHaveLength(2);
      expect(await rc.adminPurgeReceipts(admin, alice.id)).toEqual({ purged: 2 });
      expect(await objectExists(alice.id, a)).toBe(false);
    });

    it("the Better Auth user-delete hook purges the user's objects before the row goes", async () => {
      await sql`insert into "user" (id, name, email) values ('ex-doomed', 'doomed', 'ex-doomed@exp-test.local')`;
      const doomed = { id: "ex-doomed", role: "user" as const };
      const id = await draft(doomed);
      await ex.createExpense(doomed, input({ receiptId: id }));
      const { auth } = await import("@/lib/auth");
      const ctx = await auth().$context;
      await ctx.internalAdapter.deleteUser("ex-doomed");
      expect(await objectExists("ex-doomed", id)).toBe(false);
      expect(await sql`select 1 from "user" where id = 'ex-doomed'`).toHaveLength(0);
      expect(await sql`select 1 from receipt where owner_id = 'ex-doomed'`).toHaveLength(0);
    });

    it("the hook aborts the removal when storage fails, so no files are orphaned", async () => {
      await sql`insert into "user" (id, name, email) values ('ex-stuck', 'stuck', 'ex-stuck@exp-test.local')`;
      const stuck = { id: "ex-stuck", role: "user" as const };
      const id = await draft(stuck);
      const { auth } = await import("@/lib/auth");
      const ctx = await auth().$context;
      const driver = st.storage();
      const original = driver.remove;
      driver.remove = async () => {
        throw new Error("storage down");
      };
      try {
        await expect(ctx.internalAdapter.deleteUser("ex-stuck")).rejects.toThrow();
      } finally {
        driver.remove = original;
      }
      expect(await sql`select 1 from "user" where id = 'ex-stuck'`).toHaveLength(1);
      expect(await objectExists("ex-stuck", id)).toBe(true);
      await ctx.internalAdapter.deleteUser("ex-stuck");
      expect(await objectExists("ex-stuck", id)).toBe(false);
    });
  });

  describe("admin stats", () => {
    it("are admin only and carry counts and caps, never bodies", async () => {
      await draft(alice);
      await ex.createExpense(alice, input());
      await expect(rc.adminStats(alice)).rejects.toMatchObject({ status: 403 });
      await expect(rc.adminUserUsage(alice)).rejects.toMatchObject({ status: 403 });
      const s = await rc.adminStats(admin);
      expect(s).toMatchObject({ receipts: 1, uploadsToday: 1, uploadsCap: 100, receiptBytesCap: 2 * 1024 * 1024 * 1024, receiptsPerUserCap: 30 });
      expect(s.expenses).toBeGreaterThanOrEqual(1);
      const row = (await rc.adminUserUsage(admin)).find((u) => u.id === alice.id)!;
      expect(row).toMatchObject({ expenses: 1, receipts: 1, bytes: JPEG.length });
      expect(Object.keys(row).sort()).toEqual(["bytes", "email", "expenses", "id", "name", "receipts", "role"]);
    });
  });
});
