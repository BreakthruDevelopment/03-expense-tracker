"use client";

import { inputClass, labelClass } from "@/components/ui/styles";
import { CATEGORIES, CURRENCIES } from "@/lib/domain";
import { categoryLabel } from "@/lib/format";

export type ExpenseValues = {
  merchant: string;
  spentOn: string;
  amount: string;
  tax: string;
  /** Empty when the currency is unknown: the user must pick one. */
  currency: string;
  category: string;
  note: string;
};

export const emptyValues = (): ExpenseValues => ({
  merchant: "",
  spentOn: "",
  amount: "",
  tax: "",
  currency: "USD",
  category: "other",
  note: "",
});

/** The create/update body from a form submit. Money stays a string; the server converts it to minor units. */
export function valuesFromForm(form: HTMLFormElement): ExpenseValues {
  const f = new FormData(form);
  const get = (k: string) => String(f.get(k) ?? "");
  return {
    merchant: get("merchant").trim(),
    spentOn: get("spentOn"),
    amount: get("amount").trim(),
    tax: get("tax").trim(),
    currency: get("currency"),
    category: get("category"),
    note: get("note"),
  };
}

export function bodyFromValues(v: ExpenseValues) {
  return {
    merchant: v.merchant,
    spentOn: v.spentOn,
    amount: v.amount,
    tax: v.tax === "" ? null : v.tax,
    currency: v.currency,
    category: v.category,
    note: v.note,
  };
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={labelClass}>
      <label htmlFor={id} className="block">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-sm font-normal text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The seven expense inputs, uncontrolled: the parent reads them from the form on submit and
 * remounts them (with a new `key`) when it has new defaults. `errors` is keyed by field name.
 */
export function ExpenseFields({
  idPrefix,
  values,
  errors = {},
  disabled = false,
  currencyHint,
}: {
  idPrefix: string;
  values: ExpenseValues;
  errors?: Record<string, string>;
  disabled?: boolean;
  currencyHint?: string;
}) {
  const id = (n: string) => `${idPrefix}-${n}`;
  const describe = (n: string, hint = false) => (errors[n] ? id(`${n}-error`) : hint ? id(`${n}-hint`) : undefined);
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-4 sm:grid-cols-2">
      <legend className="sr-only">Expense details</legend>
      <div className="sm:col-span-2">
        <Field id={id("merchant")} label="Merchant" error={errors.merchant}>
          <input
            id={id("merchant")}
            name="merchant"
            type="text"
            required
            maxLength={120}
            defaultValue={values.merchant}
            aria-invalid={Boolean(errors.merchant)}
            aria-describedby={describe("merchant")}
            className={inputClass}
          />
        </Field>
      </div>
      <Field id={id("spentOn")} label="Date" error={errors.spentOn}>
        <input
          id={id("spentOn")}
          name="spentOn"
          type="date"
          required
          defaultValue={values.spentOn}
          aria-invalid={Boolean(errors.spentOn)}
          aria-describedby={describe("spentOn")}
          className={inputClass}
        />
      </Field>
      <Field id={id("category")} label="Category" error={errors.category}>
        <select
          id={id("category")}
          name="category"
          defaultValue={values.category}
          aria-invalid={Boolean(errors.category)}
          aria-describedby={describe("category")}
          className={inputClass}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
      </Field>
      <Field id={id("amount")} label="Total" error={errors.amount} hint="For example 12.40">
        <input
          id={id("amount")}
          name="amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          required
          defaultValue={values.amount}
          aria-invalid={Boolean(errors.amount)}
          aria-describedby={describe("amount", true)}
          className={inputClass}
        />
      </Field>
      <Field id={id("currency")} label="Currency" error={errors.currency} hint={currencyHint}>
        <select
          id={id("currency")}
          name="currency"
          required
          defaultValue={values.currency}
          aria-invalid={Boolean(errors.currency)}
          aria-describedby={describe("currency", Boolean(currencyHint))}
          className={inputClass}
        >
          {values.currency === "" && (
            <option value="" disabled>
              Choose a currency
            </option>
          )}
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field id={id("tax")} label="Tax (optional)" error={errors.tax}>
        <input
          id={id("tax")}
          name="tax"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={values.tax}
          aria-invalid={Boolean(errors.tax)}
          aria-describedby={describe("tax")}
          className={inputClass}
        />
      </Field>
      <div className="sm:col-span-2">
        <Field id={id("note")} label="Note (optional)" error={errors.note}>
          <textarea
            id={id("note")}
            name="note"
            rows={3}
            maxLength={500}
            defaultValue={values.note}
            aria-invalid={Boolean(errors.note)}
            aria-describedby={describe("note")}
            className={inputClass}
          />
        </Field>
      </div>
    </fieldset>
  );
}
