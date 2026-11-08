import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { verifyUpload } from "@/lib/receipts";

export const dynamic = "force-dynamic";

/** POST /api/receipts/:id/confirm : verify the uploaded object (size, type, magic bytes); 422 and deleted if wrong. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    const { receipt } = await verifyUpload(user, id);
    return Response.json({ receipt });
  } catch (err) {
    return errorResponse(err);
  }
}
