import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  CATEGORIES,
  CURRENCIES,
  EXPENSE_SOURCES,
  MAX_AMOUNT_MINOR,
  MAX_RECEIPT_BYTES,
  RECEIPT_CONTENT_TYPES,
  RECEIPT_STATUSES,
} from "@/lib/domain";

/** SQL list literal for a CHECK constraint, built from a trusted constant array. */
const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

/** Millisecond-precision timestamps: the UI echoes `updated_at` back as an edit conflict token. */
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });


// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Expense tracker. Money is integer minor units (all supported currencies have
// 2 decimals). Every row carries owner_id; queries filter on it (see src/lib/owned.ts).
// ---------------------------------------------------------------------------

/** One uploaded receipt image. A receipt with no expense is a draft. */
export const receipt = pgTable(
  "receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // u/<ownerId>/<receiptId>: generated server-side, no filename or extension.
    objectKey: text("object_key").notNull().unique(),
    contentType: text("content_type", { enum: RECEIPT_CONTENT_TYPES }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: text("status", { enum: RECEIPT_STATUSES }).notNull().default("uploading"),
    extraction: jsonb("extraction"),
    extractionMode: text("extraction_mode", { enum: ["live", "demo", "failed"] }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("receipt_id_owner_uq").on(t.id, t.ownerId),
    index("receipt_owner_status_created_idx").on(t.ownerId, t.status, t.createdAt),
    check("receipt_content_type_chk", sql`${t.contentType} in (${list(RECEIPT_CONTENT_TYPES)})`),
    check("receipt_status_chk", sql`${t.status} in (${list(RECEIPT_STATUSES)})`),
    check("receipt_mode_chk", sql`${t.extractionMode} is null or ${t.extractionMode} in ('live','demo','failed')`),
    check("receipt_size_chk", sql`${t.sizeBytes} between 1 and ${sql.raw(String(MAX_RECEIPT_BYTES))}`),
    check("receipt_key_chk", sql`${t.objectKey} = 'u/' || ${t.ownerId} || '/' || ${t.id}::text`),
  ],
);

export const expense = pgTable(
  "expense",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    merchant: text("merchant").notNull(),
    spentOn: date("spent_on", { mode: "string" }).notNull(),
    amountMinor: integer("amount_minor").notNull(),
    taxMinor: integer("tax_minor"),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    category: text("category", { enum: CATEGORIES }).notNull().default("other"),
    note: text("note").notNull().default(""),
    source: text("source", { enum: EXPENSE_SOURCES }).notNull().default("manual"),
    aiMode: text("ai_mode", { enum: ["live", "demo"] }),
    // Deleting a receipt (purge, discard) keeps the expense and nulls the link.
    // The composite FK below ties the link to the same owner.
    receiptId: uuid("receipt_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // (receipt_id, owner_id) must match one receipt row, so an expense can't point at someone
    // else's receipt. The hand-edited migration SQL adds `SET NULL (receipt_id)` (PG 15+) so only
    // the link is cleared, not owner_id; drizzle can't express the column list.
    foreignKey({ columns: [t.receiptId, t.ownerId], foreignColumns: [receipt.id, receipt.ownerId], name: "expense_receipt_owner_fk" }).onDelete("set null"),
    uniqueIndex("expense_receipt_id_uq").on(t.receiptId),
    index("expense_owner_spent_idx").on(t.ownerId, t.spentOn.desc()),
    index("expense_owner_category_idx").on(t.ownerId, t.category),
    check("expense_merchant_len", sql`char_length(${t.merchant}) between 1 and 120`),
    check("expense_note_len", sql`char_length(${t.note}) <= 500`),
    check("expense_amount_range", sql`${t.amountMinor} between 1 and ${sql.raw(String(MAX_AMOUNT_MINOR))}`),
    check("expense_tax_range", sql`${t.taxMinor} is null or ${t.taxMinor} between 0 and ${sql.raw(String(MAX_AMOUNT_MINOR))}`),
    check("expense_currency_chk", sql`${t.currency} in (${list(CURRENCIES)})`),
    check("expense_category_chk", sql`${t.category} in (${list(CATEGORIES)})`),
    check("expense_source_chk", sql`${t.source} in (${list(EXPENSE_SOURCES)})`),
    check("expense_ai_mode_chk", sql`${t.aiMode} is null or ${t.aiMode} in ('live','demo')`),
  ],
);

/** App-wide daily counters (one row per UTC day and kind) for the free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: ["upload", "extract", "demo_load"] }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in ('upload','extract','demo_load')`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["upload", "extract", "download", "demo_load", "purge"] }).notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in ('upload','extract','download','demo_load','purge')`),
  ],
);

export type User = typeof user.$inferSelect;
export type Expense = typeof expense.$inferSelect;
export type Receipt = typeof receipt.$inferSelect;
