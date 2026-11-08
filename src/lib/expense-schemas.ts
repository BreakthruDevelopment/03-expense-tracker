import { z } from "zod";
import { CATEGORIES, CURRENCIES, MAX_AMOUNT_MINOR, RECEIPT_CONTENT_TYPES, MAX_RECEIPT_BYTES } from "@/lib/domain";

export const idSchema = z.uuid();
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM");
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD").refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, "Not a real date");

/** "12.40" or "12" to integer minor units. Money is never a float. */
const AMOUNT_RE = /^\d{1,7}(\.\d{1,2})?$/;
export function toMinor(amount: string): number {
  const [whole, frac = ""] = amount.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
export function fromMinor(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

const amount = z
  .string()
  .regex(AMOUNT_RE, "Enter an amount like 12.40")
  .transform(toMinor)
  .refine((n) => n >= 1 && n <= MAX_AMOUNT_MINOR, "Amount must be between 0.01 and 1,000,000.00");
const tax = z
  .string()
  .regex(AMOUNT_RE, "Enter an amount like 0.95")
  .transform(toMinor)
  .refine((n) => n <= MAX_AMOUNT_MINOR, "Tax is too large");

const merchant = z.string().trim().min(1, "Merchant is required").max(120, "Merchant is at most 120 characters");
const note = z.string().max(500, "Note is at most 500 characters");

export const createExpenseSchema = z
  .object({
    merchant,
    spentOn: dateSchema,
    amount,
    tax: tax.nullable().optional(),
    currency: z.enum(CURRENCIES).default("USD"),
    category: z.enum(CATEGORIES).default("other"),
    note: note.default(""),
    /** Optional: the actor's own `ready` draft receipt. */
    receiptId: idSchema.optional(),
  })
  .strict();

/** `updatedAt` is the value the client loaded; the update only applies if it still matches. */
export const updateExpenseSchema = z
  .object({
    merchant: merchant.optional(),
    spentOn: dateSchema.optional(),
    amount: amount.optional(),
    tax: tax.nullable().optional(),
    currency: z.enum(CURRENCIES).optional(),
    category: z.enum(CATEGORIES).optional(),
    note: note.optional(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "updatedAt"), { message: "Nothing to change" });

export const listQuerySchema = z.object({
  month: monthSchema.optional(),
  category: z.enum(CATEGORIES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const exportQuerySchema = z.object({ from: dateSchema.optional(), to: dateSchema.optional() });

export const initUploadSchema = z
  .object({
    contentType: z.enum(RECEIPT_CONTENT_TYPES),
    sizeBytes: z.number().int().min(1, "File is empty").max(MAX_RECEIPT_BYTES, "Receipts can be at most 5 MB"),
  })
  .strict();

/** Query strings give null for a missing parameter; zod wants undefined. */
export const blankToUndefined = (v: unknown) => (v === null || v === "" ? undefined : v);
