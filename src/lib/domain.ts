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
