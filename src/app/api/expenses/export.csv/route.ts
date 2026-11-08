import { requireUser } from "@/lib/auth/session";
import { exportCsv } from "@/lib/expenses";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/expenses/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD : the caller's own rows, at most 5,000. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = new URL(request.url).searchParams;
    const csv = await exportCsv(user, p.get("from"), p.get("to"));
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="expenses.csv"',
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
