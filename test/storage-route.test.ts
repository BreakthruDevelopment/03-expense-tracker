/** The local storage route end to end (signed PUT then GET) with the local driver; no database needed. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const id = "0b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f";
const key = `u/alice/${id}`;
let dir: string;
let route: typeof import("@/app/api/storage/local/[...key]/route");
let st: typeof import("@/lib/storage");

const ctx = (k: string) => ({ params: Promise.resolve({ key: k.split("/") }) }) as never;
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 1)]);

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "storage-route-"));
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused",
    BETTER_AUTH_SECRET: "r".repeat(32),
    APP_URL: "http://localhost:3000",
    STORAGE_LOCAL_DIR: dir,
  });
  delete process.env.STORAGE_BUCKET;
  st = await import("@/lib/storage");
  st.resetStorage();
  route = await import("@/app/api/storage/local/[...key]/route");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const put = (url: string, headers: Record<string, string>, body: Buffer) =>
  route.PUT(new Request(url, { method: "PUT", headers, body: new Uint8Array(body) }), ctx(key));

describe("local storage route", () => {
  it("accepts a signed upload and serves it back with a forced image type", async () => {
    expect(st.storage().kind).toBe("local");
    const up = await st.storage().signUpload(key, "image/jpeg", 1000);
    expect((await put(up.url, up.headers, jpeg)).status).toBe(200);

    const dl = await st.storage().signDownload(key, "image/jpeg");
    const res = await route.GET(new Request(dl.url), ctx(key));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="receipt.jpg"');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(jpeg);
  });

  it("accepts the signed URL once: a second PUT gets 412 and the first file stays", async () => {
    const k = `u/alice/${"2".repeat(8)}-2222-4222-8222-${"2".repeat(12)}`;
    const up = await st.storage().signUpload(k, "image/jpeg", 1000);
    const send = (body: Buffer, headers: Record<string, string> = up.headers) =>
      route.PUT(new Request(up.url, { method: "PUT", headers, body: new Uint8Array(body) }), ctx(k));
    expect((await send(jpeg)).status).toBe(200);
    const evil = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 9)]);
    expect((await send(evil)).status).toBe(412);
    expect(await st.storage().read(k, 1000)).toEqual(jpeg);
    // Without the signed create-only header the request is refused before anything is written.
    const k2 = `u/alice/${"3".repeat(8)}-3333-4333-8333-${"3".repeat(12)}`;
    const up2 = await st.storage().signUpload(k2, "image/jpeg", 1000);
    const partial2: Record<string, string> = { ...up2.headers };
    delete partial2["x-goog-if-generation-match"];
    expect((await route.PUT(new Request(up2.url, { method: "PUT", headers: partial2, body: new Uint8Array(jpeg) }), ctx(k2))).status).toBe(400);
    expect(await st.storage().head(k2)).toBeNull();
  });

  it("rejects an upload over the signed size range with 400, and an empty one", async () => {
    const up = await st.storage().signUpload(key, "image/jpeg", 50);
    expect((await put(up.url, up.headers, Buffer.alloc(51))).status).toBe(400);
    expect((await put(up.url, up.headers, Buffer.alloc(0))).status).toBe(400);
  });

  it("rejects a mismatched content type or missing range header", async () => {
    const up = await st.storage().signUpload(key, "image/jpeg", 1000);
    expect((await put(up.url, { ...up.headers, "Content-Type": "text/html" }, jpeg)).status).toBe(400);
    expect((await put(up.url, { "Content-Type": "image/jpeg" }, jpeg)).status).toBe(400);
  });

  it("rejects a tampered signature, a GET link used for PUT, and a forged expiry with 403", async () => {
    const up = await st.storage().signUpload(key, "image/jpeg", 1000);
    const bad = new URL(up.url);
    bad.searchParams.set("sig", "0".repeat(64));
    expect((await put(bad.toString(), up.headers, jpeg)).status).toBe(403);
    const dl = await st.storage().signDownload(key, "image/jpeg");
    expect((await put(dl.url, up.headers, jpeg)).status).toBe(403);
    const expired = new URL(up.url);
    expired.searchParams.set("exp", String(Math.floor(Date.now() / 1000) - 10));
    expect((await put(expired.toString(), up.headers, jpeg)).status).toBe(403);
  });

  it("404s for a missing object and for a bad key", async () => {
    const other = `u/alice/${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}`;
    const dl = await st.storage().signDownload(other, "image/png");
    expect((await route.GET(new Request(dl.url), ctx(other))).status).toBe(404);
    expect((await route.GET(new Request("http://localhost:3000/x"), ctx("../etc/passwd"))).status).toBe(404);
  });
});
