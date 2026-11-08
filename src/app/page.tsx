import Link from "next/link";
import { DemoBadge, PageIntro, Panel, buttonOutlineAccent, buttonPrimary } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const STEPS = [
  { title: "Scan", text: "Snap a photo of a receipt, or choose a file. It goes straight to a private bucket." },
  { title: "Check", text: "The AI fills in a form. Nothing is saved until you review the numbers and confirm." },
  { title: "Export", text: "Your expenses roll up into monthly totals by category and a CSV you can download." },
];

export default async function Home() {
  const user = await getCurrentUser();
  return (
    <>
      <PageIntro
        section="Expense Tracker"
        title="Snap a receipt. Check the numbers. Done."
        description="Receipts are private files in a locked bucket, and the AI only fills a form you confirm."
        actions={
          user ? (
            <>
              <Link href="/expenses" className={buttonPrimary}>
                View expenses
              </Link>
              <Link href="/expenses/new" className={buttonOutlineAccent}>
                Scan a receipt
              </Link>
            </>
          ) : (
            <Link href="/sign-in" className={buttonPrimary}>
              Sign in
            </Link>
          )
        }
      />
      <Panel title="Demo data only" action={<DemoBadge />}>
        <p className="text-muted">
          This is a portfolio demo on a free-tier model that may use prompts to improve Google products. Don&apos;t upload real receipts.
        </p>
      </Panel>
      <Panel title="How it works">
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="space-y-1">
              <p className="font-semibold">
                <span className="text-accent">{i + 1}.</span> {s.title}
              </p>
              <p className="text-sm text-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
}
