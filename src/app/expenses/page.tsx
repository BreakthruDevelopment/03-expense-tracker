import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  type Column,
  DataList,
  DemoBadge,
  FilterBar,
  PageIntro,
  Panel,
  StatGrid,
  StatTile,
  buttonOutlineAccent,
  buttonPrimary,
} from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { isDemoEmail } from "@/lib/demo-identity";
import { CATEGORIES } from "@/lib/domain";
import { type ExpenseView, countReceiptExpenses, listExpenses, monthlySummary } from "@/lib/expenses";
import { monthSchema } from "@/lib/expense-schemas";
import { categoryLabel, currentMonth, formatDay, formatMoney, monthLabel, monthRange, shiftMonth } from "@/lib/format";
import { CategoryChart } from "./category-chart";

export const metadata: Metadata = { title: "Expenses" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

type SearchParams = Record<string, string | string[] | undefined>;

/** Filters live in the URL. A bad value falls back to the default instead of failing the page. */
const filtersSchema = z.object({
  // A function, so the default is computed per request (the current month in UTC), not once at module load.
  month: monthSchema.catch(() => currentMonth()),
  category: z.enum(CATEGORIES).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The last 12 months, plus the selected one when it is older. */
function monthOptions(selected: string) {
  const now = currentMonth();
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(now, i));
  if (!months.includes(selected)) months.push(selected);
  return months.sort().reverse().map((m) => ({ value: m, label: monthLabel(m) }));
}

function href(month: string, category: string | undefined, page: number) {
  const p = new URLSearchParams({ month });
  if (category) p.set("category", category);
  if (page > 1) p.set("page", String(page));
  return `/expenses?${p}`;
}

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUserOrRedirect();
  const sp = await searchParams;
  const { month, category, page } = filtersSchema.parse({
    month: first(sp.month),
    category: first(sp.category) || undefined,
    page: first(sp.page),
  });
  const demoUser = isDemoEmail(user.email);

  const [summary, list, receipts] = await Promise.all([
    monthlySummary(user, month),
    listExpenses(user, month, category, page, PAGE_SIZE),
    countReceiptExpenses(user, month),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  if (page > pages) redirect(href(month, category, pages));

  const monthCount = summary.currencies.reduce((n, c) => n + c.count, 0);
  const multi = summary.currencies.length > 1;
  // Amounts in different currencies can't be ranked, so the top category comes from the currency with the most expenses.
  const lead = [...summary.currencies].sort((a, b) => b.count - a.count)[0];
  const top = lead?.categories[0];
  const { from, to } = monthRange(month);

  const columns: Column<ExpenseView>[] = [
    { key: "date", header: "Date", cell: (e) => <span className="whitespace-nowrap">{formatDay(e.spentOn)}</span> },
    {
      key: "merchant",
      header: "Merchant",
      primary: true,
      cell: (e) => (
        <span className="flex flex-wrap items-center gap-2">
          <Link href={`/expenses/${e.id}`} className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline">
            {e.merchant}
          </Link>
          {(demoUser || e.aiMode === "demo") && <DemoBadge label={e.aiMode === "demo" ? "Demo AI" : "Demo data"} />}
        </span>
      ),
    },
    { key: "category", header: "Category", cell: (e) => categoryLabel(e.category) },
    { key: "source", header: "Source", cell: (e) => (e.source === "receipt" ? "Receipt" : "Manual") },
    {
      key: "amount",
      header: "Amount",
      className: "text-right tabular-nums",
      cell: (e) => <span className="font-semibold tabular-nums">{formatMoney(e.amountMinor, e.currency)}</span>,
    },
  ];

  return (
    <>
      <PageIntro
        section="Expenses"
        title="Your expenses"
        description={`${monthLabel(month)}: totals by category and every expense, per currency.`}
        actions={
          <>
            <Link href="/scan" className={buttonPrimary}>
              Scan a receipt
            </Link>
            <a href={`/api/expenses/export.csv?from=${from}&to=${to}`} className={buttonOutlineAccent}>
              Export CSV
            </a>
          </>
        }
      />

      <FilterBar
        label="Filter expenses"
        filters={[
          { name: "month", label: "Month", value: month, options: monthOptions(month) },
          {
            name: "category",
            label: "Category",
            value: category ?? "",
            options: [{ value: "", label: "All categories" }, ...CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))],
          },
        ]}
      />

      {monthCount === 0 ? (
        <Panel title={monthLabel(month)}>
          <div className="space-y-4 rounded-card bg-background px-4 py-8 text-center">
            <p className="text-lg font-semibold">No expenses in {monthLabel(month)}</p>
            <p className="text-muted">Snap a receipt and check what the AI reads, or pick another month.</p>
            <Link href="/scan" className={buttonPrimary}>
              Scan your first receipt
            </Link>
          </div>
        </Panel>
      ) : (
        <>
          <StatGrid>
            {summary.currencies.map((c) => (
              <StatTile key={c.currency} value={formatMoney(c.totalMinor, c.currency)} label={`Spent in ${c.currency}`} tone="accent" />
            ))}
            <StatTile value={monthCount} label={monthCount === 1 ? "Expense this month" : "Expenses this month"} />
            <StatTile value={receipts} label={receipts === 1 ? "Receipt scanned" : "Receipts scanned"} />
            {top && lead && <StatTile value={categoryLabel(top.category)} label={multi ? `Top category (${lead.currency})` : "Top category"} />}
          </StatGrid>

          <Panel title="By category">
            <div className="space-y-6">
              {summary.currencies.map((c) => (
                <CategoryChart key={c.currency} currency={c} />
              ))}
            </div>
            {multi && <p className="mt-4 text-sm text-muted">Currencies are never converted or added together.</p>}
          </Panel>

          <Panel
            title={category ? `${categoryLabel(category)} expenses` : "All expenses"}
            count={list.total}
          >
            <DataList
              caption={`Expenses in ${monthLabel(month)}`}
              columns={columns}
              rows={list.items}
              rowKey={(e) => e.id}
              empty={
                <>
                  No {category ? categoryLabel(category).toLowerCase() : ""} expenses in {monthLabel(month)}.{" "}
                  <Link href={href(month, undefined, 1)} className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline">
                    Clear category filter
                  </Link>
                </>
              }
            />
            <p className="mt-3 text-xs text-muted">The CSV has every expense in {monthLabel(month)}, in all categories and currencies.</p>
            {pages > 1 && (
              <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3">
                {page > 1 ? (
                  <Link href={href(month, category, page - 1)} rel="prev" className={buttonOutlineAccent}>
                    Previous
                  </Link>
                ) : (
                  <span />
                )}
                <p className="text-sm text-muted" aria-live="polite">
                  Page {page} of {pages}
                </p>
                {page < pages ? (
                  <Link href={href(month, category, page + 1)} rel="next" className={buttonOutlineAccent}>
                    Next
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
