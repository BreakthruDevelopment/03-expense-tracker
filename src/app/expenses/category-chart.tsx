import type { MonthlySummary } from "@/lib/expenses";
import { categoryLabel, formatMoney } from "@/lib/format";

type Currency = MonthlySummary["currencies"][number];

/**
 * Spending by category for one currency, as token-coloured divs. The values are always shown as text;
 * the bars are decoration (aria-hidden), and the list carries the accessible label.
 */
export function CategoryChart({ currency }: { currency: Currency }) {
  const max = Math.max(...currency.categories.map((c) => c.totalMinor), 1);
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-muted">
        {currency.currency} · {formatMoney(currency.totalMinor, currency.currency)} in {currency.count} {currency.count === 1 ? "expense" : "expenses"}
      </h3>
      <ul aria-label={`Spending by category in ${currency.currency}`} className="space-y-2">
        {currency.categories.map((c) => {
          const pct = Math.max(2, Math.round((c.totalMinor / max) * 100));
          return (
            <li key={c.category} className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-1 sm:grid-cols-[7rem_1fr_9rem]">
              <span className="text-sm">{categoryLabel(c.category)}</span>
              <span aria-hidden className="col-start-2 row-start-1 h-3 overflow-hidden rounded-md bg-background sm:col-start-2">
                <span className="block h-full rounded-md bg-accent" style={{ width: `${pct}%` }} />
              </span>
              <span className="col-start-2 text-sm font-medium tabular-nums sm:col-start-3 sm:row-start-1 sm:text-right">
                {formatMoney(c.totalMinor, currency.currency)}
                <span className="font-normal text-muted"> · {c.count} {c.count === 1 ? "expense" : "expenses"}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
