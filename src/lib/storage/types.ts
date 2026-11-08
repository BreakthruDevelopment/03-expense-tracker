import { HttpError } from "@/lib/errors";
import type { ReceiptContentType } from "@/lib/domain";

export type StorageKind = "gcs" | "local" | "none";

export type SignedUpload = {
  url: string;
  method: "PUT";
  /** The browser must send exactly these headers; they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: Date;
};

export type SignedDownload = { url: string; expiresAt: Date };

export type ObjectHead = { size: number; contentType: string };

/** One shape for every driver, so callers never know which one is running. */
export interface StorageDriver {
  readonly kind: StorageKind;
  /**
   * V4 signed PUT URL: exact content type, size range 1..maxBytes, 5-minute expiry, and
   * `x-goog-if-generation-match: 0` (create only; a second PUT to the same key gets 412).
   */
  signUpload(key: string, contentType: ReceiptContentType, maxBytes: number): Promise<SignedUpload>;
  /** Signed GET URL: 5-minute expiry, response type forced to `contentType`. */
  signDownload(key: string, contentType: ReceiptContentType): Promise<SignedDownload>;
  /** Size and stored type, or null when the object doesn't exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** The object's bytes (read with the app's own credentials), or null when it doesn't exist. */
  read(key: string, maxBytes: number): Promise<Buffer | null>;
  /** Upload server-side (demo workspace). With `ifAbsent`, an existing object is refused with a 412 StorageError. */
  put(key: string, bytes: Buffer, contentType: ReceiptContentType, opts?: { ifAbsent?: boolean }): Promise<void>;
  /** Idempotent: a missing object is not an error. */
  remove(key: string): Promise<void>;
}

/** Storage failed or isn't available. The message is safe to show; details go to the log. */
export class StorageError extends HttpError {
  constructor(message = "Receipt storage failed. Try again shortly.", status = 502) {
    super(status, message);
  }
}

export class StorageUnavailableError extends StorageError {
  constructor() {
    super("Receipt scanning isn't available right now. You can still enter expenses by hand.", 503);
  }
}

export const UPLOAD_TTL_SECONDS = 300;
export const DOWNLOAD_TTL_SECONDS = 300;
