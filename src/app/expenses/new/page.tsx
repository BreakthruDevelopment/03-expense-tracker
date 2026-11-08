import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { storage } from "@/lib/storage";
import { NewExpense } from "./new-expense";

export const metadata: Metadata = { title: "New expense" };
export const dynamic = "force-dynamic";

export default async function NewExpensePage() {
  await requireUserOrRedirect();
  // With no storage driver (production without a bucket) uploads are off; manual entry still works.
  const scanEnabled = storage().kind !== "none";
  return (
    <>
      <PageIntro
        section="Expenses"
        title="Add an expense"
        description="Photograph a receipt and check what the AI reads, or type the expense in yourself."
        actions={
          <Link href="/expenses" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:underline">
            Back to expenses
          </Link>
        }
      />
      <NewExpense scanEnabled={scanEnabled} />
    </>
  );
}
