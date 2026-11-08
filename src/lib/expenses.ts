import "server-only";
import { and, count, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { csvRow } from "@/lib/csv";
import { db, schema } from "@/lib/db";
import type { Expense } from "@/lib/db/schema";
import { EXPORT_MAX_ROWS, MAX_EXPENSES_PER_USER } from "@/lib/domain";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  blankToUndefined,
  createExpenseSchema,
  exportQuerySchema,
  fromMinor,
  idSchema,
  listQuerySchema,
  monthSchema,
  updateExpenseSchema,
} from "@/lib/expense-schemas";
import { ownedBy } from "@/lib/owned";
import { deleteReceiptObjectAndRow } from "@/lib/receipts";
import { advisoryLock } from "@/lib/usage";

const { expense, receipt } = schema;

export type ExpenseView = Expense & { amount: string; tax: string | null };

const toView = (row: Expense): ExpenseView => ({
  ...row,
  amount: fromMinor(row.amountMinor),
  tax: row.taxMinor === null ? null : fromMinor(row.taxMinor),
});

/** An id that isn't a UUID can't name an expense; answer 404 rather than a database error. */
function parseId(id: unknown): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new NotFoundError("Expense not found");
  return parsed.data;
}

/** The conflict token must always move forward, even for two writes in one millisecond. */
const nextUpdatedAt = () => sql`greatest(now(), ${expense.updatedAt} + interval '1 millisecond')`;

/** First day of `month` (YYYY-MM) and of the month after, as dates. */
function monthBounds(month: string): { start: string; next: string } {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { start: `${month}-01`, next: `${next}-01` };
}

export async function getExpense(actor: Actor, id: string): Promise<ExpenseView> {
  const [row] = await db().select().from(expense).where(ownedBy(expense, actor, eq(expense.id, parseId(id)))).limit(1);
  if (!row) throw new NotFoundError("Expense not found");
  return toView(row);
}

export type ExpensePage = { items: ExpenseView[]; total: number; page: number; pageSize: number };

