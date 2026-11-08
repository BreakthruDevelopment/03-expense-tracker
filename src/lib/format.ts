import type { Category } from "@/lib/domain";

/** Money is stored as integer minor units (the divisor comes from the currency's own fraction digits). Display only. */
export function formatMoney(minor: number, currency: string): string {
  const nf = new Intl.NumberFormat("en-US", { style: "currency", currency });
  return nf.format(minor / 10 ** (nf.resolvedOptions().maximumFractionDigits ?? 2));
}

export const CATEGORY_LABELS: Record<Category, string> = {
  meals: "Meals",
  travel: "Travel",
  lodging: "Lodging",
  transport: "Transport",
  office: "Office",
  software: "Software",
  equipment: "Equipment",
  other: "Other",
};

export const categoryLabel = (c: string): string => CATEGORY_LABELS[c as Category] ?? c;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10" to "October 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** The current UTC month as YYYY-MM. */
export const currentMonth = (now = new Date()): string => now.toISOString().slice(0, 7);

/** The month `n` months before `month`. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}

/** First and last day of a month, as YYYY-MM-DD (for the CSV export's from/to). */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** "2026-10-14" to "Oct 14, 2026" (no timezone shift: the date is a calendar day). */
export function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}, ${y}`;
}
