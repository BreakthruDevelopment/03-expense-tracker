import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { adminPurgeReceipts } from "@/lib/receipts";

export const dynamic = "force-dynamic";

/** POST /api/admin/users/:id/purge-receipts (admin): delete one user's stored images; their expenses stay. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireRole("admin");
    requireSameOrigin(request);
    const { id } = await ctx.params;
    return Response.json(await adminPurgeReceipts(admin, id));
  } catch (err) {
    return errorResponse(err);
  }
}