export async function listExpenses(actor: Actor, month?: unknown, category?: unknown, page?: unknown, pageSize?: unknown): Promise<ExpensePage> {
  const q = listQuerySchema.parse({
    month: blankToUndefined(month),
    category: blankToUndefined(category),
    page: blankToUndefined(page),
    pageSize: blankToUndefined(pageSize),
  });
  const b = q.month ? monthBounds(q.month) : null;
  const where = ownedBy(
    expense,
    actor,
    b ? and(gte(expense.spentOn, b.start), lt(expense.spentOn, b.next)) : undefined,
    q.category ? eq(expense.category, q.category) : undefined,
  );
  const [rows, [{ n }]] = await Promise.all([
    db()
      .select()
      .from(expense)
      .where(where)
      .orderBy(desc(expense.spentOn), desc(expense.createdAt), desc(expense.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db().select({ n: count() }).from(expense).where(where),
  ]);
  return { items: rows.map(toView), total: n, page: q.page, pageSize: q.pageSize };
}

export async function createExpense(actor: Actor, input: unknown): Promise<ExpenseView> {
  assertCan(actor, "create");
  const data = createExpenseSchema.parse(input);
  const created = await db().transaction(async (tx) => {
    // Serialize one user's creates so concurrent requests can't slip past the cap.
    await advisoryLock(tx, `expense-create:${actor.id}`);
    const [{ n }] = await tx.select({ n: count() }).from(expense).where(ownedBy(expense, actor));
    if (n >= MAX_EXPENSES_PER_USER) {
      throw new ConflictError(`You can keep at most ${MAX_EXPENSES_PER_USER} expenses. Delete one to add another.`);
    }
    let attach: { id: string; mode: "live" | "demo" | null } | null = null;
    if (data.receiptId) {
      // Only the actor's own receipt counts; anyone else's (admin included) is a 404.
      const [r] = await tx
        .select({ id: receipt.id, status: receipt.status, mode: receipt.extractionMode })
        .from(receipt)
        .where(ownedBy(receipt, actor, eq(receipt.id, data.receiptId)))
        .for("update")
        .limit(1);
      if (!r) throw new NotFoundError("Receipt not found");
      if (r.status !== "ready") throw new ConflictError("That receipt isn't ready yet.");
      const [taken] = await tx.select({ id: expense.id }).from(expense).where(eq(expense.receiptId, r.id)).limit(1);
      if (taken) throw new ConflictError("That receipt is already attached to an expense.");
      attach = { id: r.id, mode: r.mode === "live" || r.mode === "demo" ? r.mode : null };
    }
    const [row] = await tx
      .insert(expense)
      .values({
        ownerId: actor.id,
        merchant: data.merchant,
        spentOn: data.spentOn,
        amountMinor: data.amount,
        taxMinor: data.tax ?? null,
        currency: data.currency,
        category: data.category,
        note: data.note,
        source: attach ? "receipt" : "manual",
        aiMode: attach?.mode ?? null,
        receiptId: attach?.id ?? null,
      })
      .returning();
    return row;
  });
  return toView(created);
}

export async function updateExpense(actor: Actor, id: string, input: unknown): Promise<ExpenseView> {
  const expenseId = parseId(id);
  const data = updateExpenseSchema.parse(input);
  const rows = await db()
    .update(expense)
    .set({
      ...(data.merchant !== undefined ? { merchant: data.merchant } : {}),
      ...(data.spentOn !== undefined ? { spentOn: data.spentOn } : {}),
      ...(data.amount !== undefined ? { amountMinor: data.amount } : {}),
      ...(data.tax !== undefined ? { taxMinor: data.tax } : {}),
      ...(data.currency !== undefined ? { currency: data.currency } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.note !== undefined ? { note: data.note } : {}),
      updatedAt: nextUpdatedAt(),
    })
    .where(ownedBy(expense, actor, eq(expense.id, expenseId), eq(expense.updatedAt, new Date(data.updatedAt))))
    .returning();
  if (rows.length === 0) {
    // Not ours or missing (404), or ours but changed since the client loaded it (409).
    await getExpense(actor, expenseId);
    throw new ConflictError("This expense changed since you opened it. Reload to see the latest version.");
  }
  return toView(rows[0]);
}

/** Delete the receipt image first (a storage failure is a 502 and the row stays), then the rows. */
export async function deleteExpense(actor: Actor, id: string): Promise<void> {
  const expenseId = parseId(id);
  const [row] = await db()
    .select({ id: expense.id, receiptId: expense.receiptId })
    .from(expense)
    .where(ownedBy(expense, actor, eq(expense.id, expenseId)))
    .limit(1);
  if (!row) throw new NotFoundError("Expense not found");
  if (row.receiptId) await deleteReceiptObjectAndRow(actor.id, row.receiptId);
  await db().delete(expense).where(ownedBy(expense, actor, eq(expense.id, expenseId)));
}

export type MonthlySummary = {
  month: string;
  currencies: { currency: string; totalMinor: number; total: string; count: number; categories: { category: string; totalMinor: number; total: string; count: number }[] }[];
};

/** Totals by category, per currency (no conversion). */
export async function monthlySummary(actor: Actor, month: unknown): Promise<MonthlySummary> {
  const m = monthSchema.parse(month);
  const b = monthBounds(m);
  const rows = await db()
    .select({
      currency: expense.currency,
      category: expense.category,
      total: sql<string>`sum(${expense.amountMinor})::bigint`,
      n: count(),
    })
    .from(expense)
    .where(ownedBy(expense, actor, gte(expense.spentOn, b.start), lt(expense.spentOn, b.next)))
    .groupBy(expense.currency, expense.category)
    .orderBy(expense.currency, desc(sql`sum(${expense.amountMinor})`), expense.category);
  const byCurrency = new Map<string, MonthlySummary["currencies"][number]>();
  for (const r of rows) {
    const total = Number(r.total);
    let c = byCurrency.get(r.currency);
    if (!c) byCurrency.set(r.currency, (c = { currency: r.currency, totalMinor: 0, total: "", count: 0, categories: [] }));
    c.totalMinor += total;
    c.count += r.n;
    c.categories.push({ category: r.category, totalMinor: total, total: fromMinor(total), count: r.n });
  }
  const currencies = [...byCurrency.values()].map((c) => ({ ...c, total: fromMinor(c.totalMinor) }));
  return { month: m, currencies };
}

export const CSV_HEADER = ["Date", "Merchant", "Category", "Amount", "Tax", "Currency", "Note", "Source", "Has receipt"];

/** The actor's own expenses as CSV text (at most 5,000 rows), formula-injection safe. */
export async function exportCsv(actor: Actor, from?: unknown, to?: unknown): Promise<string> {
  const q = exportQuerySchema.parse({ from: blankToUndefined(from), to: blankToUndefined(to) });
  const rows = await db()
    .select()
    .from(expense)
    .where(ownedBy(expense, actor, q.from ? gte(expense.spentOn, q.from) : undefined, q.to ? lte(expense.spentOn, q.to) : undefined))
    .orderBy(desc(expense.spentOn), desc(expense.createdAt), desc(expense.id))
    .limit(EXPORT_MAX_ROWS);
  const lines = [csvRow(CSV_HEADER)];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.spentOn,
        r.merchant,
        r.category,
        fromMinor(r.amountMinor),
        r.taxMinor === null ? "" : fromMinor(r.taxMinor),
        r.currency,
        r.note,
        r.source,
        r.receiptId ? "yes" : "no",
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
