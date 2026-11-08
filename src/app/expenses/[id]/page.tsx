import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { isDemoEmail } from "@/lib/demo-identity";
import { NotFoundError } from "@/lib/errors";
import { getExpense } from "@/lib/expenses";
import { signReceiptUrl } from "@/lib/receipts";
import { log } from "@/lib/log";
import { ExpenseEditor } from "./expense-editor";

export const metadata: Metadata = { title: "Expense" };
export const dynamic = "force-dynamic";

export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  let expense;
  try {
    expense = await getExpense(user, id);
  } catch (err) {
    // Not yours, or not there: the same 404 for everyone, admin included.
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  // The first link is signed on the server; the preview asks for a new one if it expires.
  let receiptUrl: string | null = null;
  if (expense.receiptId) {
    try {
      receiptUrl = (await signReceiptUrl(user, expense.receiptId)).url;
    } catch (err) {
      log.warn("expense.receipt_url_failed", { error: err instanceof Error ? err.message : "unknown" });
    }
  }

  return (
    <>
      <ExpenseEditor
        key={expense.updatedAt.toISOString()}
        expense={{
          id: expense.id,
          merchant: expense.merchant,
          spentOn: expense.spentOn,
          amount: expense.amount,
          tax: expense.tax ?? "",
          currency: expense.currency,
          category: expense.category,
          note: expense.note,
          updatedAt: expense.updatedAt.toISOString(),
          source: expense.source,
          aiMode: expense.aiMode,
          receiptId: expense.receiptId,
        }}
        receiptUrl={receiptUrl}
        demoBadge={isDemoEmail(user.email) || expense.aiMode === "demo" ? (expense.aiMode === "demo" ? "Demo AI" : "Demo data") : null}
      />
    </>
  );
}
