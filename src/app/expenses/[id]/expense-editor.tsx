"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ExpenseFields, type ExpenseValues, bodyFromValues, valuesFromForm } from "@/components/expenses/expense-fields";
import { ReceiptPreview } from "@/components/expenses/receipt-preview";
import { DemoBadge, PageIntro, Panel, buttonDanger, buttonPrimary, buttonSecondary } from "@/components/ui";
import { sendJson } from "@/lib/client-api";

type Props = {
  expense: ExpenseValues & { id: string; updatedAt: string; source: string; aiMode: string | null; receiptId: string | null };
  receiptUrl: string | null;
  demoBadge: string | null;
};

export function ExpenseEditor({ expense, receiptUrl, demoBadge }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(expense.merchant);
  const [token, setToken] = useState(expense.updatedAt);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = valuesFromForm(e.currentTarget);
    setError("");
    setSaved("");
    setConflict(false);
    setFieldErrors({});
    setPending(true);
    const res = await sendJson("PATCH", `/api/expenses/${expense.id}`, { ...bodyFromValues(v), updatedAt: token });
    setPending(false);
    if (res.ok) {
      const next = (res.data as { expense: { updatedAt: string } }).expense;
      setToken(next.updatedAt);
      setTitle(v.merchant);
      setSaved("Changes saved.");
      return;
    }
    if (res.status === 409) setConflict(true);
    if (res.status === 404) {
      router.replace("/expenses");
      return;
    }
    setFieldErrors(res.fields);
    setError(res.message);
  }

  async function remove() {
    setDeleteError("");
    setDeleting(true);
    const res = await sendJson("DELETE", `/api/expenses/${expense.id}`);
    if (res.ok || res.status === 404) {
      router.push("/expenses");
      return;
    }
    setDeleting(false);
    setDeleteError(res.message);
  }

  const busy = pending || deleting;

  return (
    <>
      <PageIntro
        section="Expenses"
        title={title}
        description="View or change this expense, or delete it."
        actions={
          <>
            <Link href="/expenses" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:underline">
              Back to expenses
            </Link>
            {demoBadge && (
              <span className="inline-flex min-h-11 items-center">
                <DemoBadge label={demoBadge} />
              </span>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <Panel title="Details">
          <form onSubmit={save} className="space-y-4" aria-busy={pending}>
            <ExpenseFields idPrefix="edit" values={expense} errors={fieldErrors} disabled={busy} />
            {error && (
              <div role="alert" className="space-y-3 break-words rounded-card border border-border bg-blocked-soft px-3 py-2 text-sm font-medium text-danger">
                <p>{conflict ? "This expense changed since you opened it. Reload to see the latest version, then make your change again." : error}</p>
                {conflict && (
                  <button type="button" className={buttonSecondary} onClick={() => router.refresh()}>
                    Reload latest
                  </button>
                )}
              </div>
            )}
            {saved && (
              <p role="status" className="text-sm font-medium text-success">
                {saved}
              </p>
            )}
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="submit" disabled={busy} className={`${buttonPrimary} w-full sm:w-auto`}>
                {pending ? "Saving…" : "Save changes"}
              </button>
            </div>
            <p className="text-sm text-muted">
              {expense.source === "receipt" ? "Added from a scanned receipt" : "Entered by hand"}
              {expense.aiMode === "demo" ? " (demo extraction)" : expense.aiMode === "live" ? " (read by AI, checked by you)" : ""}.
            </p>
          </form>
        </Panel>

        <Panel title="Delete expense">
          {confirming ? (
            <div className="space-y-3">
              <p className="break-words text-sm">
                Delete this expense{expense.receiptId ? " and its receipt image" : ""}? This can&apos;t be undone.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <button type="button" disabled={busy} onClick={() => void remove()} className={`${buttonDanger} w-full sm:w-auto`}>
                  {deleting ? "Deleting…" : "Yes, delete"}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={`${buttonSecondary} w-full sm:w-auto`}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirming(true)} className={`${buttonDanger} w-full sm:w-auto`}>
              Delete expense
            </button>
          )}
          {deleteError && (
            <p role="alert" className="mt-3 break-words text-sm font-medium text-danger">
              {deleteError}
            </p>
          )}
        </Panel>
      </div>

      <Panel title="Receipt">
        {expense.receiptId ? (
          <ReceiptPreview receiptId={expense.receiptId} initialUrl={receiptUrl} />
        ) : (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No receipt image is attached to this expense.</p>
        )}
      </Panel>
      </div>
    </>
  );
}
