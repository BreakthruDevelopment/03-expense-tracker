import { RECEIPT_CONTENT_TYPES, type ReceiptContentType } from "@/lib/domain";
import { StorageError } from "./types";

/** GCS bucket naming rules (3-63 chars, or dotted up to 222); we only accept the common safe subset. */
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const OWNER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_RE = /^u\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function assertBucketName(name: string): string {
  if (!BUCKET_RE.test(name) || name.includes("..") || name.startsWith("goog") || /^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    throw new StorageError("Invalid storage bucket name.", 500);
  }
  return name;
}

/** Keys are built here from server-side ids only, never from client input: `u/<ownerId>/<receiptId>`. */
export function objectKeyFor(ownerId: string, receiptId: string): string {
  if (!OWNER_RE.test(ownerId) || !UUID_RE.test(receiptId)) throw new StorageError("Invalid object key.", 500);
  return `u/${ownerId}/${receiptId}`;
}

/** Every driver calls this first, so a bad key can't reach a filesystem path or a signed URL. */
export function assertObjectKey(key: string): { ownerId: string; receiptId: string } {
  const m = KEY_RE.exec(key);
  if (!m) throw new StorageError("Invalid object key.", 500);
  return { ownerId: m[1], receiptId: m[2] };
}

export const isValidObjectKey = (key: string) => KEY_RE.test(key);

export function isReceiptContentType(value: unknown): value is ReceiptContentType {
  return typeof value === "string" && (RECEIPT_CONTENT_TYPES as readonly string[]).includes(value);
}

const EXT: Record<ReceiptContentType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Forced on downloads so the browser always treats the object as an inline image. */
export function inlineDisposition(contentType: ReceiptContentType): string {
  return `inline; filename="receipt.${EXT[contentType]}"`;
}

/** The size range signed into uploads; the same string is the `x-goog-content-length-range` header value. */
export const lengthRange = (maxBytes: number) => `1,${maxBytes}`;
