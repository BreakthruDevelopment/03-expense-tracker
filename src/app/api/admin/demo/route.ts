import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { assertDemoStorage, loadDemoWorkspace, releaseDemoLoad, reserveDemoLoad } from "@/lib/demo-workspace";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * POST /api/admin/demo (admin): replace the demo users' expenses and receipts with the sample data.
 * Bodyless: callers cannot choose CLI credentials or elevate a demo user. 1 per minute and 5 per
 * UTC day for the whole app. Answers `{ users, expenses, receipts }`.
 */
export async function POST(request: Request) {
  try {
    const actor = await requireRole("admin");
    requireSameOrigin(request);
    assertDemoStorage();
    await reserveDemoLoad(actor);
    try {
      return Response.json(await loadDemoWorkspace(actor));
    } catch (err) {
      await releaseDemoLoad().catch(() => undefined);
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
