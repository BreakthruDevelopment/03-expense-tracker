import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { adminStats, adminUserUsage, sweepStaleReceipts } from "@/lib/receipts";

export const dynamic = "force-dynamic";

/** GET /api/admin/stats (admin): aggregate counts and caps, per-user counts. Never expense bodies or images. */
export async function GET() {
  try {
    const admin = await requireRole("admin");
    await sweepStaleReceipts().catch(() => undefined);
    const [stats, users] = await Promise.all([adminStats(admin), adminUserUsage(admin)]);
    return Response.json({ stats, users });
  } catch (err) {
    return errorResponse(err);
  }
}
