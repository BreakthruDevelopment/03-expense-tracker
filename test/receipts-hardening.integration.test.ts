/**
 * Hardening rules for receipts against a real Postgres (TEST_DATABASE_URL) and the local storage
 * driver: sweep/discard never delete a draft that is being attached, a signing failure gives its
 * reservation back, an object that grows after confirm is rejected, the admin purge validates its id
 * and is rate limited, and the upload caps hold under concurrent requests.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)("receipt hardening (Postgres, local storage)", () => {
  let sql: postgres.Sql;
  let dir: string;
  let rc: typeof import("@/lib/receipts");
  let st: typeof import("@/lib/storage");
  let envMod: typeof import("@/lib/env");

  const alice = { id: "hd-alice", role: "user" as const };
  const bob = { id: "hd-bob", role: "user" as const };
  const admin = { id: "hd-admin", role: "admin" as const };
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1200, 7)]);

  const keyOf = (userId: string, id: string) => st.objectKeyFor(userId, id);
  const objectExists = async (userId: string, id: string) => (await st.storage().head(keyOf(userId, id))) !== null;
  const rowExists = async (id: string) => (await sql`select 1 from receipt where id = ${id}`).length === 1;

  async function draft(actor: typeof alice) {
    const t = await rc.initUpload(actor, { contentType: "image/jpeg", sizeBytes: JPEG.length });
    await st.storage().put(keyOf(actor.id, t.receiptId), JPEG, "image/jpeg");
    await rc.verifyUpload(actor, t.receiptId);
    return t.receiptId;
  }
  const makeStale = (id: string) => sql`update receipt set created_at = now() - interval '2 days' where id = ${id}`;

  /** Hold the receipt row locked and attach an expense to it, the way createExpense does, for `holdMs`. */
  function attachSlowly(owner: typeof alice, receiptId: string, holdMs: number) {
    let locked!: () => void;
    const ready = new Promise<void>((r) => (locked = r));
    const done = sql.begin(async (t) => {
      await t`select id from receipt where id = ${receiptId} for update`;
      locked();
      await sleep(holdMs);
      await t`insert into expense (owner_id, merchant, spent_on, amount_minor, source, receipt_id)
        values (${owner.id}, 'Bluebird Coffee', '2026-10-14', 1240, 'receipt', ${receiptId})`;
    });
    return { ready, done };
  }

  async function wipe() {
    await sql`delete from expense where owner_id like 'hd-%'`;
    await sql`delete from receipt where owner_id like 'hd-%'`;
    await sql`delete from rate_event where user_id like 'hd-%'`;
    await sql`delete from daily_usage`;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "receipts-hardening-"));
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: "g".repeat(40),
      APP_URL: "http://localhost:3000",
      STORAGE_LOCAL_DIR: dir,
      AI_PROVIDER: "demo",
      LOG_LEVEL: "error",
    });
    delete process.env.STORAGE_BUCKET;
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await sql`delete from "user" where id like 'hd-%'`;
    for (const u of [alice, bob, admin]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@hd-receipts.local"}, ${u.role})`;
    }
    envMod = await import("@/lib/env");
    envMod.resetEnvCache();
    st = await import("@/lib/storage");
    st.resetStorage();
    rc = await import("@/lib/receipts");
  });

  beforeEach(async () => {
    for (const k of ["RECEIPTS_PER_USER", "UPLOAD_DAILY_CAP"]) delete process.env[k];
    envMod.resetEnvCache();
    await wipe();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await wipe();
    await sql`delete from "user" where id like 'hd-%'`;
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  describe("discard and sweep vs. a draft being attached", () => {
    it("discardDraft waits for the attach, then refuses with 409 and keeps image and row", async () => {
      const id = await draft(alice);
      const attach = attachSlowly(alice, id, 400);
      await attach.ready;
      const discard = rc.discardDraft(alice, id);
      const [err] = await Promise.all([discard.catch((e) => e), attach.done]);
      expect(err).toMatchObject({ status: 409 });
      expect(await objectExists(alice.id, id)).toBe(true);
      expect(await rowExists(id)).toBe(true);
      expect((await sql`select receipt_id from expense where owner_id = ${alice.id}`)[0].receipt_id).toBe(id);
    });

    it("sweep skips a draft that is locked for attaching, and never deletes it once attached", async () => {
      const id = await draft(alice);
      await makeStale(id);
      const attach = attachSlowly(alice, id, 400);
      await attach.ready;
      expect(await rc.sweepStaleReceipts()).toBe(0); // locked: skipped, not waited for
      await attach.done;
      expect(await rc.sweepStaleReceipts()).toBe(0); // attached: kept
      expect(await objectExists(alice.id, id)).toBe(true);
      expect(await rowExists(id)).toBe(true);
    });

    it("sweep isn't starved by more than SWEEP_BATCH old attached receipts", async () => {
      const n = 55;
      await sql`insert into receipt (id, owner_id, object_key, content_type, size_bytes, status, created_at)
        select g, ${bob.id}, 'u/' || ${bob.id} || '/' || g::text, 'image/jpeg', 100, 'ready', now() - interval '10 days'
        from (select gen_random_uuid() as g from generate_series(1, ${n})) t`;
      await sql`insert into expense (owner_id, merchant, spent_on, amount_minor, source, receipt_id)
        select ${bob.id}, 'Old', '2026-01-01', 100, 'receipt', id from receipt where owner_id = ${bob.id}`;
      const t = await rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 500 });
      await st.storage().put(keyOf(alice.id, t.receiptId), JPEG.subarray(0, 500), "image/jpeg");
      // Newer than every attached receipt, so ordering by age puts it after all 55 of them.
      await sql`update receipt set created_at = now() - interval '2 hours' where id = ${t.receiptId}`;
      await sql`update receipt set created_at = now() - interval '20 days' where owner_id = ${bob.id}`;
      expect(await rc.sweepStaleReceipts()).toBe(1);
      expect(await rowExists(t.receiptId)).toBe(false);
      expect((await sql`select count(*)::int as n from receipt where owner_id = ${bob.id}`)[0].n).toBe(n);
    });

    it("sweep still removes a stale unattached draft, object and row, and an old unconfirmed upload", async () => {
      const a = await draft(alice);
      const t = await rc.initUpload(bob, { contentType: "image/jpeg", sizeBytes: 500 });
      await st.storage().put(keyOf(bob.id, t.receiptId), JPEG.subarray(0, 500), "image/jpeg");
      await sql`update receipt set created_at = now() - interval '2 hours' where id = ${t.receiptId}`;
      await makeStale(a);
      expect(await rc.sweepStaleReceipts()).toBe(2);
      expect(await objectExists(alice.id, a)).toBe(false);
      expect(await objectExists(bob.id, t.receiptId)).toBe(false);
      expect(await rowExists(a)).toBe(false);
    });

    it("a storage failure in discard or sweep keeps the row for another try", async () => {
      const id = await draft(alice);
      await makeStale(id);
      const driver = st.storage();
      const original = driver.remove;
      driver.remove = async () => {
        throw new st.StorageError();
      };
      try {
        await expect(rc.discardDraft(alice, id)).rejects.toMatchObject({ status: 502 });
        expect(await rc.sweepStaleReceipts()).toBe(0);
      } finally {
        driver.remove = original;
      }
      expect(await rowExists(id)).toBe(true);
      expect(await objectExists(alice.id, id)).toBe(true);
      await rc.discardDraft(alice, id);
      expect(await rowExists(id)).toBe(false);
    });

    it("discard is 404 for another user and for admin", async () => {
      const id = await draft(alice);
      for (const other of [bob, admin]) await expect(rc.discardDraft(other, id)).rejects.toMatchObject({ status: 404 });
      expect(await rowExists(id)).toBe(true);
    });
  });

  describe("a signing failure after the reservation committed", () => {
    it("deletes the row and gives back the hourly and daily counts", async () => {
      await rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 100 }); // one real upload to count against
      const driver = st.storage();
      const original = driver.signUpload;
      driver.signUpload = async () => {
        throw new st.StorageError();
      };
      try {
        await expect(rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: 100 })).rejects.toMatchObject({ status: 502 });
      } finally {
        driver.signUpload = original;
      }
      expect((await sql`select count(*)::int as n from receipt where owner_id = ${alice.id}`)[0].n).toBe(1);
      expect((await sql`select count(*)::int as n from rate_event where user_id = ${alice.id} and kind = 'upload'`)[0].n).toBe(1);
      expect((await sql`select count from daily_usage where kind = 'upload'`)[0].count).toBe(1);
    });
  });

  describe("confirm when the object grows after the size check", () => {
    it("is rejected with 422 and the object and row are deleted", async () => {
      const t = await rc.initUpload(alice, { contentType: "image/jpeg", sizeBytes: JPEG.length });
      await st.storage().put(keyOf(alice.id, t.receiptId), JPEG, "image/jpeg");
      const driver = st.storage();
      const original = driver.read;
      driver.read = async () => {
        throw new st.StorageError("Stored file is too large.", 422);
      };
      try {
        await expect(rc.verifyUpload(alice, t.receiptId)).rejects.toMatchObject({ status: 422 });
      } finally {
        driver.read = original;
      }
      expect(await rowExists(t.receiptId)).toBe(false);
      expect(await objectExists(alice.id, t.receiptId)).toBe(false);
    });
  });

  describe("admin purge", () => {
    it("rejects an id that isn't a user id with 404, without recording a purge", async () => {
      for (const bad of ["../etc", "a b", "", "x".repeat(65), "u/1"]) {
        await expect(rc.adminPurgeReceipts(admin, bad)).rejects.toMatchObject({ status: 404 });
      }
      await expect(rc.adminPurgeReceipts(admin, { $ne: 1 } as unknown as string)).rejects.toMatchObject({ status: 404 });
      expect((await sql`select count(*)::int as n from rate_event where kind = 'purge'`)[0].n).toBe(0);
    });

    it("is admin only", async () => {
      await draft(alice);
      for (const other of [alice, bob]) await expect(rc.adminPurgeReceipts(other, alice.id)).rejects.toMatchObject({ status: 403 });
      expect((await sql`select count(*)::int as n from receipt where owner_id = ${alice.id}`)[0].n).toBe(1);
      await expect(rc.adminPurgeReceipts(admin, alice.id)).resolves.toEqual({ purged: 1 });
    });

    it("allows 30 purges an hour per admin and then answers 429", async () => {
      for (let i = 0; i < 30; i++) await rc.adminPurgeReceipts(admin, bob.id);
      await expect(rc.adminPurgeReceipts(admin, bob.id)).rejects.toMatchObject({ status: 429 });
      await sql`update rate_event set at = now() - interval '61 minutes' where user_id = ${admin.id}`;
      await expect(rc.adminPurgeReceipts(admin, bob.id)).resolves.toEqual({ purged: 0 });
    });
  });

  describe("upload caps hold under concurrent requests", () => {
    const init = (who: typeof alice) => rc.initUpload(who, { contentType: "image/jpeg", sizeBytes: 100 });
    const outcome = (rs: PromiseSettledResult<unknown>[]) => ({
      ok: rs.filter((r) => r.status === "fulfilled").length,
      refused: rs.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.status),
    });

    it("per-user receipt cap: 10 parallel requests at a cap of 4 admit exactly 4 (409 for the rest)", async () => {
      process.env.RECEIPTS_PER_USER = "4";
      envMod.resetEnvCache();
      const out = outcome(await Promise.allSettled(Array.from({ length: 10 }, () => init(alice))));
      expect(out.ok).toBe(4);
      expect(out.refused).toEqual(Array(6).fill(409));
      expect((await sql`select count(*)::int as n from receipt where owner_id = ${alice.id}`)[0].n).toBe(4);
    });

    it("hourly rate: 30 parallel requests admit exactly 20 (429 for the rest) and record 20", async () => {
      const out = outcome(await Promise.allSettled(Array.from({ length: 30 }, () => init(alice))));
      expect(out.ok).toBe(20);
      expect(out.refused).toEqual(Array(10).fill(429));
      expect((await sql`select count(*)::int as n from rate_event where user_id = ${alice.id} and kind = 'upload'`)[0].n).toBe(20);
    });

    it("app-wide daily cap: parallel requests from two users admit exactly the cap", async () => {
      process.env.UPLOAD_DAILY_CAP = "5";
      envMod.resetEnvCache();
      const users = [alice, bob];
      const out = outcome(await Promise.allSettled(Array.from({ length: 12 }, (_, i) => init(users[i % 2]))));
      expect(out.ok).toBe(5);
      expect(out.refused).toEqual(Array(7).fill(429));
      expect((await sql`select count from daily_usage where kind = 'upload'`)[0].count).toBe(5);
      expect((await sql`select count(*)::int as n from receipt where owner_id like 'hd-%'`)[0].n).toBe(5);
    });
  });
});
