/**
 * Better Auth skips its origin check when NODE_ENV is "test" or TEST is truthy (Vitest sets TEST=true), so
 * this file sets NODE_ENV=development and TEST=false before Better Auth is imported. Proves a cross-origin POST to /admin/remove-user, even with a valid
 * admin session, removes nothing and purges nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:3000";
const PASSWORD = "correct-horse-battery";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 3)]);

describe.skipIf(!url)("remove-user origin check (NODE_ENV=development)", () => {
  let sql: postgres.Sql;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "remove-user-origin-"));
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TEST", "false"); // Vitest also sets TEST=true, which Better Auth reads the same way as NODE_ENV=test
    Object.assign(process.env, {
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: "o".repeat(40),
      APP_URL: ORIGIN,
      STORAGE_LOCAL_DIR: dir,
      AI_PROVIDER: "demo",
      LOG_LEVEL: "error",
    });
    delete process.env.STORAGE_BUCKET;
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where email like '%@origin-test.local'`;
  });

  afterAll(async () => {
    await sql`delete from "user" where email like '%@origin-test.local'`;
    await sql.end();
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("is refused for a foreign or missing Origin, and nothing is purged", async () => {
    const { auth } = await import("@/lib/auth");
    const st = await import("@/lib/storage");
    const rc = await import("@/lib/receipts");
    (await import("@/lib/env")).resetEnvCache();
    st.resetStorage();

    const make = async (name: string, role: string) => {
      const email = `${name}@origin-test.local`;
      const signed = await auth().api.signUpEmail({ body: { email, password: PASSWORD, name } });
      await sql`update "user" set role = ${role} where id = ${signed.user.id}`;
      const login = await auth().api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
      return { id: signed.user.id, cookie: login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    };
    const admin = await make("origin-admin", "admin");
    const victim = await make("origin-victim", "user");
    const t = await rc.initUpload({ id: victim.id, role: "user" }, { contentType: "image/png", sizeBytes: PNG.length });
    await st.storage().put(st.objectKeyFor(victim.id, t.receiptId), PNG, "image/png");

    const post = (origin?: string) =>
      auth().handler(
        new Request(`${ORIGIN}/api/auth/admin/remove-user`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: admin.cookie, ...(origin ? { origin } : {}) },
          body: JSON.stringify({ userId: victim.id }),
        }),
      );

    for (const origin of ["https://evil.example", undefined]) {
      const res = await post(origin);
      expect(res.status, String(origin)).toBe(403);
      expect((await sql`select 1 from "user" where id = ${victim.id}`).length).toBe(1);
      expect(await st.storage().head(st.objectKeyFor(victim.id, t.receiptId))).not.toBeNull();
      expect((await sql`select 1 from receipt where id = ${t.receiptId}`).length).toBe(1);
    }
    // Control: the same request from our own origin works, so the refusals above were the origin check.
    expect((await post(ORIGIN)).status).toBe(200);
    expect(await st.storage().head(st.objectKeyFor(victim.id, t.receiptId))).toBeNull();
  });
});
