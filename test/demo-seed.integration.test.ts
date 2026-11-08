/**
 * The demo workspace: CLI refusal rules, the bundled receipt images, the loader against a real Postgres
 * (TEST_DATABASE_URL) and the local storage driver, and POST /api/admin/demo. Proves a reload replaces
 * exactly the demo users' rows and objects, and that real users' rows and objects survive.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/auth/rbac";
import { DEMO_RECEIPTS, modelAnswerFor } from "@/lib/demo-receipt-data";
import { demoSeedConfig } from "@/lib/demo-seed-config";
import { demoFixtures } from "@/lib/ai/demo";
import { modelOutputSchema } from "@/lib/extract-receipt";
import { matchesMagic } from "@/lib/magic";

const current = vi.hoisted(() => ({ actor: { id: "ds-admin", role: "admin" as "admin" | "user", name: "Admin", email: "ds-admin@test.local" } }));
vi.mock("@/lib/auth/session", () => ({
  requireRole: vi.fn(async () => {
    if (current.actor.role !== "admin") throw new ForbiddenError();
    return current.actor;
  }),
}));

const base = { DEMO_SEED: "yes", APP_URL: "http://localhost:3000", DEMO_PASSWORD: "demo-test-password-123" };
const tsxArgs = ["--conditions=react-server", "--import", "tsx", "scripts/seed-demo.mts"];

describe("demo CLI guards", () => {
  it.each([undefined, "no", "true"])("refuses DEMO_SEED=%s", (value) => {
    expect(() => demoSeedConfig({ ...base, DEMO_SEED: value })).toThrow("DEMO_SEED=yes");
  });
  it.each([
    "https://app3.breakthruventures.ai",
    "https://APP3.BREAKTHRUVENTURES.AI.:443/path",
    "https://expense-tracker-abc123-uc.a.run.app",
    "https://notes.env.eastus.azurecontainerapps.io",
  ])("refuses production URL %s", (APP_URL) => {
    expect(() => demoSeedConfig({ ...base, APP_URL })).toThrow("production host");
  });
  it("refuses a missing or invalid APP_URL with a readable message", () => {
    for (const APP_URL of [undefined, "not a url"]) expect(() => demoSeedConfig({ ...base, APP_URL })).toThrow(/^Demo seed refused: /);
  });
  it("refuses an Azure database host and allows a local one", () => {
    expect(() => demoSeedConfig({ ...base, DATABASE_URL: "postgres://u:p@x.postgres.database.azure.com:5432/db" })).toThrow("production database");
    expect(() => demoSeedConfig({ ...base, DATABASE_URL: "postgres://u:p@localhost:5432/db" })).not.toThrow();
  });
  it("allows a lookalike host that only contains the production name", () => {
    expect(demoSeedConfig({ ...base, APP_URL: "https://app3.breakthruventures.ai.evil.com" }).appUrl).toContain("evil.com");
  });
  it("needs an explicit password of at least 10 characters", () => {
    expect(demoSeedConfig(base).password).toBe(base.DEMO_PASSWORD);
    expect(() => demoSeedConfig({ ...base, DEMO_PASSWORD: undefined })).toThrow();
    expect(() => demoSeedConfig({ ...base, DEMO_PASSWORD: "short" })).toThrow();
  });
  it.each([
    { ...base, DEMO_SEED: "no" },
    { ...base, APP_URL: "https://app3.breakthruventures.ai" },
    { ...base, APP_URL: "https://expense-tracker-abc123-uc.a.run.app" },
  ])("the actual CLI exits before connecting to a database (%j)", (values) => {
    const child = spawnSync(process.execPath, tsxArgs, {
      env: { ...process.env, ...values, DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/invalid" },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("Demo seed refused");
    expect(child.stderr).not.toContain("ECONNREFUSED");
  });
});

describe("bundled demo receipts", () => {
  it("has five receipt PNGs plus landscape.png, each a valid PNG of at most 150 KB", async () => {
    const files = [...DEMO_RECEIPTS.map((r) => r.file), "landscape.png"];
    expect(files).toEqual(["bluebird-coffee.png", "hotel-folio.png", "injection.png", "taxi.png", "office-supplies.png", "landscape.png"]);
    for (const f of files) {
      const file = path.join(process.cwd(), "public", "demo-receipts", f);
      expect((await stat(file)).size).toBeLessThanOrEqual(150 * 1024);
      expect(matchesMagic("image/png", await readFile(file))).toBe(true);
    }
  });

  it("the Bluebird receipt matches the recorded demo fixture", () => {
    const bluebird = DEMO_RECEIPTS.find((r) => r.slug === "bluebird-coffee")!;
    expect(modelAnswerFor(bluebird)).toEqual(demoFixtures["extract-receipt"]);
  });

  it("every receipt's printed numbers add up and parse as a model answer without warnings", async () => {
    const { applyGuardrails } = await import("@/lib/extract-receipt");
    for (const r of DEMO_RECEIPTS) {
      const sum = r.lines.reduce((a, l) => a + Math.round(l.amount * 100), 0) + Math.round((r.tax ?? 0) * 100);
      expect(sum, r.slug).toBe(Math.round(r.total * 100));
      expect(applyGuardrails(modelOutputSchema.parse(modelAnswerFor(r)), new Date("2026-11-08T12:00:00Z")).warnings, r.slug).toEqual([]);
    }
  });

  it("injection.png carries on-image instructions that the stored answer ignores", () => {
    const inj = DEMO_RECEIPTS.find((r) => r.slug === "injection")!;
    expect(inj.injectedText?.join(" ")).toMatch(/ignore all previous instructions/i);
    expect(modelAnswerFor(inj)).toMatchObject({ total: 48.2, category: "meals", merchant: "Corner Bistro" });
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("demo workspace (Postgres, Better Auth, local storage)", () => {
  let sql: postgres.Sql;
  let dir: string;
  let loader: typeof import("@/lib/demo-workspace");
  let rx: typeof import("@/lib/receipt-extraction");
  let st: typeof import("@/lib/storage");
  let envMod: typeof import("@/lib/env");
  let api: ReturnType<typeof import("@/lib/auth").auth>;
  let post: typeof import("@/app/api/admin/demo/route").POST;
  const actor = { id: "ds-admin", role: "admin" as const };
  const real = { id: "ds-real", role: "user" as const };
  const demoEmails = ["ada", "ben", "cleo"].map((n) => `${n}@demo.breakthru.test`);
  const NOW = new Date("2026-11-08T12:00:00Z");
  const req = (origin = "http://localhost:3000") => new Request("http://localhost:3000/api/admin/demo", { method: "POST", headers: { origin } });
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);

  async function clean() {
    await sql`delete from "user" where email in ${sql(demoEmails)} or email like 'ds-signup-%'`;
    await sql`delete from expense where owner_id in ('ds-real', 'ds-admin')`;
    await sql`delete from receipt where owner_id in ('ds-real', 'ds-admin')`;
    await sql`delete from rate_event where user_id like 'ds-%' or kind = 'demo_load'`;
    await sql`delete from daily_usage`;
  }
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "demo-seed-it-"));
    Object.assign(process.env, base, {
      NODE_ENV: "test",
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: "demo-integration-secret-32-characters",
      AI_PROVIDER: "demo",
      LOG_LEVEL: "error",
      STORAGE_LOCAL_DIR: dir,
    });
    delete process.env.STORAGE_BUCKET;
    envMod = await import("@/lib/env");
    envMod.resetEnvCache();
    st = await import("@/lib/storage");
    st.resetStorage();
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id in ('ds-admin', 'ds-real')`;
    for (const p of [actor, real]) {
      await sql`insert into "user" (id, name, email, role) values (${p.id}, ${p.id}, ${p.id + "@test.local"}, ${p.role})`;
    }
    loader = await import("@/lib/demo-workspace");
    rx = await import("@/lib/receipt-extraction");
    api = (await import("@/lib/auth")).auth();
    post = (await import("@/app/api/admin/demo/route")).POST;
  });
  beforeEach(async () => {
    await clean();
    current.actor.role = "admin";
  });
  afterAll(async () => {
    await clean();
    await sql`delete from "user" where id in ('ds-admin', 'ds-real')`;
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  const load = (mode: "cli" | "admin" = "cli") => loader.loadDemoWorkspace(actor, { mode }, NOW);

  async function snapshot() {
    return sql`select u.email, x.merchant, x.spent_on::text as spent_on, x.amount_minor, x.tax_minor, x.currency, x.category, x.note, x.source, x.ai_mode,
      r.content_type, r.size_bytes, r.status, r.extraction, r.extraction_mode
      from expense x join "user" u on u.id = x.owner_id left join receipt r on r.id = x.receipt_id
      where u.email in ${sql(demoEmails)} order by u.email, x.spent_on, x.merchant`;
  }
  async function objectFiles(ownerIds: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of ownerIds) {
      try {
        out.push(...(await readdir(path.join(dir, "u", id))).filter((f) => !f.endsWith(".meta")).map((f) => `u/${id}/${f}`));
      } catch {
        /* no directory yet */
      }
    }
    return out.sort();
  }
  const demoIds = async () => (await sql`select id from "user" where email in ${sql(demoEmails)} order by email`).map((r) => r.id as string);

  it("loads 3 users, 30 expenses across every category and 5 receipts with demo extractions", async () => {
    expect(await load()).toEqual({ users: 3, expenses: 30, receipts: 5 });
    const rows = await snapshot();
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(["meals", "travel", "lodging", "transport", "office", "software", "equipment", "other"]));
    const withReceipt = rows.filter((r) => r.status);
    expect(withReceipt).toHaveLength(5);
    for (const r of withReceipt) {
      expect(r).toMatchObject({ status: "ready", content_type: "image/png", extraction_mode: "demo", source: "receipt", ai_mode: "demo" });
      expect(r.size_bytes).toBeLessThanOrEqual(150 * 1024);
    }
    // Manual rows are within the last ~3 months of the load date.
    const oldest = rows.map((r) => r.spent_on as string).sort()[0];
    expect(oldest >= "2026-08-01").toBe(true);
    const perUser = await sql`select u.email, count(*)::int as n from expense x join "user" u on u.id = x.owner_id where u.email in ${sql(demoEmails)} group by u.email order by u.email`;
    expect(perUser.map((r) => r.n)).toEqual([10, 10, 10]);
  }, 30000);

  it("stores the bundled image bytes and the same draft the extraction endpoint would, with no model call", async () => {
    await load();
    const [{ id: adaId }] = await sql`select id from "user" where email = 'ada@demo.breakthru.test'`;
    const [bluebird] = await sql`select r.id, r.object_key, r.extraction, r.extraction_mode, r.size_bytes from receipt r join expense x on x.receipt_id = r.id where r.owner_id = ${adaId} and x.merchant = 'Bluebird Coffee'`;
    const bytes = await readFile(path.join(process.cwd(), "public", "demo-receipts", "bluebird-coffee.png"));
    expect(bluebird.size_bytes).toBe(bytes.length);
    expect((await st.storage().read(bluebird.object_key, 5 * 1024 * 1024))?.equals(bytes)).toBe(true);
    expect(bluebird.extraction_mode).toBe("demo");
    expect(bluebird.extraction).toMatchObject({
      isReceipt: true,
      confidence: "high",
      warnings: [],
      draft: { merchant: "Bluebird Coffee", spentOn: "2026-10-14", currency: "USD", category: "meals", total: "12.40", tax: "0.95" },
    });
    // The extraction endpoint treats it as finished: it returns the stored answer, spending no scan.
    const out = await rx.extractReceipt({ id: adaId, role: "user" }, bluebird.id);
    expect(out).toMatchObject({ receiptId: bluebird.id, mode: "demo" });
    expect(await sql`select 1 from daily_usage where kind = 'extract'`).toHaveLength(0);
    expect(await sql`select 1 from rate_event where kind = 'extract' and user_id = ${adaId}`).toHaveLength(0);
  }, 30000);

  it("the injection receipt's stored draft ignores the printed instructions", async () => {
    await load();
    const [row] = await sql`select r.extraction from receipt r join expense x on x.receipt_id = r.id where x.merchant = 'Corner Bistro'`;
    expect(row.extraction.draft).toMatchObject({ total: "48.20", category: "meals", merchant: "Corner Bistro" });
    expect(JSON.stringify(row.extraction)).not.toMatch(/approved|travel-premium|0\.01/);
  }, 30000);

  it("a second load gives identical data, deletes the old demo objects, and keeps real users' rows and objects", async () => {
    // A real user with an expense, an attached receipt and a draft receipt, each with a stored object.
    const key = async (suffix: string) => {
      const id = (await sql`select gen_random_uuid()::text as id`)[0].id as string;
      const objectKey = st.objectKeyFor(real.id, id);
      await st.storage().put(objectKey, PNG, "image/png");
      await sql`insert into receipt (id, owner_id, object_key, content_type, size_bytes, status) values (${id}, ${real.id}, ${objectKey}, 'image/png', ${PNG.length}, 'ready')`;
      return { id, objectKey, suffix };
    };
    const attached = await key("attached");
    const draft = await key("draft");
    await sql`insert into expense (owner_id, merchant, spent_on, amount_minor, source, receipt_id) values (${real.id}, 'Real Cafe', '2026-10-01', 500, 'receipt', ${attached.id})`;

    await load();
    const first = await snapshot();
    const idsBefore = await demoIds();
    const filesBefore = await objectFiles(idsBefore);
    expect(filesBefore).toHaveLength(5);
    // Extra data a demo user added in between is replaced too.
    await sql`insert into expense (owner_id, merchant, spent_on, amount_minor) values (${idsBefore[0]}, 'Added later', '2026-10-01', 100)`;

    expect(await load()).toEqual({ users: 3, expenses: 30, receipts: 5 });
    expect(await snapshot()).toEqual(first);
    expect(await demoIds()).toEqual(idsBefore);
    const filesAfter = await objectFiles(idsBefore);
    expect(filesAfter).toHaveLength(5);
    // The old objects are gone from storage (new random receipt ids), not just unreferenced.
    expect(filesAfter.filter((f) => filesBefore.includes(f))).toEqual([]);
    expect((await sql`select count(*)::int as n from receipt r join "user" u on u.id = r.owner_id where u.email in ${sql(demoEmails)}`)[0].n).toBe(5);

    // Real user's data is untouched.
    expect(await sql`select merchant from expense where owner_id = ${real.id}`).toEqual([{ merchant: "Real Cafe" }]);
    expect(await sql`select id from receipt where owner_id = ${real.id} order by id`).toHaveLength(2);
    for (const r of [attached, draft]) {
      expect((await st.storage().head(r.objectKey))?.size).toBe(PNG.length);
    }
  }, 60000);

  it("CLI mode gives Ada admin and a known password; the CLI runs end to end", async () => {
    const child = spawnSync(process.execPath, tsxArgs, { env: { ...process.env, ...base, DATABASE_URL: url }, encoding: "utf8", timeout: 40000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("Loaded 3 demo users, 30 expenses and 5 receipts.");
    expect((await sql`select role from "user" where email = 'ada@demo.breakthru.test'`)[0].role).toBe("admin");
    expect((await api.api.signInEmail({ body: { email: "ben@demo.breakthru.test", password: base.DEMO_PASSWORD } })).user.id).toBeTruthy();
    expect(await snapshot()).toHaveLength(30);
  }, 60000);

  it("admin mode creates unprivileged users with unknown, distinct passwords and ends their sessions on reload", async () => {
    await load("admin");
    expect((await sql`select role from "user" where email in ${sql(demoEmails)}`).every((u) => u.role === "user")).toBe(true);
    const hashes = await sql`select a.password from account a join "user" u on u.id = a.user_id where u.email in ${sql(demoEmails)}`;
    expect(new Set(hashes.map((h) => h.password)).size).toBe(3);
    await load("cli");
    const signed = await api.api.signInEmail({ body: { email: "ada@demo.breakthru.test", password: base.DEMO_PASSWORD } });
    await load("admin");
    expect(await sql`select 1 from session where token = ${signed.token}`).toHaveLength(0);
    await expect(api.api.signInEmail({ body: { email: "ada@demo.breakthru.test", password: base.DEMO_PASSWORD } })).rejects.toBeDefined();
    expect((await sql`select role from "user" where email in ${sql(demoEmails)}`).every((u) => u.role === "user")).toBe(true);
  }, 60000);

  it("the loader refuses non-admins and unknown options", async () => {
    await expect(loader.loadDemoWorkspace(real)).rejects.toMatchObject({ status: 403 });
    await expect(loader.loadDemoWorkspace(actor, { mode: "cli", password: "override" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(loader.reserveDemoLoad(real)).rejects.toMatchObject({ status: 403 });
    expect(await snapshot()).toHaveLength(0);
  });

  it("route: admin loads and gets the counts; the second call in a minute is 429", async () => {
    const first = await post(req());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ users: 3, expenses: 30, receipts: 5 });
    const second = await post(req());
    expect(second.status).toBe(429);
    expect((await second.json()).error).toMatch(/once per minute/);
    expect(await snapshot()).toHaveLength(30);
  }, 60000);

  it("route rejects non-admins and foreign or missing Origin before reserving a load or changing anything", async () => {
    current.actor.role = "user";
    expect((await post(req())).status).toBe(403);
    current.actor.role = "admin";
    expect((await post(req("https://other.breakthruventures.ai"))).status).toBe(403);
    expect((await post(new Request("http://localhost:3000/api/admin/demo", { method: "POST" }))).status).toBe(403);
    expect(await sql`select 1 from rate_event where kind = 'demo_load'`).toHaveLength(0);
    expect(await sql`select 1 from daily_usage where kind = 'demo_load'`).toHaveLength(0);
    expect(await snapshot()).toHaveLength(0);
  });

  it("allows 5 loads per UTC day app-wide, then refuses without changing data", async () => {
    for (let i = 0; i < 5; i++) {
      await loader.reserveDemoLoad(actor);
      await sql`delete from rate_event where kind = 'demo_load'`; // skip the minute wait
    }
    await expect(loader.reserveDemoLoad(actor)).rejects.toMatchObject({ status: 429 });
    expect((await sql`select count from daily_usage where kind = 'demo_load'`)[0].count).toBe(5);
    expect((await post(req())).status).toBe(429);
    expect(await sql`select 1 from rate_event where kind = 'demo_load'`).toHaveLength(0);
    expect(await snapshot()).toHaveLength(0);
  });

  it("reserves one call under concurrency and expires the minute window", async () => {
    const results = await Promise.allSettled([loader.reserveDemoLoad(actor), loader.reserveDemoLoad(actor)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 429 });
    await sql`update rate_event set at = now() - interval '61 seconds' where kind = 'demo_load'`;
    await loader.reserveDemoLoad(actor);
  });

  it("serializes concurrent loads", async () => {
    await Promise.all([load(), load()]);
    expect(await snapshot()).toHaveLength(30);
    expect(await objectFiles(await demoIds())).toHaveLength(5);
  }, 90000);

  it("refuses with a 503 and changes nothing when receipt storage is not configured", async () => {
    const prev = process.env.NODE_ENV;
    try {
      Object.assign(process.env, { NODE_ENV: "production" });
      envMod.resetEnvCache();
      st.resetStorage();
      expect(() => loader.assertDemoStorage()).toThrow(expect.objectContaining({ status: 503 }));
      expect((await post(req())).status).toBe(503);
      expect(await sql`select 1 from rate_event where kind = 'demo_load'`).toHaveLength(0);
    } finally {
      Object.assign(process.env, { NODE_ENV: prev });
      envMod.resetEnvCache();
      st.resetStorage();
    }
  });

  it("public sign-up and profile update cannot claim a demo email or the marker, and the loader still works", async () => {
    const signUp = (payload: Record<string, unknown>) =>
      api.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ name: "Mallory", password: base.DEMO_PASSWORD, ...payload }),
      }));
    expect((await signUp({ email: "mallory@demo.breakthru.test" })).status).toBe(400);
    expect((await signUp({ email: "ds-signup-marker@test.local", image: "urn:breakthru:expense-demo:v1" })).status).toBe(400);
    expect(await sql`select 1 from "user" where email in ('mallory@demo.breakthru.test', 'ds-signup-marker@test.local')`).toHaveLength(0);
    const ok = await signUp({ email: "ds-signup-ok@test.local" });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const update = await api.handler(new Request("http://localhost:3000/api/auth/update-user", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json", cookie },
      body: JSON.stringify({ image: "urn:breakthru:expense-demo:v1" }),
    }));
    expect(update.status).toBe(400);
    expect(await load()).toEqual({ users: 3, expenses: 30, receipts: 5 });
  }, 60000);

  it("refuses to adopt an unrelated account at a demo address, and nothing is replaced", async () => {
    const collision = await api.api.createUser({ body: { email: "ada@demo.breakthru.test", name: "Real Ada", password: base.DEMO_PASSWORD } });
    const owner = { id: collision.user.id, role: "user" as const };
    await sql`insert into expense (owner_id, merchant, spent_on, amount_minor) values (${owner.id}, 'Keep me', '2026-10-01', 100)`;
    await expect(loader.loadDemoWorkspace(actor, { mode: "admin" }, NOW)).rejects.toMatchObject({ status: 409 });
    expect(await sql`select merchant from expense where owner_id = ${owner.id}`).toEqual([{ merchant: "Keep me" }]);
    expect((await api.api.signInEmail({ body: { email: collision.user.email, password: base.DEMO_PASSWORD } })).user.id).toBe(owner.id);
  }, 30000);

  it("a stale demo-user rate ledger is cleared on reload", async () => {
    await load();
    const [{ id: adaId }] = await sql`select id from "user" where email = 'ada@demo.breakthru.test'`;
    for (let i = 0; i < 3; i++) await sql`insert into rate_event (user_id, kind) values (${adaId}, 'download')`;
    await load();
    expect(await sql`select 1 from rate_event where user_id = ${adaId}`).toHaveLength(0);
  }, 60000);
});
