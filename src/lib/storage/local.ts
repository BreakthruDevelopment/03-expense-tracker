import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ForbiddenError } from "@/lib/auth/rbac";
import { BadRequestError } from "@/lib/errors";
import { RECEIPT_CONTENT_TYPES, type ReceiptContentType } from "@/lib/domain";
import { IF_GENERATION_MATCH, assertObjectKey, isReceiptContentType, lengthRange } from "./keys";
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
 * Filesystem driver for development and CI. It behaves like the GCS driver: URLs are signed
 * (HMAC), expire after 5 minutes, and pin the content type and size range. The app serves
 * them itself at /api/storage/local/<key>. It refuses to run in production.
 */

export type LocalOptions = {
  dir: string;
  secret: string;
  /** Public origin of the app, e.g. http://localhost:3000. */
  baseUrl: string;
  now?: () => Date;
  nodeEnv?: string;
};

export type LocalUrlParams = {
  op: "put" | "get";
  key: string;
  /** Unix seconds. */
  exp: number;
  contentType: ReceiptContentType;
  /** Largest allowed upload (put) or 0 (get). */
  max: number;
};

export function signLocalParams(secret: string, p: LocalUrlParams): string {
  return createHmac("sha256", `storage-local:${secret}`)
    .update([p.op, p.key, p.exp, p.contentType, p.max].join("\n"))
    .digest("hex");
}

/** Parse and verify a signed local URL's query. Throws 403 for a bad signature or an expired link. */
export function verifyLocalUrl(
  secret: string,
  key: string,
  query: URLSearchParams,
  expectedOp: "put" | "get",
  now: Date = new Date(),
): LocalUrlParams {
  assertObjectKey(key);
  const contentType = query.get("ct");
  const exp = Number(query.get("exp"));
  const max = Number(query.get("max") ?? 0);
  const sig = query.get("sig") ?? "";
  if (!isReceiptContentType(contentType) || !Number.isInteger(exp) || !Number.isInteger(max) || max < 0 || query.get("op") !== expectedOp) {
    throw new ForbiddenError("This link is invalid.");
  }
  const params: LocalUrlParams = { op: expectedOp, key, exp, contentType, max };
  const want = Buffer.from(signLocalParams(secret, params));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new ForbiddenError("This link is invalid.");
  if (exp * 1000 <= now.getTime()) throw new ForbiddenError("This link has expired.");
  return params;
}

/** Validate a local PUT's headers the way GCS does: every signed header must be present and exact. */
export function checkLocalPutHeaders(p: LocalUrlParams, headers: Headers): void {
  if (headers.get("content-type")?.trim() !== p.contentType) throw new BadRequestError("Content-Type does not match the upload URL.");
  if (headers.get("x-goog-content-length-range")?.trim() !== lengthRange(p.max)) {
    throw new BadRequestError("Missing or wrong x-goog-content-length-range header.");
  }
  if (headers.get(IF_GENERATION_MATCH)?.trim() !== "0") throw new BadRequestError(`Missing or wrong ${IF_GENERATION_MATCH} header.`);
}

export function createLocalDriver(opts: LocalOptions): StorageDriver {
  if ((opts.nodeEnv ?? process.env.NODE_ENV) === "production") {
    throw new StorageError("The local storage driver can't run in production.", 500);
  }
  const root = path.resolve(opts.dir);
  const now = opts.now ?? (() => new Date());

  function fileFor(key: string): string {
    assertObjectKey(key);
    const file = path.resolve(root, key);
    if (!file.startsWith(root + path.sep)) throw new StorageError("Invalid object key.", 500);
    return file;
  }

  function signedUrl(op: "put" | "get", key: string, contentType: ReceiptContentType, max: number, ttl: number) {
    assertObjectKey(key);
    const expiresAt = new Date(now().getTime() + ttl * 1000);
    const params: LocalUrlParams = { op, key, exp: Math.floor(expiresAt.getTime() / 1000), contentType, max };
    const q = new URLSearchParams({
      op,
      exp: String(params.exp),
      ct: contentType,
      max: String(max),
      sig: signLocalParams(opts.secret, params),
    });
    const base = opts.baseUrl.replace(/\/$/, "");
    return { url: `${base}/api/storage/local/${key}?${q}`, expiresAt };
  }

  async function metaOf(file: string): Promise<{ contentType: string } | null> {
    try {
      return JSON.parse(await readFile(`${file}.meta`, "utf8")) as { contentType: string };
    } catch {
      return null;
    }
  }

  return {
    kind: "local",

    async signUpload(key, contentType, maxBytes): Promise<SignedUpload> {
      const { url, expiresAt } = signedUrl("put", key, contentType, maxBytes, UPLOAD_TTL_SECONDS);
      return {
        url,
        method: "PUT",
        headers: { "Content-Type": contentType, "x-goog-content-length-range": lengthRange(maxBytes), [IF_GENERATION_MATCH]: "0" },
        expiresAt,
      };
    },

    async signDownload(key, contentType): Promise<SignedDownload> {
      return signedUrl("get", key, contentType, 0, DOWNLOAD_TTL_SECONDS);
    },

    async head(key): Promise<ObjectHead | null> {
      const file = fileFor(key);
      try {
        const [s, meta] = await Promise.all([stat(file), metaOf(file)]);
        return { size: s.size, contentType: meta?.contentType ?? "" };
      } catch {
        return null;
      }
    },

    async read(key, maxBytes): Promise<Buffer | null> {
      const file = fileFor(key);
      try {
        if ((await stat(file)).size > maxBytes) throw new StorageError("Stored file is too large.", 422);
        return await readFile(file);
      } catch (err) {
        if (err instanceof StorageError) throw err;
        return null;
      }
    },

    async put(key, bytes, contentType, opts): Promise<void> {
      if (!(RECEIPT_CONTENT_TYPES as readonly string[]).includes(contentType)) throw new StorageError("Unsupported type.", 400);
      const file = fileFor(key);
      await mkdir(path.dirname(file), { recursive: true });
      try {
        // "wx" fails if the file exists, atomically: the same guarantee as ifGenerationMatch=0.
        await writeFile(file, bytes, { flag: opts?.ifAbsent ? "wx" : "w" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new StorageError("That upload already exists.", 412);
        throw err;
      }
      await writeFile(`${file}.meta`, JSON.stringify({ contentType }));
    },

    async remove(key): Promise<void> {
      const file = fileFor(key);
      await rm(file, { force: true });
      await rm(`${file}.meta`, { force: true });
    },
  };
}
