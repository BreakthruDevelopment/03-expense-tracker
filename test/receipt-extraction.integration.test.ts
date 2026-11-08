/**
 * Receipt extraction against a real Postgres (TEST_DATABASE_URL) and the local storage driver.
 * `generate` is wrapped so most tests stub the model; the demo-mode test uses the real gateway
 * with no network. Proves: owner-only (404 for admin too), a rejected file never reaches the
 * model, once per receipt, caps, failure handling, and that nothing is saved by extraction.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", async (orig) => {
  const actual = await orig<typeof import("@/lib/ai")>();
  return { ...actual, generate: vi.fn(actual.generate) };
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("receipt extraction (Postgres, local storage)", () => {
  let sql: postgres.Sql;
  let dir: string;
  let ai: typeof import("@/lib/ai");
  let rx: typeof import("@/lib/receipt-extraction");
  let rc: typeof import("@/lib/receipts");
  let ex: typeof import("@/lib/expenses");
  let st: typeof import("@/lib/storage");
  let envMod: typeof import("@/lib/env");
  let logs: string[];

  const alice = { id: "rx-alice", role: "user" as const };
  const bob = { id: "rx-bob", role: "user" as const };
  const admin = { id: "rx-admin", role: "admin" as const };

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 3)]);
  const HTML = Buffer.from("<html><script>alert(1)</script></html>".padEnd(800, " "));
  const model = {
    isReceipt: true,
    merchant: "Secret Merchant Ltd",
    date: "2026-10-14",
    currency: "USD",
    total: 98765.43,
    tax: null,
    category: "meals",
    lineItems: [],
    confidence: "high",
  };
  const gen = () => ai.generate as unknown as ReturnType<typeof vi.fn>;
  const answer = (raw: unknown) =>
    gen().mockImplementationOnce(async (req: { schema: { parse: (v: unknown) => unknown } }) => ({ data: req.schema.parse(raw), provider: "stub", model: "stub", demo: false, latencyMs: 3 }));

  async function upload(actor: typeof alice, bytes: Buffer, type: "image/png" | "image/jpeg" = "image/png") {
    const t = await rc.initUpload(actor, { contentType: type, sizeBytes: bytes.length });
    await st.storage().put(st.objectKeyFor(actor.id, t.receiptId), bytes, type);
    return t.receiptId;
  }
  const row = async (id: string) => (await sql`select status, extraction, extraction_mode from receipt where id = ${id}`)[0];
  const expenseCount = async () => (await sql`select count(*)::int as n from expense where owner_id like 'rx-%'`)[0].n as number;

  async function wipe() {
    await sql`delete from expense where owner_id like 'rx-%'`;
    await sql`delete from receipt where owner_id like 'rx-%'`;
    await sql`delete from rate_event where user_id like 'rx-%'`;
    await sql`delete from daily_usage`;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "extract-it-"));
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: "e".repeat(40),
      APP_URL: "http://localhost:3000",
      STORAGE_LOCAL_DIR: dir,
      AI_PROVIDER: "demo",
      LOG_LEVEL: "info",
    });
    delete process.env.STORAGE_BUCKET;
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id like 'rx-%'`;
    for (const u of [alice, bob, admin]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@rx-test.local"}, ${u.role})`;
    }
    envMod = await import("@/lib/env");
    envMod.resetEnvCache();
    st = await import("@/lib/storage");
    st.resetStorage();
    ai = await import("@/lib/ai");
    rx = await import("@/lib/receipt-extraction");
    rc = await import("@/lib/receipts");
    ex = await import("@/lib/expenses");
  });

  beforeEach(async () => {
    delete process.env.EXTRACT_DAILY_CAP;
    process.env.AI_PROVIDER = "demo";
    envMod.resetEnvCache();
    gen().mockClear();
    await wipe();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void logs.push(String(l)));
    vi.spyOn(console, "error").mockImplementation((l: string) => void logs.push(String(l)));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await wipe();
    await sql`delete from "user" where id like 'rx-%'`;
    await sql.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("is 404 for another user and for admin, with no model call and no usage recorded", async () => {
    const id = await upload(alice, PNG);
    for (const other of [bob, admin]) {
      await expect(rx.extractReceipt(other, id)).rejects.toMatchObject({ status: 404 });
    }
    await expect(rx.extractReceipt(alice, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
    expect(gen()).not.toHaveBeenCalled();
    expect((await sql`select count(*)::int as n from rate_event where kind = 'extract'`)[0].n).toBe(0);
    expect((await row(id)).extraction_mode).toBeNull();
  });

  it("works end to end in demo mode with no network, and saves no expense", async () => {
    const id = await upload(alice, PNG);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await rx.extractReceipt(alice, id);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(out.mode).toBe("demo");
    expect(out.extraction?.draft).toMatchObject({ merchant: "Bluebird Coffee", total: "12.40", totalMinor: "1240", category: "meals" });
    const r = await row(id);
    expect(r.extraction_mode).toBe("demo");
    expect(r.status).toBe("ready");
    expect(await expenseCount()).toBe(0);
    // The draft is still attachable by the owner through the normal create path.
    const e = await ex.createExpense(alice, { merchant: "Bluebird Coffee", spentOn: "2026-10-14", amount: "12.40", receiptId: id });
    expect(e.receiptId).toBe(id);
  });

  it("passes the verified image to generate once and stores the live result", async () => {
    const id = await upload(alice, PNG);
    answer(model);
    const out = await rx.extractReceipt(alice, id);
    expect(out.mode).toBe("live");
    expect(gen()).toHaveBeenCalledTimes(1);
    const req = gen().mock.calls[0][0];
    expect(req.task).toBe("extract-receipt");
    expect(req.images).toEqual([{ mimeType: "image/png", data: PNG.toString("base64") }]);
    const r = await row(id);
    expect(r.extraction_mode).toBe("live");
    expect(r.extraction.draft.totalMinor).toBe("9876543");
  });

  it("runs the model once per receipt: a repeat returns the stored result", async () => {
    const id = await upload(alice, PNG);
    answer(model);
    const first = await rx.extractReceipt(alice, id);
    const again = await rx.extractReceipt(alice, id);
    expect(again).toEqual(first);
    expect(gen()).toHaveBeenCalledTimes(1);
    expect((await sql`select count(*)::int as n from rate_event where kind = 'extract'`)[0].n).toBe(1);
    expect((await sql`select count from daily_usage where kind = 'extract'`)[0].count).toBe(1);
  });

  it("lets only one of two concurrent requests call the model", async () => {
    const id = await upload(alice, PNG);
    gen().mockImplementationOnce(async (req: { schema: { parse: (v: unknown) => unknown } }) => {
      await new Promise((r) => setTimeout(r, 150));
      return { data: req.schema.parse(model), provider: "stub", model: "stub", demo: false, latencyMs: 150 };
    });
    const results = await Promise.allSettled([rx.extractReceipt(alice, id), rx.extractReceipt(alice, id)]);
    expect(gen()).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409 });
  });

  it("rejects a disguised file with 422, deletes it, and never reaches generate", async () => {
    const id = await upload(alice, HTML);
    await expect(rx.extractReceipt(alice, id)).rejects.toMatchObject({ status: 422 });
    expect(gen()).not.toHaveBeenCalled();
    expect(await row(id)).toBeUndefined();
    expect(await st.storage().head(st.objectKeyFor(alice.id, id))).toBeNull();
    expect((await sql`select count(*)::int as n from rate_event where kind = 'extract'`)[0].n).toBe(0);
  });

  it("re-checks the bytes: an object swapped for HTML after confirm is rejected before the model", async () => {
    const id = await upload(alice, PNG);
    await rc.verifyUpload(alice, id);
    await st.storage().put(st.objectKeyFor(alice.id, id), HTML.subarray(0, PNG.length), "image/png");
    await expect(rx.extractReceipt(alice, id)).rejects.toMatchObject({ status: 422 });
    expect(gen()).not.toHaveBeenCalled();
  });

  it("answers 409 when the file hasn't been uploaded yet", async () => {
    const t = await rc.initUpload(alice, { contentType: "image/png", sizeBytes: 100 });
    await expect(rx.extractReceipt(alice, t.receiptId)).rejects.toMatchObject({ status: 409 });
    expect(gen()).not.toHaveBeenCalled();
  });

  it("limits each user to 10 extractions an hour, and the refused one stays retryable", async () => {
    const id = await upload(alice, PNG);
    await sql`insert into rate_event (user_id, kind) select ${alice.id}, 'extract' from generate_series(1, 10)`;
    await expect(rx.extractReceipt(alice, id)).rejects.toMatchObject({ status: 429 });
    expect(gen()).not.toHaveBeenCalled();
    expect((await row(id)).extraction).toBeNull(); // the claim rolled back
    await sql`update rate_event set at = now() - interval '61 minutes' where user_id = ${alice.id}`;
    expect((await rx.extractReceipt(alice, id)).mode).toBe("demo");
    // Another user is unaffected by alice's limit.
    await sql`insert into rate_event (user_id, kind) select ${alice.id}, 'extract' from generate_series(1, 10)`;
    expect((await rx.extractReceipt(bob, await upload(bob, PNG))).mode).toBe("demo");
  });

  it("stops at the app-wide daily cap", async () => {
    process.env.EXTRACT_DAILY_CAP = "2";
    envMod.resetEnvCache();
    for (let i = 0; i < 2; i++) await rx.extractReceipt(alice, await upload(alice, PNG));
    const third = await upload(bob, PNG);
    await expect(rx.extractReceipt(bob, third)).rejects.toMatchObject({ status: 429 });
    expect((await sql`select count from daily_usage where kind = 'extract'`)[0].count).toBe(2);
    expect((await row(third)).extraction).toBeNull();
  });

  it("marks the receipt failed when the model errors, keeps the image, and doesn't retry", async () => {
    const id = await upload(alice, PNG);
    gen().mockRejectedValueOnce(new ai.AiError("Model provider timed out", "provider", "timeout"));
    const out = await rx.extractReceipt(alice, id);
    expect(out).toMatchObject({ mode: "failed", extraction: null });
    expect(out.message).toMatch(/by hand/);
    const r = await row(id);
    expect(r).toMatchObject({ status: "ready", extraction_mode: "failed" });
    expect(await st.storage().head(st.objectKeyFor(alice.id, id))).not.toBeNull();
    expect((await rx.extractReceipt(alice, id)).mode).toBe("failed");
    expect(gen()).toHaveBeenCalledTimes(1);
  });

  it("marks the receipt failed when the model returns output that fails the schema", async () => {
    const id = await upload(alice, PNG);
    answer({ isReceipt: "maybe" });
    expect((await rx.extractReceipt(alice, id)).mode).toBe("failed");
  });

  it("times out at AI_TIMEOUT_MS with a hanging provider and falls back to the manual form", async () => {
    const id = await upload(alice, PNG);
    Object.assign(process.env, { AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false", AI_TIMEOUT_MS: "300" });
    envMod.resetEnvCache();
    gen().mockImplementationOnce(((await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai")).generate));
    const hang = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("timeout", "TimeoutError")))),
    );
    const started = Date.now();
    try {
      const out = await rx.extractReceipt(alice, id);
      expect(out.mode).toBe("failed");
      expect(Date.now() - started).toBeLessThan(3000);
      expect(hang).toHaveBeenCalledTimes(1);
    } finally {
      hang.mockRestore();
      delete process.env.GEMINI_API_KEY;
      delete process.env.AI_FALLBACK_TO_DEMO;
      delete process.env.AI_TIMEOUT_MS;
      envMod.resetEnvCache();
    }
  });

  it("takes over a claim abandoned by a crashed request, but not a fresh one", async () => {
    const id = await upload(alice, PNG);
    await rc.verifyUpload(alice, id);
    const claim = (startedAt: number) => sql`update receipt set extraction = ${sql.json({ status: "running", startedAt })} where id = ${id}`;
    await claim(Date.now());
    await expect(rx.extractReceipt(alice, id)).rejects.toMatchObject({ status: 409 });
    await claim(Date.now() - 120_000);
    expect((await rx.extractReceipt(alice, id)).mode).toBe("demo");
  });

  it("answers a fresh running claim with 409 before re-reading the object", async () => {
    const id = await upload(alice, PNG);
    await sql`update receipt set extraction = jsonb_build_object('status', 'running', 'startedAt', (extract(epoch from now()) * 1000)::bigint) where id = ${id}`;
    const read = vi.spyOn(st.storage(), "read");
    const head = vi.spyOn(st.storage(), "head");
    try {
      await expect(rx.extractReceipt(alice, id)).rejects.toMatchObject({ status: 409 });
      expect(read).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      head.mockRestore();
    }
  });

  it("answers 429 at the per-user or daily cap before re-reading the object, and keeps the receipt retryable", async () => {
    const id = await upload(alice, PNG);
    const head = vi.spyOn(st.storage(), "head");
    try {
      await sql`insert into rate_event (user_id, kind) select ${alice.id}, 'extract' from generate_series(1, 10)`;
      await expect(rx.extractReceipt(alice, id)).rejects.toMatchObject({ status: 429 });
      await sql`delete from rate_event where user_id = ${alice.id}`;
      process.env.EXTRACT_DAILY_CAP = "1";
      envMod.resetEnvCache();
      await sql`insert into daily_usage (day, kind, count) values ((now() at time zone 'utc')::date, 'extract', 1)`;
      await expect(rx.extractReceipt(alice, id)).rejects.toMatchObject({ status: 429 });
      expect(head).not.toHaveBeenCalled();
    } finally {
      head.mockRestore();
    }
    expect((await row(id)).extraction).toBeNull();
  });

  it("stamps the claim with the database clock", async () => {
    const id = await upload(alice, PNG);
    let seen = 0;
    let dbNow = 0;
    gen().mockImplementationOnce(async (req: { schema: { parse: (v: unknown) => unknown } }) => {
      seen = Number((await row(id)).extraction.startedAt);
      dbNow = Number((await sql`select (extract(epoch from now()) * 1000)::bigint as t`)[0].t);
      return { data: req.schema.parse(model), provider: "stub", model: "stub", demo: false, latencyMs: 1 };
    });
    await rx.extractReceipt(alice, id);
    expect(seen).toBeGreaterThan(0);
    expect(Math.abs(dbNow - seen)).toBeLessThan(5000);
  });

  it("drops the final write when another request has taken over the claim", async () => {
    const id = await upload(alice, PNG);
    gen().mockImplementationOnce(async (req: { schema: { parse: (v: unknown) => unknown } }) => {
      // Simulate a takeover while this request is still waiting for the model.
      await sql`update receipt set extraction = ${sql.json({ status: "running", startedAt: 42 })} where id = ${id}`;
      return { data: req.schema.parse(model), provider: "stub", model: "stub", demo: false, latencyMs: 1 };
    });
    await rx.extractReceipt(alice, id); // still answers its own caller
    const r = await row(id);
    expect(r.extraction_mode).toBeNull();
    expect(r.extraction).toEqual({ status: "running", startedAt: 42 });
  });

  it("holds the per-user hourly cap under concurrent requests: 12 parallel scans, exactly 10 run", async () => {
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await upload(alice, PNG));
    const results = await Promise.allSettled(ids.map((id) => rx.extractReceipt(alice, id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(refused.map((r) => r.reason.status)).toEqual([429, 429]);
    expect((await sql`select count(*)::int as n from rate_event where user_id = ${alice.id} and kind = 'extract'`)[0].n).toBe(10);
    expect((await sql`select count from daily_usage where kind = 'extract'`)[0].count).toBe(10);
    expect((await sql`select count(*)::int as n from receipt where owner_id = ${alice.id} and extraction is null`)[0].n).toBe(2);
  });

  it("holds the app-wide daily cap under concurrent requests from two users: 8 parallel scans, exactly 3 run", async () => {
    process.env.EXTRACT_DAILY_CAP = "3";
    envMod.resetEnvCache();
    const queued: { who: typeof alice; id: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const who = i % 2 ? bob : alice;
      queued.push({ who, id: await upload(who, PNG) });
    }
    const results = await Promise.allSettled(queued.map((q) => rx.extractReceipt(q.who, q.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect((results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]).every((r) => r.reason.status === 429)).toBe(true);
    expect((await sql`select count from daily_usage where kind = 'extract'`)[0].count).toBe(3);
  });

  it("logs no merchant, amount or image data", async () => {
    const id = await upload(alice, PNG);
    answer(model);
    await rx.extractReceipt(alice, id);
    const text = logs.join("\n");
    expect(text).toContain("receipt.extracted");
    expect(text).not.toMatch(/Secret Merchant|98765|9876543|iVBOR/);
  });
});
