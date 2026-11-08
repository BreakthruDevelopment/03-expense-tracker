import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { extractReceipt } from "@/lib/receipt-extraction";

export const dynamic = "force-dynamic";

/**
 * POST /api/receipts/:id/extract (no body). Owner only; 404 for anyone else, admin included.
 * Verifies the uploaded object, reads it with the model once, and returns
 * `{ receiptId, mode: "live"|"demo"|"failed", extraction, message? }`. `extraction.draft` only
 * prefills the form: nothing is saved until the user submits POST /api/expenses with `receiptId`.
 * A repeat call returns the stored result without calling the model. 422 (file deleted) for a
 * bad file, 429 at the per-user (10/hour) or daily cap, 409 while another request is reading it.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    return Response.json(await extractReceipt(user, id));
  } catch (err) {
    return errorResponse(err);
  }
}
