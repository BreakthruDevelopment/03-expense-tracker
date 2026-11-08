import "server-only";
import type { Actor } from "@/lib/auth/rbac";
import { HttpError } from "@/lib/errors";

/**
 * Module boundary for receipt extraction (spec issue 5, the ai-builder's slice).
 *
 * `POST /api/receipts/[id]/extract` will call `extractReceipt`, which must start with
 * `verifyUpload(actor, id)` from `@/lib/receipts` (size, type and magic-byte checks; a rejected file
 * is deleted and never reaches `generate()`), then run the model once and store `extraction` and
 * `extraction_mode`. Until that lands the function answers 501, and no route calls it yet.
 */
export async function extractReceipt(actor: Actor, receiptId: string): Promise<never> {
  void actor;
  void receiptId;
  throw new HttpError(501, "Receipt extraction isn't available yet.");
}
