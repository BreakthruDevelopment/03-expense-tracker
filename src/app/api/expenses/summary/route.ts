import { requireUser } from "@/lib/auth/session";
import { monthlySummary } from "@/lib/expenses";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/expenses/summary?month=YYYY-MM : totals by category, per currency. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    return Response.json(await monthlySummary(user, new URL(request.url).searchParams.get("month")));
  } catch (err) {
    return errorResponse(err);
  }
}
