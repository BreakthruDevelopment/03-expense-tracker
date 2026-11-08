import "server-only";
import { and, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import { AiError } from "@/lib/ai";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { EXTRACTIONS_PER_HOUR, EXTRACT_CLAIM_SECONDS } from "@/lib/domain";
import { env } from "@/lib/env";
import { ConflictError, NotFoundError, TooManyRequestsError, UnprocessableError } from "@/lib/errors";
import { idSchema } from "@/lib/expense-schemas";
import { ImageRejectedError, type ReceiptExtraction, extractFromImage } from "@/lib/extract-receipt";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { verifyUpload } from "@/lib/receipts";
import { consumeRate, dailyCount, rateIsFull, reserveDaily } from "@/lib/usage";

const { receipt } = schema;

export type ExtractionResult = {
  receiptId: string;
  /** `failed`: the model couldn't answer; open the manual form (the image stays attachable). */
  mode: "live" | "demo" | "failed";
  /** null when `mode` is `failed`. Nothing is saved: this only prefills the form. */
  extraction: ReceiptExtraction | null;
  message?: string;
};

const FAILED_MESSAGE = "We couldn't read this receipt. Enter the details by hand.";

/**
 * What's stored in `receipt.extraction` while a request owns the claim (mode stays null). The start
 * time lives here, not in `updated_at`, because `verifyUpload` touches `updated_at` on every call.
 * It is stamped with the database clock, the same one `claimIsStale` compares against, so app
 * instances with drifting clocks can't disagree about whether a claim is stale.
 */
const running = sql`jsonb_build_object('status', 'running', 'startedAt', (extract(epoch from now()) * 1000)::bigint)`;
const claimStartedAt = sql<string>`${receipt.extraction}->>'startedAt'`;
const claimIsRunning = sql`${receipt.extraction}->>'status' = 'running'`;
const claimIsStale = sql`coalesce((${receipt.extraction}->>'startedAt')::bigint, 0) < (extract(epoch from now()) * 1000)::bigint - ${EXTRACT_CLAIM_SECONDS * 1000}`;

function stored(r: { id: string; extraction: unknown; extractionMode: "live" | "demo" | "failed" | null }): ExtractionResult {
  if (r.extractionMode === "failed") return { receiptId: r.id, mode: "failed", extraction: null, message: FAILED_MESSAGE };
  return { receiptId: r.id, mode: r.extractionMode as "live" | "demo", extraction: r.extraction as ReceiptExtraction };
}

/**
 * Extract a draft from an uploaded receipt, once. Owner only (404 for anyone else, admin included).
 *
 * 1. Cheap owner and state check: a finished extraction is returned as stored, with no model call;
 *    a fresh claim held by another request is a 409, and a user or app already at a cap is a 429,
 *    both before the object is read again. (The claim transaction below stays the authority.)
 * 2. `verifyUpload` re-reads the object and checks size, type and magic bytes; a bad file is deleted
 *    (422) and never reaches `generate()`.
 * 3. One transaction claims the receipt and spends the per-user (10/hour) and app-wide daily
 *    allowance, so concurrent requests can't both call the model or slip past a cap.
 * 4. `generate()` with the image; the guarded draft (or `failed`) is stored on the receipt.
 *
 * This never creates an expense: the draft only prefills a form the user must confirm.
 */
export async function extractReceipt(actor: Actor, receiptId: string): Promise<ExtractionResult> {
  assertCan(actor, "create");
  const parsed = idSchema.safeParse(receiptId);
  if (!parsed.success) throw new NotFoundError("Receipt not found");
  const id = parsed.data;

  const [existing] = await db()
    .select({ ...getTableColumns(receipt), claimHeld: sql<boolean>`coalesce(${claimIsRunning} and not (${claimIsStale}), false)` })
    .from(receipt)
    .where(ownedBy(receipt, actor, eq(receipt.id, id)))
    .limit(1);
  if (!existing || existing.status === "rejected") throw new NotFoundError("Receipt not found");
  if (existing.extractionMode !== null) return stored(existing);
  const e = env();
  if (existing.claimHeld) throw new ConflictError("This receipt is already being read. Try again in a moment.");
  if (await rateIsFull(actor.id, "extract", EXTRACTIONS_PER_HOUR)) {
    throw new TooManyRequestsError("Too many scans this hour. Try again later, or enter the expense by hand.");
  }
  if ((await dailyCount("extract")) >= e.EXTRACT_DAILY_CAP) {
    throw new TooManyRequestsError("The daily scan limit is reached. Try again tomorrow, or enter the expense by hand.");
  }

  const { bytes, contentType } = await verifyUpload(actor, id);

  let startedAt = "";
  const claimed = await db().transaction(async (tx) => {
    const rows = await tx
      .update(receipt)
      .set({ extraction: running, updatedAt: sql`now()` })
      .where(
        ownedBy(
          receipt,
          actor,
          eq(receipt.id, id),
          eq(receipt.status, "ready"),
          isNull(receipt.extractionMode),
          or(isNull(receipt.extraction), claimIsStale),
        ),
      )
      .returning({ id: receipt.id, startedAt: claimStartedAt });
    if (rows.length === 0) return false;
    startedAt = rows[0].startedAt;
    // A refusal here rolls the claim back too, so the user can try again later.
    await consumeRate(tx, actor.id, "extract", EXTRACTIONS_PER_HOUR, "Too many scans this hour. Try again later, or enter the expense by hand.");
    if (!(await reserveDaily(tx, "extract", e.EXTRACT_DAILY_CAP))) {
      throw new TooManyRequestsError("The daily scan limit is reached. Try again tomorrow, or enter the expense by hand.");
    }
    return true;
  });
  if (!claimed) {
    // Lost a race: the other request may have finished already.
    const [now] = await db().select().from(receipt).where(ownedBy(receipt, actor, eq(receipt.id, id))).limit(1);
    if (now?.extractionMode) return stored(now);
    throw new ConflictError("This receipt is already being read. Try again in a moment.");
  }

  const started = Date.now();
  let result: ExtractionResult;
  let columns: { extraction: unknown; extractionMode: "live" | "demo" | "failed" };
  try {
    const out = await extractFromImage({ bytes, contentType });
    const mode = out.demo ? "demo" : "live";
    columns = { extraction: out.extraction, extractionMode: mode };
    result = { receiptId: id, mode, extraction: out.extraction };
    log.info("receipt.extracted", {
      receiptId: id,
      mode,
      latencyMs: out.latencyMs,
      confidence: out.extraction.confidence,
      isReceipt: out.extraction.isReceipt,
      warnings: out.extraction.warnings.map((w) => w.code),
    });
  } catch (err) {
    if (err instanceof ImageRejectedError) {
      // Unreachable after verifyUpload; release the claim rather than leave it stuck.
      await db()
        .update(receipt)
        .set({ extraction: null, updatedAt: sql`now()` })
        .where(and(eq(receipt.id, id), isNull(receipt.extractionMode), sql`${claimStartedAt} = ${startedAt}`));
      throw new UnprocessableError("That file isn't a supported receipt image.");
    }
    // Never log the error message or any model text: only the kind and status.
    log.warn("receipt.extraction_failed", {
      receiptId: id,
      kind: err instanceof AiError ? err.kind : "unexpected",
      status: err instanceof AiError ? err.status : undefined,
      latencyMs: Date.now() - started,
    });
    columns = { extraction: null, extractionMode: "failed" };
    result = { receiptId: id, mode: "failed", extraction: null, message: FAILED_MESSAGE };
  }

  // Only the request that still holds the claim may write: if this one ran past the claim window and
  // another request took over, its answer stands and ours is dropped.
  const written = await db()
    .update(receipt)
    .set({ ...columns, updatedAt: sql`now()` })
    .where(ownedBy(receipt, actor, eq(receipt.id, id), isNull(receipt.extractionMode), sql`${claimStartedAt} = ${startedAt}`))
    .returning({ id: receipt.id });
  if (written.length === 0) log.warn("receipt.extraction_claim_lost", { receiptId: id });
  return result;
}
