import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { deleteExpense, getExpense, updateExpense } from "@/lib/expenses";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/expenses/:id. Owner only; everyone else (admin included) gets 404. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ expense: await getExpense(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/expenses/:id. Body: any of the create fields plus `updatedAt` (409 when stale). */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    return Response.json({ expense: await updateExpense(user, id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/expenses/:id. Removes the receipt image first. */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    await deleteExpense(user, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
