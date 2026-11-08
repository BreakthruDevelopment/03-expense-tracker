import { describe, expect, it } from "vitest";
import { applyGuardrails, modelOutputSchema } from "./extract-receipt";

const NOW = new Date("2026-11-08T12:00:00Z");
const good = { isReceipt: true, merchant: "Bluebird Coffee", date: "2026-10-14", currency: "USD", total: 12.4, tax: 0.95, category: "meals", lineItems: [], confidence: "high" };

describe("modelOutputSchema", () => {
  it("turns one bad field into null or low instead of failing the whole parse", () => {
    const out = modelOutputSchema.parse({ ...good, date: "14/10/2026", currency: "dollars", total: "12.40", tax: -3, confidence: "certain" });
    expect(out).toMatchObject({ date: null, currency: null, total: null, tax: null, confidence: "low", merchant: "Bluebird Coffee" });
  });

  it("treats missing fields the same way", () => {
    const rest: Record<string, unknown> = { ...good };
    for (const k of ["date", "currency", "total", "tax", "confidence"]) delete rest[k];
    expect(modelOutputSchema.parse(rest)).toMatchObject({ date: null, currency: null, total: null, tax: null, confidence: "low" });
  });

  it("still rejects output with no usable shape", () => {
    expect(() => modelOutputSchema.parse({ isReceipt: "maybe" })).toThrow();
    expect(() => modelOutputSchema.parse({ ...good, isReceipt: undefined })).toThrow();
  });

  it("a bad field then shows up as a warning on the draft", () => {
    const extraction = applyGuardrails(modelOutputSchema.parse({ ...good, total: 0, currency: "??" }), NOW);
    expect(extraction.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["currency_missing", "total_missing"]));
  });
});

describe("merchant and date", () => {
  it("a bad merchant becomes null with a merchant_missing warning", () => {
    const e = applyGuardrails(modelOutputSchema.parse({ ...good, merchant: 5 }), NOW);
    expect(e.draft?.merchant).toBeNull();
    expect(e.warnings.map((w) => w.code)).toContain("merchant_missing");
  });

  it("a missing date warns with date_missing", () => {
    const e = applyGuardrails(modelOutputSchema.parse({ ...good, date: null }), NOW);
    expect(e.draft?.spentOn).toBeNull();
    expect(e.warnings.map((w) => w.code)).toContain("date_missing");
    expect(applyGuardrails(modelOutputSchema.parse(good), NOW).warnings.map((w) => w.code)).not.toContain("date_missing");
  });
});

describe("applyGuardrails: tax larger than the total", () => {
  it("warns and keeps the values for the user to fix", () => {
    const e = applyGuardrails(modelOutputSchema.parse({ ...good, total: 5, tax: 9 }), NOW);
    expect(e.warnings.map((w) => w.code)).toContain("tax_exceeds_total");
    expect(e.draft).toMatchObject({ total: "5.00", tax: "9.00" });
  });

  it("does not warn when tax equals the total or is smaller, or when either is missing", () => {
    for (const [total, tax] of [[5, 5], [12.4, 0.95], [null, 3], [5, null]] as const) {
      const e = applyGuardrails(modelOutputSchema.parse({ ...good, total, tax }), NOW);
      expect(e.warnings.map((w) => w.code), `${total}/${tax}`).not.toContain("tax_exceeds_total");
    }
  });
});
