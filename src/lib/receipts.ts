import "server-only";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import type { Receipt } from "@/lib/db/schema";
import {
  DOWNLOADS_PER_HOUR,
  MAX_RECEIPT_BYTES,
  PURGES_PER_HOUR,
  type ReceiptContentType,
  STALE_DRAFT_SECONDS,
  STALE_UPLOAD_SECONDS,
  SWEEP_BATCH,
  UPLOADS_PER_HOUR,
} from "@/lib/domain";
import { env } from "@/lib/env";
import { ConflictError, NotFoundError, TooManyRequestsError, UnprocessableError } from "@/lib/errors";
import { idSchema, initUploadSchema, userIdSchema } from "@/lib/expense-schemas";
import { log } from "@/lib/log";
import { matchesMagic } from "@/lib/magic";
import { ownedBy } from "@/lib/owned";
import { StorageError, StorageUnavailableError, objectKeyFor, storage } from "@/lib/storage";
import { advisoryLock, consumeRate, dailyCount, releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

const { receipt, expense, user } = schema;

/**
 * What POST /api/receipts/uploads returns. The browser must PUT the file to `url` with exactly
 * `method` and `headers`: `Content-Type` and `x-goog-content-length-range` are part of the
 * signature, so any difference (another type, a size outside 1..sizeBytes) is refused by storage.
 */
export type UploadTicket = {
  receiptId: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
};

export type ReceiptView = Pick<Receipt, "id" | "contentType" | "sizeBytes" | "status" | "extractionMode" | "createdAt" | "updatedAt">;

const view = (r: Receipt): ReceiptView => ({
  id: r.id,
  contentType: r.contentType,
  sizeBytes: r.sizeBytes,
  status: r.status,
  extractionMode: r.extractionMode,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

function parseId(id: unknown): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new NotFoundError("Receipt not found");
  return parsed.data;
}

async function loadOwned(actor: Actor, id: string): Promise<Receipt> {
  const [row] = await db().select().from(receipt).where(ownedBy(receipt, actor, eq(receipt.id, id))).limit(1);
  if (!row) throw new NotFoundError("Receipt not found");
  return row;
}

/** Storage failures become a safe 502; the detail goes to the log. */
async function removeObject(key: string): Promise<void> {
  try {
    await storage().remove(key);
  } catch (err) {
    if (err instanceof StorageError) throw err;
    log.error("receipt.object_remove_failed", { error: err instanceof Error ? err.message : String(err) });
    throw new StorageError();
  }
}

const totalBytes = sql<number>`coalesce(sum(${receipt.sizeBytes}), 0)::bigint`;

/**
 * Reserve a receipt row and return a signed upload ticket. Checks, in order: per-user receipt cap,
 * hourly per-user rate limit, app-wide stored bytes, app-wide daily upload cap. All of it happens
 * under one lock so concurrent requests can't slip past a cap. `sizeBytes` is signed into the URL
 * as the largest allowed upload, so what's reserved is an upper bound; `verifyUpload` replaces it
 * with the real size.
 */
export async function initUpload(actor: Actor, input: unknown): Promise<UploadTicket> {
  assertCan(actor, "create");
  const data = initUploadSchema.parse(input);
  const driver = storage();
  if (driver.kind === "none") throw new StorageUnavailableError();
  const e = env();

  // Free the user's own stale drafts first so they don't count against the cap. Never fails the request.
  await sweepStaleReceipts({ ownerId: actor.id }).catch((err) =>
    log.warn("receipt.sweep_failed", { error: err instanceof Error ? err.message : String(err) }),
  );

  const id = randomUUID();
  const key = objectKeyFor(actor.id, id);
  await db().transaction(async (tx) => {
    await advisoryLock(tx, "receipt-caps");
    const [{ n }] = await tx.select({ n: count() }).from(receipt).where(ownedBy(receipt, actor));
    if (n >= e.RECEIPTS_PER_USER) {
      throw new ConflictError(`You can keep at most ${e.RECEIPTS_PER_USER} receipts. Delete one to add another.`);
    }
    await consumeRate(tx, actor.id, "upload", UPLOADS_PER_HOUR, "Too many uploads this hour. Try again later, or enter the expense by hand.");
    const [{ bytes }] = await tx.select({ bytes: totalBytes.as("bytes") }).from(receipt);
    if (Number(bytes) + data.sizeBytes > e.STORAGE_MAX_BYTES) {
      throw new TooManyRequestsError("Receipt storage is full for now. You can still enter the expense by hand.");
    }
    if (!(await reserveDaily(tx, "upload", e.UPLOAD_DAILY_CAP))) {
      throw new TooManyRequestsError("The daily upload limit is reached. Try again tomorrow, or enter the expense by hand.");
    }
    await tx.insert(receipt).values({ id, ownerId: actor.id, objectKey: key, contentType: data.contentType, sizeBytes: data.sizeBytes, status: "uploading" });
  });

  try {
    const signed = await driver.signUpload(key, data.contentType, data.sizeBytes);
    return { receiptId: id, url: signed.url, method: signed.method, headers: signed.headers, expiresAt: signed.expiresAt.toISOString() };
  } catch (err) {
    // The reservation committed above; give it back so a signing failure costs the user nothing.
    await db()
      .transaction(async (tx) => {
        await tx.delete(receipt).where(eq(receipt.id, id));
        await releaseRate(tx, actor.id, "upload");
        await releaseDaily(tx, "upload");
      })
      .catch((e) => log.error("receipt.release_failed", { error: e instanceof Error ? e.message : String(e) }));
    throw err;
  }
}

/** Mark the receipt rejected, delete its object, then its row; always ends in a 422. */
async function reject(r: Receipt, reason: string): Promise<never> {
  await db().update(receipt).set({ status: "rejected", updatedAt: sql`now()` }).where(eq(receipt.id, r.id));
  await removeObject(r.objectKey); // on failure the `rejected` row stays for the sweep
  await db().delete(receipt).where(eq(receipt.id, r.id));
  log.warn("receipt.rejected", { receiptId: r.id, reason });
  throw new UnprocessableError(reason);
}

/**
 * Confirm an upload: read the object with the app's own credentials (never trusting what the
 * browser said), check its real size and type, and mark the receipt `ready`. Anything wrong
 * deletes the object and the row (422). Returns the verified bytes so extraction can reuse them.
 */
export async function verifyUpload(actor: Actor, id: string): Promise<{ receipt: ReceiptView; bytes: Buffer; contentType: ReceiptContentType }> {
  const r = await loadOwned(actor, parseId(id));
  if (r.status === "rejected") throw new NotFoundError("Receipt not found");
  const driver = storage();
  if (driver.kind === "none") throw new StorageUnavailableError();

  const head = await driver.head(r.objectKey);
  if (!head) throw new ConflictError("The file hasn't been uploaded yet.");
  if (head.size < 1 || head.size > MAX_RECEIPT_BYTES || head.size > r.sizeBytes) {
    return reject(r, "The uploaded file is empty or larger than allowed.");
  }
  if (head.contentType !== r.contentType) return reject(r, "The uploaded file's type doesn't match.");
  let bytes: Buffer | null;
  try {
    bytes = await driver.read(r.objectKey, MAX_RECEIPT_BYTES);
  } catch (err) {
    // The object grew past the cap between head and read: same outcome as a bad size.
    if (err instanceof StorageError && err.status === 422) return reject(r, "The uploaded file is empty or larger than allowed.");
    throw err;
  }
  if (!bytes) throw new ConflictError("The file hasn't been uploaded yet.");
  if (bytes.length !== head.size || !matchesMagic(r.contentType, bytes)) {
    return reject(r, "That file isn't a JPEG, PNG or WebP image.");
  }

  // The real size replaces the declared one, and the app-wide byte cap is checked against real sizes.
  const fits = await db().transaction(async (tx) => {
    await advisoryLock(tx, "receipt-caps");
    const [{ bytes: others }] = await tx
      .select({ bytes: totalBytes.as("bytes") })
      .from(receipt)
      .where(ne(receipt.id, r.id));
    if (Number(others) + head.size > env().STORAGE_MAX_BYTES) return false;
    await tx
      .update(receipt)
      .set({ sizeBytes: head.size, status: "ready", updatedAt: sql`now()` })
      .where(eq(receipt.id, r.id));
    return true;
  });
  if (!fits) return reject(r, "Receipt storage is full for now.");
  const [fresh] = await db().select().from(receipt).where(eq(receipt.id, r.id));
  return { receipt: view(fresh), bytes, contentType: r.contentType };
}

/** A fresh 300-second signed GET URL, only after the owner check. 120 per user per hour. */
export async function signReceiptUrl(actor: Actor, id: string): Promise<{ url: string; expiresAt: string }> {
  const r = await loadOwned(actor, parseId(id));
  if (r.status !== "ready") throw new NotFoundError("Receipt not found");
  await db().transaction((tx) => consumeRate(tx, actor.id, "download", DOWNLOADS_PER_HOUR, "Too many image links this hour. Try again later."));
  const signed = await storage().signDownload(r.objectKey, r.contentType);
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

/** Object first (404 from storage is fine), then the row. Used when an expense is deleted. */
export async function deleteReceiptObjectAndRow(ownerId: string, receiptId: string): Promise<void> {
  const r = await loadOwned({ id: ownerId, role: "user" }, receiptId);
  await removeObject(r.objectKey);
  await db().delete(receipt).where(eq(receipt.id, r.id));
}

/**
 * Discard a draft (a receipt no expense uses): object then row. The row is locked first, and the
 * attachment check runs after the lock in its own statement (so it sees any expense that
 * committed while we waited). `createExpense` locks the same row, so a draft can't be attached
 * and deleted at once. A storage failure rolls back and leaves the row.
 */
export async function discardDraft(actor: Actor, id: string): Promise<void> {
  const rid = parseId(id);
  await db().transaction(async (tx) => {
    const [r] = await tx
      .select({ id: receipt.id, objectKey: receipt.objectKey })
      .from(receipt)
      .where(ownedBy(receipt, actor, eq(receipt.id, rid)))
      .for("update")
      .limit(1);
    if (!r) throw new NotFoundError("Receipt not found");
    const [attached] = await tx.select({ id: expense.id }).from(expense).where(eq(expense.receiptId, r.id)).limit(1);
    if (attached) throw new ConflictError("That receipt belongs to an expense. Delete the expense instead.");
    await removeObject(r.objectKey);
    await tx.delete(receipt).where(eq(receipt.id, r.id));
  });
}

/**
 * Remove stale receipts, object then row, at most 50 per call: uploads never confirmed (or rejected)
 * older than an hour, and drafts no expense uses older than 24 hours. Scoped to one owner when given.
 * Each row is handled in its own transaction: lock it (skipping rows another request holds), check it is
 * still stale and unattached, delete the object, delete the row. A draft saved a moment ago is never
 * deleted, because `createExpense` locks the same row.
 */
export async function sweepStaleReceipts(opts: { ownerId?: string; limit?: number } = {}): Promise<number> {
  const stale = and(
    opts.ownerId ? eq(receipt.ownerId, opts.ownerId) : undefined,
    or(
      and(inArray(receipt.status, ["uploading", "rejected"]), lt(receipt.createdAt, sql`now() - ${sql.raw(`interval '${STALE_UPLOAD_SECONDS} seconds'`)}`)),
      and(eq(receipt.status, "ready"), lt(receipt.createdAt, sql`now() - ${sql.raw(`interval '${STALE_DRAFT_SECONDS} seconds'`)}`)),
    ),
  );
  // Selection also filters attached drafts, so old attached receipts can't fill the batch and starve real work.
  const unattached = sql`not exists (select 1 from ${expense} where ${expense.receiptId} = ${receipt.id})`;
  const rows = await db()
    .select({ id: receipt.id })
    .from(receipt)
    .where(and(stale, unattached))
    .orderBy(receipt.createdAt)
    .limit(Math.min(opts.limit ?? SWEEP_BATCH, SWEEP_BATCH));
  let removed = 0;
  for (const row of rows) {
    try {
      const gone = await db().transaction(async (tx) => {
        const [r] = await tx
          .select({ id: receipt.id, objectKey: receipt.objectKey, status: receipt.status })
          .from(receipt)
          .where(and(eq(receipt.id, row.id), stale))
          .for("update", { skipLocked: true });
        if (!r) return false;
        if (r.status === "ready") {
          const [attached] = await tx.select({ id: expense.id }).from(expense).where(eq(expense.receiptId, r.id)).limit(1);
          if (attached) return false;
        }
        await removeObject(r.objectKey);
        await tx.delete(receipt).where(eq(receipt.id, r.id));
        return true;
      });
      if (gone) removed += 1;
    } catch (err) {
      log.warn("receipt.sweep_item_failed", { receiptId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return removed;
}

/**
 * Delete every stored receipt of one user: objects first, then rows (their expenses stay and
 * `receipt_id` is nulled by the foreign key). A storage failure stops the purge with a 502.
 * Called by the admin purge and by the user-delete hook in src/lib/auth.
 */
export async function purgeUserReceipts(userId: string): Promise<number> {
  let removed = 0;
  for (;;) {
    const rows = await db()
      .select({ id: receipt.id, objectKey: receipt.objectKey })
      .from(receipt)
      .where(eq(receipt.ownerId, userId))
      .orderBy(receipt.createdAt)
      .limit(100);
    if (rows.length === 0) return removed;
    for (const r of rows) await removeObject(r.objectKey);
    await db().delete(receipt).where(inArray(receipt.id, rows.map((r) => r.id)));
    removed += rows.length;
  }
}

/** Admin only: purge one user's images (abuse or quota). Never exposes the images themselves. */
export async function adminPurgeReceipts(actor: Actor, userId: string): Promise<{ purged: number }> {
  assertCan(actor, "read"); // without a resource only admin passes
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) throw new NotFoundError("User not found");
  const [target] = await db().select({ id: user.id }).from(user).where(eq(user.id, parsed.data)).limit(1);
  if (!target) throw new NotFoundError("User not found");
  await db().transaction((tx) => consumeRate(tx, actor.id, "purge", PURGES_PER_HOUR, "Too many purges this hour. Try again later."));
  const purged = await purgeUserReceipts(target.id);
  log.info("admin.purge_receipts", { by: actor.id, user: target.id, purged });
  return { purged };
}

export type AdminStats = {
  users: number;
  expenses: number;
  receipts: number;
  receiptBytes: number;
  receiptBytesCap: number;
  receiptsPerUserCap: number;
  uploadsToday: number;
  uploadsCap: number;
  extractionsToday: number;
  extractionsCap: number;
};

/** Admin only: counts and totals, never expense bodies or images. */
export async function adminStats(actor: Actor): Promise<AdminStats> {
  assertCan(actor, "read");
  const e = env();
  const [[u], [x], [r], uploadsToday, extractionsToday] = await Promise.all([
    db().select({ n: count() }).from(user),
    db().select({ n: count() }).from(expense),
    db().select({ n: count(), bytes: totalBytes.as("bytes") }).from(receipt),
    dailyCount("upload"),
    dailyCount("extract"),
  ]);
  return {
    users: u.n,
    expenses: x.n,
    receipts: r.n,
    receiptBytes: Number(r.bytes),
    receiptBytesCap: e.STORAGE_MAX_BYTES,
    receiptsPerUserCap: e.RECEIPTS_PER_USER,
    uploadsToday,
    uploadsCap: e.UPLOAD_DAILY_CAP,
    extractionsToday,
    extractionsCap: e.EXTRACT_DAILY_CAP,
  };
}

export type AdminUserUsage = { id: string; name: string; email: string; role: string; expenses: number; receipts: number; bytes: number };

/** Admin only: per-user counts for the users table. Counts and bytes, nothing else. */
export async function adminUserUsage(actor: Actor): Promise<AdminUserUsage[]> {
  assertCan(actor, "read");
  const rows = await db().execute<{ id: string; name: string; email: string; role: string; expenses: number; receipts: number; bytes: string }>(sql`
    select u.id, u.name, u.email, u.role,
      (select count(*)::int from expense x where x.owner_id = u.id) as expenses,
      (select count(*)::int from receipt r where r.owner_id = u.id) as receipts,
      (select coalesce(sum(r.size_bytes), 0)::bigint from receipt r where r.owner_id = u.id) as bytes
    from "user" u order by u.created_at desc limit 100
  `);
  return rows.map((r) => ({ ...r, expenses: Number(r.expenses), receipts: Number(r.receipts), bytes: Number(r.bytes) }));
}
