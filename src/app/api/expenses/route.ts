import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { createExpense, listExpenses } from "@/lib/expenses";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/expenses?month=YYYY-MM&category=&page=&pageSize= : the caller's own expenses. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = new URL(request.url).searchParams;
    return Response.json(await listExpenses(user, p.get("month"), p.get("category"), p.get("page"), p.get("pageSize")));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/expenses. Body: { merchant, spentOn, amount: "12.40", tax?, currency?, category?, note?, receiptId? } */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const expense = await createExpense(user, await readJson(request));
    return Response.json({ expense }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
