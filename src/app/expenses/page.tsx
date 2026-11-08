import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Expenses" };
export const dynamic = "force-dynamic";

/** Placeholder until the list, summary and CSV export land (spec issue 7). */
export default async function ExpensesPage() {
  await requireUserOrRedirect();
  return (
    <>
      <PageIntro section="Expenses" title="Your expenses" description="Your receipts and expenses will appear here." />
      <Panel title="Nothing here yet">
        <p className="text-muted">The expense list is coming soon.</p>
      </Panel>
    </>
  );
}
