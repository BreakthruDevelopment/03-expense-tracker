/** Constants shared by the schema, validation, storage and (later) the UI. No imports: safe anywhere. */

export const CATEGORIES = ["meals", "travel", "lodging", "transport", "office", "software", "equipment", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

/** All two-decimal currencies, so money is always integer cents. */
export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "MXN", "CHF", "INR"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const EXPENSE_SOURCES = ["manual", "receipt"] as const;

export const RECEIPT_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ReceiptContentType = (typeof RECEIPT_CONTENT_TYPES)[number];

export const RECEIPT_STATUSES = ["uploading", "ready", "rejected"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Hard cap per image (signed into the upload URL as x-goog-content-length-range). */
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

/** 1,000,000.00 in minor units. */
export const MAX_AMOUNT_MINOR = 100_000_000;

/** Most expenses one user can keep. */
export const MAX_EXPENSES_PER_USER = 500;

/** Rows in one CSV export. */
export const EXPORT_MAX_ROWS = 5000;

/** Per-user sliding-window limits (one hour). */
export const UPLOADS_PER_HOUR = 20;
export const DOWNLOADS_PER_HOUR = 120;
export const EXTRACTIONS_PER_HOUR = 10;
/** Admin purges per admin per hour. */
export const PURGES_PER_HOUR = 30;

/** Stale receipts the sweep removes: an upload never confirmed, and a confirmed draft nobody saved. */
export const STALE_UPLOAD_SECONDS = 60 * 60;
export const STALE_DRAFT_SECONDS = 24 * 60 * 60;
export const SWEEP_BATCH = 50;

/** A claimed extraction that never finished (crashed instance) can be claimed again after this long. */
export const EXTRACT_CLAIM_SECONDS = 60;
