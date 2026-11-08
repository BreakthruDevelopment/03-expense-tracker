import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLocalPutHeaders, createLocalDriver, verifyLocalUrl } from "./local";
import { objectKeyFor } from "./keys";

const SECRET = "s".repeat(32);
const key = objectKeyFor("alice", "0b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f");
const MAX = 5 * 1024 * 1024;

describe("local driver", () => {
  let dir: string;
  const clock = new Date("2026-11-08T12:00:00Z");
  const make = () => createLocalDriver({ dir, secret: SECRET, baseUrl: "http://localhost:3000", now: () => clock, nodeEnv: "test" });
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "local-storage-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("refuses to load in production", () => {
    expect(() => createLocalDriver({ dir, secret: SECRET, baseUrl: "http://x", nodeEnv: "production" })).toThrow();
  });

  it("signs an upload with the type and size range, and expires it in 5 minutes", async () => {
    const d = make();
    const up = await d.signUpload(key, "image/jpeg", MAX);
    expect(up.method).toBe("PUT");
    expect(up.headers).toEqual({ "Content-Type": "image/jpeg", "x-goog-content-length-range": `1,${MAX}`, "x-goog-if-generation-match": "0" });
    expect(up.expiresAt.getTime() - clock.getTime()).toBe(300_000);

    const url = new URL(up.url);
    expect(url.pathname).toBe(`/api/storage/local/${key}`);
    const p = verifyLocalUrl(SECRET, key, url.searchParams, "put", clock);
    expect(p).toMatchObject({ contentType: "image/jpeg", max: MAX });
    checkLocalPutHeaders(p, new Headers(up.headers));
  });

  it("rejects expired links, tampering, the wrong operation and the wrong key", async () => {
    const d = make();
    const url = new URL((await d.signUpload(key, "image/png", MAX)).url);
    const later = new Date(clock.getTime() + 301_000);
    expect(() => verifyLocalUrl(SECRET, key, url.searchParams, "put", later)).toThrow(/expired/);
    expect(() => verifyLocalUrl(SECRET, key, url.searchParams, "get", clock)).toThrow();
    expect(() => verifyLocalUrl("t".repeat(32), key, url.searchParams, "put", clock)).toThrow();
    const otherKey = objectKeyFor("bob", "0b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f");
    expect(() => verifyLocalUrl(SECRET, otherKey, url.searchParams, "put", clock)).toThrow();

    for (const [k, v] of [["ct", "text/html"], ["max", String(MAX * 4)], ["exp", String(Number(url.searchParams.get("exp")) + 9999)]]) {
      const q = new URLSearchParams(url.searchParams);
      q.set(k, v);
      expect(() => verifyLocalUrl(SECRET, key, q, "put", clock), k).toThrow();
    }
  });

  it("checks the signed PUT headers the way Cloud Storage does", async () => {
    const d = make();
    const up = await d.signUpload(key, "image/jpeg", 1000);
    const p = verifyLocalUrl(SECRET, key, new URL(up.url).searchParams, "put", clock);
    expect(() => checkLocalPutHeaders(p, new Headers({ "content-type": "text/html", "x-goog-content-length-range": "1,1000" }))).toThrow();
    expect(() => checkLocalPutHeaders(p, new Headers({ "content-type": "image/jpeg" }))).toThrow();
    expect(() => checkLocalPutHeaders(p, new Headers({ "content-type": "image/jpeg", "x-goog-content-length-range": "1,999999" }))).toThrow();
    // The create-only header is required too, and only "0" is accepted.
    const ok = { "content-type": "image/jpeg", "x-goog-content-length-range": "1,1000" };
    expect(() => checkLocalPutHeaders(p, new Headers(ok))).toThrow(/generation-match/);
    expect(() => checkLocalPutHeaders(p, new Headers({ ...ok, "x-goog-if-generation-match": "1" }))).toThrow();
    expect(() => checkLocalPutHeaders(p, new Headers({ ...ok, "x-goog-if-generation-match": "0" }))).not.toThrow();
  });

  it("put with ifAbsent refuses to overwrite (412) and keeps the first object", async () => {
    const d = make();
    await d.put(key, Buffer.from("first"), "image/png", { ifAbsent: true });
    await expect(d.put(key, Buffer.from("second"), "image/png", { ifAbsent: true })).rejects.toMatchObject({ status: 412 });
    expect((await d.read(key, 100))?.toString()).toBe("first");
    await d.put(key, Buffer.from("plain"), "image/png"); // a server-side put without the flag still overwrites
    expect((await d.read(key, 100))?.toString()).toBe("plain");
    await d.remove(key);
  });

  it("signs a download that forces the stored type", async () => {
    const d = make();
    const dl = await d.signDownload(key, "image/webp");
    expect(dl.expiresAt.getTime() - clock.getTime()).toBe(300_000);
    expect(verifyLocalUrl(SECRET, key, new URL(dl.url).searchParams, "get", clock).contentType).toBe("image/webp");
  });

  it("puts, heads, reads and removes objects, and enforces the read cap", async () => {
    const d = make();
    expect(await d.head(key)).toBeNull();
    expect(await d.read(key, 100)).toBeNull();
    await d.put(key, Buffer.from("hello"), "image/png");
    expect(await d.head(key)).toEqual({ size: 5, contentType: "image/png" });
    expect((await d.read(key, 100))?.toString()).toBe("hello");
    await expect(d.read(key, 2)).rejects.toMatchObject({ status: 422 });
    await d.remove(key);
    await d.remove(key); // idempotent
    expect(await d.head(key)).toBeNull();
  });

  it("never touches paths outside its directory", async () => {
    const d = make();
    await expect(d.put("../../etc/passwd", Buffer.from("x"), "image/png")).rejects.toThrow();
    await expect(d.read("u/../../x/0b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f", 10)).rejects.toThrow();
  });
});
