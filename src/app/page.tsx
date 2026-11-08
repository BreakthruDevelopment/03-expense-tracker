import Link from "next/link";
import { DemoBadge, PageIntro, Panel, buttonPrimary } from "@/components/ui";

export default function Home() {
  return (
    <>
      <PageIntro
        section="Expense Tracker"
        title="Snap a receipt. Check the numbers. Done."
        description="Receipts are private files in a locked bucket, and the AI only fills a form you confirm."
        actions={
          <Link href="/sign-in" className={buttonPrimary}>
            Sign in
          </Link>
        }
      />
      <Panel title="Demo data only" action={<DemoBadge />}>
        <p className="text-muted">
          This is a portfolio demo on a free-tier model that may use prompts to improve Google products. Don&apos;t upload real receipts.
        </p>
      </Panel>
    </>
  );
}
