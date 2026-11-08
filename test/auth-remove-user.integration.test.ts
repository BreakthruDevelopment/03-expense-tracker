/**
 * Removing a user, and the extract route's auth rules, against a real Postgres (TEST_DATABASE_URL),
 * the local storage driver and the real Better Auth instance (sessions are real; only `next/headers`
 * is faked so route handlers see the signed-in cookie).
 *
 * Proves: the admin remove-user before-hook purges images FIRST (a storage failure leaves the user,
 * their sessions and accounts untouched), only for a signed-in admin removing someone else, and the
 * database hook still purges for paths that skip the endpoint.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ cookie: "" as string }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(hoisted.cookie ? { cookie: hoisted.cookie } : {}),
}));

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct-horse-battery";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 3)]);

describe.skipIf(!url)("remove-user hook and extract route auth (Postgres, local storage, Better Auth)", () => {
  let sql: postgres.Sql;
  let dir: string;
  let authMod: typeof import("@/lib/auth");
  let rc: typeof import("@/lib/receipts");
  let st: typeof import("@/lib/storage");
  let extractRoute: typeof import("@/app/api/receipts/[id]/extract/route");

  type Person = { id: string; email: string; cookie: string };
  let admin: Person;
  let alice: Person;
  let bob: Person;

  async function createPerson(name: string, role: "user" | "admin"): Promise<Person> {
    const email = `${name}@hd-test.local`;
    const signed = await authMod.auth().api.signUpEmail({ body: { email, password: PASSWORD, name } });
    await sql`update "user" set role = ${role} where id = ${signed.user.id}`;
    const login = await authMod.auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return { id: signed.user.id, email, cookie };
  }

  async function upload(owner: Person): Promise<string> {
    const t = await rc.initUpload({ id: owner.id, role: "user" }, { contentType: "image/png", sizeBytes: PNG.length });
    await st.storage().put(st.objectKeyFor(owner.id, t.receiptId), PNG, "image/png");
    return t.receiptId;
  }

  const removeViaHttp = (as: Person | null, userId: string) =>
    authMod.auth().handler(
      new Request(`${ORIGIN}/api/auth/admin/remove-user`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, ...(as ? { cookie: as.cookie } : {}) },
        body: JSON.stringify({ userId }),
      }),
    );

  const exists = async (p: Person) => (await sql`select 1 from "user" where id = ${p.id}`).length === 1;
  const counts = async (p: Person) => ({
    sessions: (await sql`select count(*)::int as n from session where user_id = ${p.id}`)[0].n as number,
    accounts: (await sql`select count(*)::int as n from account where user_id = ${p.id}`)[0].n as number,
    receipts: (await sql`select count(*)::int as n from receipt where owner_id = ${p.id}`)[0].n as number,
  });
  const objectExists = async (p: Person, receiptId: string) => (await st.storage().head(st.objectKeyFor(p.id, receiptId))) !== null;

  async function wipe() {
    await sql`delete from "user" where email like '%@hd-test.local'`;
    await sql`delete from daily_usage`;
  }

  /** Make storage deletes fail for the rest of the test (the returned function restores them). */
  function breakStorageRemove() {
    const driver = st.storage();
    const original = driver.remove;
    driver.remove = async () => {
      throw new st.StorageError();
    };
    return () => {
      driver.remove = original;
    };
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "remove-user-it-"));
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: "h".repeat(40),
      APP_URL: ORIGIN,
      STORAGE_LOCAL_DIR: dir,
      AI_PROVIDER: "demo",
      LOG_LEVEL: "error",
    });
    delete process.env.STORAGE_BUCKET;
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await wipe();
    (await import("@/lib/env")).resetEnvCache();
    st = await import("@/lib/storage");
    st.resetStorage();
    authMod = await import("@/lib/auth");
    rc = await import("@/lib/receipts");
    extractRoute = await import("@/app/api/receipts/[id]/extract/route");
  });

  beforeEach(async () => {
    await wipe();
    hoisted.cookie = "";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    admin = await createPerson("hd-admin", "admin");
    alice = await createPerson("hd-alice", "user");
    bob = await createPerson("hd-bob", "user");
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await wipe();
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  describe("admin remove-user", () => {
    it("purges the images, then removes the user", async () => {
      const ids = [await upload(alice), await upload(alice)];
      const res = await removeViaHttp(admin, alice.id);
      expect(res.status).toBe(200);
      expect(await exists(alice)).toBe(false);
      for (const id of ids) expect(await objectExists(alice, id)).toBe(false);
      expect((await sql`select count(*)::int as n from receipt where owner_id = ${alice.id}`)[0].n).toBe(0);
      expect(await exists(bob)).toBe(true);
    });

    it("on a storage failure aborts first: user, sessions, accounts and receipts all stay", async () => {
      const id = await upload(alice);
      const before = await counts(alice);
      expect(before.sessions).toBeGreaterThan(0);
      expect(before.accounts).toBe(1);
      const restore = breakStorageRemove();
      try {
        const res = await removeViaHttp(admin, alice.id);
        expect(res.status).toBe(502);
        expect(JSON.stringify(await res.json())).not.toMatch(/stack|at .*\(/);
      } finally {
        restore();
      }
      expect(await exists(alice)).toBe(true);
      expect(await counts(alice)).toEqual(before);
      expect(await objectExists(alice, id)).toBe(true);
      // Alice can still sign in, and once storage is back the same request succeeds.
      await authMod.auth().api.signInEmail({ body: { email: alice.email, password: PASSWORD } });
      expect((await removeViaHttp(admin, alice.id)).status).toBe(200);
      expect(await objectExists(alice, id)).toBe(false);
    });

    it("does not purge for anyone who isn't a signed-in admin (the hook runs before the endpoint's own check)", async () => {
      const id = await upload(alice);
      const outsiders: (Person | null)[] = [null, bob, alice];
      for (const who of outsiders) {
        const res = await removeViaHttp(who, alice.id);
        expect([400, 401, 403]).toContain(res.status);
      }
      expect(await exists(alice)).toBe(true);
      expect(await objectExists(alice, id)).toBe(true);
      expect((await counts(alice)).receipts).toBe(1);
    });

    it('does not purge for a role like "user, admin" (Better Auth splits on "," without trimming, so the endpoint says 403)', async () => {
      const id = await upload(bob);
      await sql`update "user" set role = 'user, admin' where id = ${admin.id}`;
      const res = await removeViaHttp(admin, bob.id);
      expect(res.status).toBe(403);
      expect(await exists(bob)).toBe(true);
      expect(await objectExists(bob, id)).toBe(true);
      expect((await counts(bob)).receipts).toBe(1);
    });

    it("a banned admin gets no purge from the hook (Better Auth itself still lets the removal through)", async () => {
      const id = await upload(bob);
      await sql`update "user" set banned = true where id = ${admin.id}`;
      const restore = breakStorageRemove();
      let res: Response;
      try {
        res = await removeViaHttp(admin, bob.id);
      } finally {
        restore();
      }
      // With storage down, the hook's own 502 ("so the user was not removed") would appear if it had run.
      expect(await res.text()).not.toMatch(/was not removed/);
      expect(res.status).not.toBe(502);
      expect(await objectExists(bob, id)).toBe(true);
    });

    it("does not purge when an admin tries to remove themselves", async () => {
      const id = await upload(admin);
      const res = await removeViaHttp(admin, admin.id);
      expect(res.status).toBe(400);
      expect(await exists(admin)).toBe(true);
      expect(await objectExists(admin, id)).toBe(true);
    });

    it("leaves a user alone when the id doesn't exist (404 from the endpoint)", async () => {
      const res = await removeViaHttp(admin, "no-such-user");
      expect(res.status).toBe(404);
    });
  });

  describe("database hook backstop", () => {
    it("still purges when a user is deleted outside the endpoint", async () => {
      const id = await upload(alice);
      const ctx = await authMod.auth().$context;
      await ctx.internalAdapter.deleteUser(alice.id);
      expect(await exists(alice)).toBe(false);
      expect(await objectExists(alice, id)).toBe(false);
    });

    it("aborts the user-row deletion when storage fails", async () => {
      const id = await upload(alice);
      const ctx = await authMod.auth().$context;
      const restore = breakStorageRemove();
      try {
        await expect(ctx.internalAdapter.deleteUser(alice.id)).rejects.toMatchObject({ status: 502 });
      } finally {
        restore();
      }
      // Documented limit: sessions and accounts are already gone on this path; the user row and files remain.
      expect(await exists(alice)).toBe(true);
      expect(await objectExists(alice, id)).toBe(true);
    });
  });

  describe("POST /api/receipts/[id]/extract", () => {
    const call = (id: string, headers: Record<string, string>) =>
      extractRoute.POST(new Request(`${ORIGIN}/api/receipts/${id}/extract`, { method: "POST", headers }), {
        params: Promise.resolve({ id }),
      });

    it("is 401 without a session", async () => {
      const id = await upload(alice);
      hoisted.cookie = "";
      const res = await call(id, { origin: ORIGIN });
      expect(res.status).toBe(401);
      expect((await sql`select extraction_mode from receipt where id = ${id}`)[0].extraction_mode).toBeNull();
    });

    it("is 403 from another origin, or with no Origin, even with a valid session", async () => {
      const id = await upload(alice);
      hoisted.cookie = alice.cookie;
      expect((await call(id, { origin: "https://evil.example" })).status).toBe(403);
      expect((await call(id, {})).status).toBe(403);
      expect((await sql`select extraction_mode, extraction from receipt where id = ${id}`)[0]).toMatchObject({ extraction_mode: null, extraction: null });
      expect((await sql`select count(*)::int as n from rate_event where kind = 'extract'`)[0].n).toBe(0);
    });

    it("is 404 for another user (and for admin), and 200 for the owner", async () => {
      const id = await upload(alice);
      for (const other of [bob, admin]) {
        hoisted.cookie = other.cookie;
        expect((await call(id, { origin: ORIGIN })).status).toBe(404);
      }
      hoisted.cookie = alice.cookie;
      const res = await call(id, { origin: ORIGIN });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ receiptId: id, mode: "demo" });
    });
  });
});
