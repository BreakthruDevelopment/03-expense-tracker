import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGcsDriver } from "./gcs";
import { objectKeyFor } from "./keys";

const BUCKET = "proj-expense-tracker-uploads";
const SA = "cloud-run-apps@proj.iam.gserviceaccount.com";
const key = objectKeyFor("alice", "0b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f");
const NOW = new Date("2026-11-08T12:34:56.789Z");
const PUT_QUERY =
  "X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=cloud-run-apps%40proj.iam.gserviceaccount.com%2F20261108%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261108T123456Z&X-Goog-Expires=300&X-Goog-SignedHeaders=content-type%3Bhost%3Bx-goog-content-length-range";
const SIG = Buffer.from("fake-signature-bytes");

type Call = { url: string; init?: RequestInit };

/** A fake Google: metadata server, IAM signBlob and the storage JSON API. Anything else fails the test. */
function fakeGoogle(overrides: Record<string, (c: Call) => Response> = {}) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call = { url, init };
    calls.push(call);
    for (const [prefix, handler] of Object.entries(overrides)) if (url.startsWith(prefix)) return handler(call);
    if (url.endsWith("/service-accounts/default/token")) return Response.json({ access_token: "tok-1", expires_in: 3600 });
    if (url.endsWith("/service-accounts/default/email")) return new Response(`${SA}\n`);
    if (url.includes(":signBlob")) return Response.json({ signedBlob: SIG.toString("base64") });
    throw new Error(`unexpected network call: ${url}`);
  });
  return { calls, fetch: impl as unknown as typeof fetch };
}

const driver = (g = fakeGoogle()) => ({ g, d: createGcsDriver({ bucket: BUCKET, fetch: g.fetch, now: () => NOW }) });

