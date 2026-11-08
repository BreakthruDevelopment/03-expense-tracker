import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { signReceiptUrl } from "@/lib/receipts";

export const dynamic = "force-dynamic";

/** GET /api/receipts/:id/url : a fresh 300-second signed GET URL. Owner only; 404 for everyone else. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json(await signReceiptUrl(user, id), { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
