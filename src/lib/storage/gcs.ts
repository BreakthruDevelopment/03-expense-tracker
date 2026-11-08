import { createHash } from "node:crypto";
import type { ReceiptContentType } from "@/lib/domain";
import { log } from "@/lib/log";
import { IF_GENERATION_MATCH, assertBucketName, assertObjectKey, inlineDisposition, lengthRange } from "./keys";
import {
  DOWNLOAD_TTL_SECONDS,
  type ObjectHead,
  type SignedDownload,
  type SignedUpload,
  type StorageDriver,
  StorageError,
  UPLOAD_TTL_SECONDS,
} from "./types";

/**
 * Google Cloud Storage without a client library or key file.
 *
 * - URLs are V4 signed (canonical request, string to sign, signature). The signature comes from
 *   IAM Credentials `signBlob` called as the Cloud Run service account, using the token the
 *   metadata server hands out. The account needs roles/iam.serviceAccountTokenCreator on itself.
 * - Object reads, deletes and server-side uploads use the JSON API with the same token.
 *
 * `fetch` is injectable so tests never touch the network.
 */

const HOST = "storage.googleapis.com";
const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";
const IAM = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts";
const REQUEST_TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;
export type GcsOptions = { bucket: string; fetch?: Fetch; now?: () => Date };

/** RFC 3986 percent-encoding as V4 signing requires (encodeURIComponent leaves !'()* alone). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (key: string) => key.split("/").map(enc).join("/");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function stamp(d: Date) {
  const iso = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20261108T120000Z
  return { datetime: iso, date: iso.slice(0, 8) };
}

export function createGcsDriver(opts: GcsOptions): StorageDriver {
  const bucket = assertBucketName(opts.bucket);
  const doFetch: Fetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());

  let email: string | undefined;
  let token: { value: string; expiresAt: number } | undefined;

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      log.error("storage.gcs.network", { error: err instanceof Error ? err.name : "unknown" });
      throw new StorageError();
    }
  }

  async function metadata(path: string): Promise<Response> {
    const res = await call(`${METADATA}/${path}`, { headers: { "Metadata-Flavor": "Google" } });
    if (!res.ok) {
      log.error("storage.gcs.metadata", { status: res.status });
      throw new StorageError();
    }
    return res;
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > now().getTime() + 60_000) return token.value;
    const body = (await (await metadata("token")).json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new StorageError();
    token = { value: body.access_token, expiresAt: now().getTime() + (body.expires_in ?? 300) * 1000 };
    return token.value;
  }

  async function serviceAccount(): Promise<string> {
    if (!email) email = (await (await metadata("email")).text()).trim();
    return email;
  }

  /** Hex signature of `stringToSign`, made by IAM on behalf of the service account. */
  async function signBlob(stringToSign: string): Promise<string> {
    const account = await serviceAccount();
    const res = await call(`${IAM}/${encodeURIComponent(account)}:signBlob`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ payload: Buffer.from(stringToSign).toString("base64") }),
    });
    if (!res.ok) {
      log.error("storage.gcs.signBlob", { status: res.status });
      throw new StorageError();
    }
    const { signedBlob } = (await res.json()) as { signedBlob?: string };
    if (!signedBlob) throw new StorageError();
    return Buffer.from(signedBlob, "base64").toString("hex");
  }

  async function signUrl(
    method: "PUT" | "GET",
    key: string,
    ttl: number,
    headers: Record<string, string>,
    extraQuery: Record<string, string> = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    assertObjectKey(key);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 604_800) throw new StorageError("Invalid signed URL lifetime.", 500);
    const issued = now();
    const { datetime, date } = stamp(issued);
    const account = await serviceAccount();
    const scope = `${date}/auto/storage/goog4_request`;

    const signedHeaders: Record<string, string> = { host: HOST };
    for (const [k, v] of Object.entries(headers)) signedHeaders[k.toLowerCase()] = v.trim();
    const names = Object.keys(signedHeaders).sort();

    const query: Record<string, string> = {
      ...extraQuery,
      "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
      "X-Goog-Credential": `${account}/${scope}`,
      "X-Goog-Date": datetime,
      "X-Goog-Expires": String(ttl),
      "X-Goog-SignedHeaders": names.join(";"),
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${enc(k)}=${enc(query[k])}`)
      .join("&");
    const path = `/${bucket}/${encPath(key)}`;
    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      names.map((n) => `${n}:${signedHeaders[n]}`).join("\n") + "\n",
      names.join(";"),
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = ["GOOG4-RSA-SHA256", datetime, scope, sha256(canonicalRequest)].join("\n");
    const signature = await signBlob(stringToSign);
    return {
      url: `https://${HOST}${path}?${canonicalQuery}&X-Goog-Signature=${signature}`,
      expiresAt: new Date(issued.getTime() + ttl * 1000),
    };
  }

  const objectUrl = (key: string) => `https://${HOST}/storage/v1/b/${bucket}/o/${enc(key)}`;
  const auth = async () => ({ authorization: `Bearer ${await accessToken()}` });

  return {
    kind: "gcs",

    async signUpload(key, contentType: ReceiptContentType, maxBytes): Promise<SignedUpload> {
      const headers = { "Content-Type": contentType, "x-goog-content-length-range": lengthRange(maxBytes), [IF_GENERATION_MATCH]: "0" };
      const { url, expiresAt } = await signUrl("PUT", key, UPLOAD_TTL_SECONDS, headers);
      return { url, method: "PUT", headers, expiresAt };
    },

    async signDownload(key, contentType): Promise<SignedDownload> {
      return signUrl("GET", key, DOWNLOAD_TTL_SECONDS, {}, {
        "response-content-type": contentType,
        "response-content-disposition": inlineDisposition(contentType),
      });
    },

    async head(key): Promise<ObjectHead | null> {
      assertObjectKey(key);
      const res = await call(`${objectUrl(key)}?fields=size,contentType`, { headers: await auth() });
      if (res.status === 404) return null;
      if (!res.ok) {
        log.error("storage.gcs.head", { status: res.status });
        throw new StorageError();
      }
      const body = (await res.json()) as { size?: string; contentType?: string };
      return { size: Number(body.size ?? 0), contentType: body.contentType ?? "" };
    },

    async read(key, maxBytes): Promise<Buffer | null> {
      assertObjectKey(key);
      const res = await call(`${objectUrl(key)}?alt=media`, { headers: await auth() });
      if (res.status === 404) return null;
      if (!res.ok) {
        log.error("storage.gcs.read", { status: res.status });
        throw new StorageError();
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) throw new StorageError("Stored file is too large.", 422);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new StorageError("Stored file is too large.", 422);
      return bytes;
    },

    async put(key, bytes, contentType, opts): Promise<void> {
      assertObjectKey(key);
      const match = opts?.ifAbsent ? "&ifGenerationMatch=0" : "";
      const res = await call(`https://${HOST}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${enc(key)}${match}`, {
        method: "POST",
        headers: { ...(await auth()), "content-type": contentType },
        body: new Uint8Array(bytes),
      });
      if (res.status === 412) throw new StorageError("That upload already exists.", 412);
      if (!res.ok) {
        log.error("storage.gcs.put", { status: res.status });
        throw new StorageError();
      }
    },

    async remove(key): Promise<void> {
      assertObjectKey(key);
      const res = await call(objectUrl(key), { method: "DELETE", headers: await auth() });
      if (res.status === 404 || res.ok) return;
      log.error("storage.gcs.remove", { status: res.status });
      throw new StorageError();
    },
  };
}