describe("gcs signed upload", () => {
  it("signs a V4 PUT with content type and size range headers and a 300 s expiry", async () => {
    const { g, d } = driver();
    const up = await d.signUpload(key, "image/jpeg", 5_242_880);

    expect(up.method).toBe("PUT");
    expect(up.headers).toEqual({ "Content-Type": "image/jpeg", "x-goog-content-length-range": "1,5242880" });
    expect(up.expiresAt.toISOString()).toBe("2026-11-08T12:39:56.789Z");

    const url = new URL(up.url);
    expect(url.origin).toBe("https://storage.googleapis.com");
    expect(url.pathname).toBe(`/${BUCKET}/${key}`);
    const q = url.searchParams;
    expect(q.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
    expect(q.get("X-Goog-Credential")).toBe(`${SA}/20261108/auto/storage/goog4_request`);
    expect(q.get("X-Goog-Date")).toBe("20261108T123456Z");
    expect(q.get("X-Goog-Expires")).toBe("300");
    expect(q.get("X-Goog-SignedHeaders")).toBe("content-type;host;x-goog-content-length-range");
    expect(q.get("X-Goog-Signature")).toBe(SIG.toString("hex"));

    // Fixed expected values for this test's inputs (not derived from the driver's output).
    const sign = g.calls.find((c) => c.url.includes(":signBlob"))!;
    const payload = Buffer.from(JSON.parse(String(sign.init!.body)).payload, "base64").toString();
    expect(url.pathname).toBe("/proj-expense-tracker-uploads/u/alice/0b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f");
    expect(url.search.slice(1).split("&X-Goog-Signature=")[0]).toBe(PUT_QUERY);
    expect(payload.split("\n")).toEqual([
      "GOOG4-RSA-SHA256",
      "20261108T123456Z",
      "20261108/auto/storage/goog4_request",
      // sha256 of the PUT canonical request for these inputs
      "67e41786556107cc8492cab571aa076f36eb48290a5c52c18c8b1a5835ea6f73",
    ]);
    // Signed as the service account through IAM, with the metadata token.
    expect(sign.url).toContain(`/serviceAccounts/${encodeURIComponent(SA)}:signBlob`);
    expect((sign.init!.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  });

  it("sorts query parameters and percent-encodes them", async () => {
    const { d } = driver();
    const up = await d.signUpload(key, "image/png", 1000);
    const raw = new URL(up.url).search.slice(1).split("&").map((p) => p.split("=")[0]).filter((k) => k !== "X-Goog-Signature");
    expect(raw).toEqual([...raw].sort());
    expect(up.url).toContain(encodeURIComponent(`${SA}/20261108/auto/storage/goog4_request`));
  });

  it("fetches the token and service account once, then reuses them", async () => {
    const { g, d } = driver();
    await d.signUpload(key, "image/png", 1000);
    await d.signDownload(key, "image/png");
    expect(g.calls.filter((c) => c.url.endsWith("/default/token"))).toHaveLength(1);
    expect(g.calls.filter((c) => c.url.endsWith("/default/email"))).toHaveLength(1);
    expect(g.calls.filter((c) => c.url.includes(":signBlob"))).toHaveLength(2);
  });
});

describe("gcs signed download", () => {
  it("signs a GET for 300 s and forces the response type and inline disposition", async () => {
    const { g, d } = driver();
    const dl = await d.signDownload(key, "image/webp");
    expect(dl.expiresAt.getTime() - NOW.getTime()).toBe(300_000);
    const q = new URL(dl.url).searchParams;
    expect(q.get("X-Goog-Expires")).toBe("300");
    expect(q.get("X-Goog-SignedHeaders")).toBe("host");
    expect(q.get("response-content-type")).toBe("image/webp");
    expect(q.get("response-content-disposition")).toBe('inline; filename="receipt.webp"');
    expect(q.get("X-Goog-Signature")).toBe(SIG.toString("hex"));

    // The canonical request's own pieces, fixed: query (sorted, encoded), method, headers, signed headers.
    expect(dl.url.split("&X-Goog-Signature=")[0].endsWith(
      "X-Goog-SignedHeaders=host&response-content-disposition=inline%3B%20filename%3D%22receipt.webp%22&response-content-type=image%2Fwebp",
    )).toBe(true);
    const canonical = [
      "GET",
      "/proj-expense-tracker-uploads/u/alice/0b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f",
      new URL(dl.url).search.slice(1).split("&X-Goog-Signature=")[0],
      "host:storage.googleapis.com\n",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const sign = g.calls.find((c) => c.url.includes(":signBlob"))!;
    const last = Buffer.from(JSON.parse(String(sign.init!.body)).payload, "base64").toString().split("\n")[3];
    expect(last).toBe(createHash("sha256").update(canonical).digest("hex"));
  });
});

describe("gcs object calls", () => {
  it("heads, reads, puts and deletes with the service account token", async () => {
    const g = fakeGoogle({
      [`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/`]: (c) => {
        if (c.init?.method === "DELETE") return new Response(null, { status: 204 });
        if (c.url.includes("alt=media")) return new Response(Buffer.from("bytes"));
        return Response.json({ size: "5", contentType: "image/png" });
      },
      "https://storage.googleapis.com/upload/": () => Response.json({}),
    });
    const d = createGcsDriver({ bucket: BUCKET, fetch: g.fetch, now: () => NOW });
    expect(await d.head(key)).toEqual({ size: 5, contentType: "image/png" });
    expect((await d.read(key, 100))?.toString()).toBe("bytes");
    await d.put(key, Buffer.from("x"), "image/jpeg");
    await d.remove(key);

    const encoded = encodeURIComponent(key);
    expect(g.calls.some((c) => c.url.startsWith(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encoded}?fields=`))).toBe(true);
    const put = g.calls.find((c) => c.url.includes("/upload/storage/v1/"))!;
    expect(put.url).toContain(`uploadType=media&name=${encoded}`);
    expect((put.init!.headers as Record<string, string>)["content-type"]).toBe("image/jpeg");
    for (const c of g.calls.filter((c) => c.url.includes("storage/v1"))) {
      expect((c.init!.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    }
  });

  it("treats 404 as missing (head/read null, delete ok) and other errors as 502", async () => {
    const status = { current: 404 };
    const g = fakeGoogle({ [`https://storage.googleapis.com/storage/v1/`]: () => new Response("{}", { status: status.current }) });
    const d = createGcsDriver({ bucket: BUCKET, fetch: g.fetch, now: () => NOW });
    expect(await d.head(key)).toBeNull();
    expect(await d.read(key, 10)).toBeNull();
    await d.remove(key);
    status.current = 500;
    await expect(d.head(key)).rejects.toMatchObject({ status: 502 });
    await expect(d.remove(key)).rejects.toMatchObject({ status: 502 });
  });

  it("refuses an object larger than the read cap", async () => {
    const g = fakeGoogle({ [`https://storage.googleapis.com/storage/v1/`]: () => new Response(Buffer.alloc(50)) });
    const d = createGcsDriver({ bucket: BUCKET, fetch: g.fetch, now: () => NOW });
    await expect(d.read(key, 10)).rejects.toMatchObject({ status: 422 });
  });

  it("maps signBlob failures and network errors to 502 without leaking details", async () => {
    const g = fakeGoogle({ "https://iamcredentials.googleapis.com": () => new Response("denied", { status: 403 }) });
    await expect(createGcsDriver({ bucket: BUCKET, fetch: g.fetch }).signDownload(key, "image/png")).rejects.toMatchObject({ status: 502 });
    const boom = (async () => {
      throw new Error("ECONNRESET secret-host");
    }) as unknown as typeof fetch;
    const err = await createGcsDriver({ bucket: BUCKET, fetch: boom }).head(key).catch((e: Error) => e);
    expect(err).toMatchObject({ status: 502 });
    expect((err as Error).message).not.toContain("secret-host");
  });

  it("validates the bucket name and keys before any request", async () => {
    const g = fakeGoogle();
    expect(() => createGcsDriver({ bucket: "Bad Bucket", fetch: g.fetch })).toThrow();
    const d = createGcsDriver({ bucket: BUCKET, fetch: g.fetch });
    await expect(d.signUpload("u/../x", "image/png", 10)).rejects.toThrow();
    await expect(d.remove("anything")).rejects.toThrow();
    expect(g.calls).toHaveLength(0);
  });
});
