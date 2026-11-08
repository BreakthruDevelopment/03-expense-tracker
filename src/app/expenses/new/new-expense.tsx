"use client";

import { useRouter } from "next/navigation";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { ExpenseFields, type ExpenseValues, bodyFromValues, emptyValues, valuesFromForm } from "@/components/expenses/expense-fields";
import { DemoBadge, Panel, StatusBadge, buttonOutlineAccent, buttonPrimary, buttonSecondary } from "@/components/ui";
import { sendJson } from "@/lib/client-api";
import { ImageDecodeError, ImageTooLargeError, putWithProgress, resizeToJpeg, type UploadTicket } from "@/lib/client-image";
import type { ReceiptExtraction } from "@/lib/extract-receipt";

/** The extract route answers within 25 s; give the network a little more before giving up. */
const EXTRACT_TIMEOUT_MS = 30_000;

type ExtractionResult = { receiptId: string; mode: "live" | "demo" | "failed"; extraction: ReceiptExtraction | null; message?: string };

type Phase =
  | { k: "choose" }
  | { k: "resizing" }
  | { k: "uploading"; pct: number }
  | { k: "extracting"; receiptId: string }
  | { k: "review"; receiptId: string; mode: ExtractionResult["mode"]; extraction: ReceiptExtraction | null; message?: string }
  | { k: "not_receipt"; receiptId: string }
  | { k: "error"; title: string; message: string; retryExtract?: string; retryUpload?: boolean; chooseAgain?: boolean };

type Tab = "scan" | "manual";

const fileButton = `${buttonPrimary} w-full sm:w-auto`;

function draftValues(d: NonNullable<ReceiptExtraction["draft"]>): ExpenseValues {
  return {
    merchant: d.merchant ?? "",
    spentOn: d.spentOn ?? "",
    amount: d.total ?? "",
    tax: d.tax ?? "",
    currency: d.currency ?? "",
    category: d.category,
    note: "",
  };
}

const CONFIDENCE: Record<ReceiptExtraction["confidence"], { status: "live" | "building" | "blocked"; label: string }> = {
  high: { status: "live", label: "High confidence" },
  medium: { status: "building", label: "Medium confidence" },
  low: { status: "blocked", label: "Low confidence" },
};

export function NewExpense({ scanEnabled }: { scanEnabled: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(scanEnabled ? "scan" : "manual");
  const [phase, setPhase] = useState<Phase>({ k: "choose" });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ scan: null, manual: null });

  // Form state shared by both paths.
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Leaving the page mid-upload stops the transfer; the upload's own catch then discards the draft.
  useEffect(() => {
    return () => uploadAbort.current?.abort();
  }, []);

  const resetForm = useCallback(() => {
    setFormError("");
    setFieldErrors({});
    setSaving(false);
  }, []);

  const changeTab = (t: Tab) => {
    resetForm();
    setTab(t);
  };

  /** Best effort: the stale-draft sweep removes anything this misses. */
  const discard = useCallback(async (receiptId: string) => {
    await sendJson("DELETE", `/api/receipts/${receiptId}`);
  }, []);

  const clearScan = useCallback(() => {
    blobRef.current = null;
    setPreviewUrl(null);
    resetForm();
    setPhase({ k: "choose" });
  }, [resetForm]);

  const extract = useCallback(
    async (receiptId: string) => {
      setPhase({ k: "extracting", receiptId });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), EXTRACT_TIMEOUT_MS);
      const res = await sendJson("POST", `/api/receipts/${receiptId}/extract`, undefined, ctrl.signal);
      clearTimeout(timer);
      if (res.ok) {
        const r = res.data as ExtractionResult;
        if (r.mode === "failed" || !r.extraction) {
          setPhase({ k: "review", receiptId, mode: "failed", extraction: null, message: r.message ?? "We couldn't read this receipt. Enter the details by hand." });
        } else if (!r.extraction.isReceipt || !r.extraction.draft) {
          setPhase({ k: "not_receipt", receiptId });
        } else {
          setPhase({ k: "review", receiptId, mode: r.mode, extraction: r.extraction, message: r.message });
        }
        return;
      }
      if (res.status === 429) {
        void discard(receiptId);
        setPhase({ k: "error", title: "Scanning is paused", message: res.message });
      } else if (res.status === 422) {
        setPhase({ k: "error", title: "That file couldn't be used", message: res.message, chooseAgain: true });
      } else if (res.status === 409) {
        setPhase({ k: "error", title: "Still reading this receipt", message: res.message, retryExtract: receiptId });
      } else if (res.status === 404) {
        setPhase({ k: "error", title: "Receipt not found", message: "We couldn't find that upload. Start again with a new photo.", chooseAgain: true });
      } else if (res.status === -1) {
        setPhase({ k: "error", title: "Reading is taking too long", message: "The receipt may still be processing. Try again, or enter it by hand.", retryExtract: receiptId });
      } else {
        setPhase({ k: "error", title: "Couldn't read the receipt", message: res.message, retryExtract: receiptId });
      }
    },
    [discard],
  );

  const upload = useCallback(
    async (blob: Blob) => {
      const ctrl = new AbortController();
      uploadAbort.current = ctrl;
      setPhase({ k: "uploading", pct: 0 });
      const init = await sendJson("POST", "/api/receipts/uploads", { contentType: "image/jpeg", sizeBytes: blob.size }, ctrl.signal);
      if (ctrl.signal.aborted) {
        // Cancelled while the ticket was being made: give the reservation back.
        if (init.ok) void discard((init.data as UploadTicket).receiptId);
        return;
      }
      if (!init.ok) {
        setPhase({ k: "error", title: "Couldn't start the upload", message: init.message, retryUpload: init.status === 0 });
        return;
      }
      const ticket = init.data as UploadTicket;
      try {
        await putWithProgress(ticket, blob, (f) => setPhase({ k: "uploading", pct: Math.round(f * 100) }), ctrl.signal);
      } catch {
        void discard(ticket.receiptId);
        // A cancel (or leaving the page) has already moved on; only a real failure shows an error.
        if (!ctrl.signal.aborted) {
          setPhase({ k: "error", title: "Upload failed", message: "The photo didn't upload. Check your connection and try again.", retryUpload: true });
        }
        return;
      }
      await extract(ticket.receiptId);
    },
    [discard, extract],
  );

  function cancelUpload() {
    uploadAbort.current?.abort();
    clearScan();
  }

  async function onPick(file: File | undefined) {
    if (!file) return;
    resetForm();
    setPhase({ k: "resizing" });
    try {
      const blob = await resizeToJpeg(file);
      blobRef.current = blob;
      setPreviewUrl(URL.createObjectURL(blob));
      await upload(blob);
    } catch (err) {
      setPhase({
        k: "error",
        title: "Couldn't open that image",
        message:
          err instanceof ImageTooLargeError
            ? "That file is larger than 25 MB. Choose a smaller photo."
            : err instanceof ImageDecodeError || err instanceof DOMException
              ? "Try a JPEG, PNG or WebP photo."
              : "Something went wrong preparing the photo. Try again.",
        chooseAgain: true,
      });
    }
  }

  async function startOver(receiptId?: string) {
    if (receiptId) await discard(receiptId);
    clearScan();
  }

  async function save(e: React.FormEvent<HTMLFormElement>, receiptId?: string) {
    e.preventDefault();
    const v = valuesFromForm(e.currentTarget);
    setFormError("");
    if (!v.currency) {
      setFieldErrors({ currency: "Choose a currency." });
      return;
    }
    setFieldErrors({});
    setSaving(true);
    // `source` and `ai_mode` are not sent: the server derives both from the attached receipt.
    const res = await sendJson("POST", "/api/expenses", { ...bodyFromValues(v), ...(receiptId ? { receiptId } : {}) });
    if (res.ok) {
      router.push(`/expenses?month=${v.spentOn.slice(0, 7)}`);
      return;
    }
    setSaving(false);
    setFieldErrors(res.fields);
    setFormError(res.message);
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (!scanEnabled || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const next: Tab = tab === "scan" ? "manual" : "scan";
    changeTab(next);
    tabRefs.current[next]?.focus();
  }

  const busy = phase.k === "resizing" || phase.k === "uploading" || phase.k === "extracting";

  const tabButton = (t: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`tab-${t}`}
      ref={(el) => {
        tabRefs.current[t] = el;
      }}
      aria-selected={tab === t}
      aria-controls={`panel-${t}`}
      tabIndex={tab === t ? 0 : -1}
      onClick={() => changeTab(t)}
      onKeyDown={onTabKey}
      className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-card px-4 text-sm font-semibold transition-colors sm:flex-none ${
        tab === t ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent-soft"
      }`}
    >
      {label}
    </button>
  );

  const formButtons = (receiptId?: string) => (
    <div className="flex flex-col gap-3 pt-2 sm:flex-row">
      <button type="submit" disabled={saving} className={`${buttonPrimary} w-full sm:w-auto`}>
        {saving ? "Saving…" : "Save expense"}
      </button>
      {receiptId ? (
        <button type="button" disabled={saving} onClick={() => void startOver(receiptId)} className={`${buttonSecondary} w-full sm:w-auto`}>
          Discard and start over
        </button>
      ) : null}
    </div>
  );

  const errorBlock = formError && (
    <p role="alert" className="break-words rounded-card border border-border bg-blocked-soft px-3 py-2 text-sm font-medium text-danger">
      {formError}
    </p>
  );

  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="How to add an expense" className="flex gap-1 rounded-card border border-border bg-surface p-1 sm:inline-flex">
        {tabButton("scan", "Scan receipt")}
        {tabButton("manual", "Enter manually")}
      </div>

      <div role="tabpanel" id="panel-scan" aria-labelledby="tab-scan" hidden={tab !== "scan"} className="space-y-6">
        {!scanEnabled ? (
          <Panel title="Scanning is unavailable">
            <p className="text-muted">Receipt uploads are switched off on this server. You can still enter an expense by hand.</p>
            <button type="button" className={`${buttonPrimary} mt-4 w-full sm:w-auto`} onClick={() => changeTab("manual")}>
              Enter manually
            </button>
          </Panel>
        ) : (
          <>
            {/* The pickers stay mounted so they work from every state; only the buttons come and go. */}
            <input
              ref={cameraRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                void onPick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                void onPick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />

            {phase.k === "choose" && (
              <Panel title="Add a receipt photo">
                <p className="mb-4 max-w-2xl text-muted">
                  The photo is shrunk on your device, stored privately, and read once. Nothing is saved until you check the details and press Save.
                </p>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <button type="button" className={fileButton} onClick={() => cameraRef.current?.click()}>
                    Take photo
                  </button>
                  <button type="button" className={`${buttonOutlineAccent} w-full sm:w-auto`} onClick={() => fileRef.current?.click()}>
                    Choose file
                  </button>
                </div>
                <p className="mt-3 text-sm text-muted">JPEG, PNG or WebP. Demo data only: don&apos;t upload a real receipt.</p>
              </Panel>
            )}

            {busy && (
              <Panel title={phase.k === "uploading" ? "Uploading" : phase.k === "resizing" ? "Preparing photo" : "Reading the receipt"}>
                <div aria-busy="true" className="space-y-4">
                  {phase.k === "uploading" ? (
                    <>
                      <div
                        role="progressbar"
                        aria-label="Upload progress"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={phase.pct}
                        className="h-3 w-full overflow-hidden rounded-card border border-border bg-background"
                      >
                        <div className="h-full bg-accent transition-[width]" style={{ width: `${phase.pct}%` }} />
                      </div>
                      <p role="status" className="text-sm text-muted">
                        Uploading {phase.pct}%
                      </p>
                    </>
                  ) : (
                    <p role="status" className="flex items-center gap-3 text-muted">
                      <span aria-hidden className="size-5 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
                      {phase.k === "resizing" ? "Preparing your photo…" : "Reading the receipt. This can take up to 25 seconds."}
                    </p>
                  )}
                  {phase.k === "uploading" && (
                    <button type="button" className={`${buttonSecondary} w-full sm:w-auto`} onClick={cancelUpload}>
                      Cancel upload
                    </button>
                  )}
                  {previewUrl && (
                    // A local blob URL of the photo the user just chose; nothing to optimise.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewUrl} alt="Your receipt photo" className="max-h-64 rounded-card border border-border object-contain" />
                  )}
                </div>
              </Panel>
            )}

            {phase.k === "error" && (
              <Panel title={phase.title}>
                <p role="alert" className="mb-4 break-words text-sm font-medium text-danger">
                  {phase.message}
                </p>
                <div className="flex flex-col gap-3 sm:flex-row">
                  {phase.retryExtract && (
                    <button type="button" className={`${buttonPrimary} w-full sm:w-auto`} onClick={() => void extract(phase.retryExtract as string)}>
                      Try again
                    </button>
                  )}
                  {phase.retryUpload && (
                    <button type="button" className={`${buttonPrimary} w-full sm:w-auto`} onClick={() => {
                        if (blobRef.current) void upload(blobRef.current);
                      }}>
                      Try again
                    </button>
                  )}
                  {phase.chooseAgain && (
                    <button type="button" className={`${buttonPrimary} w-full sm:w-auto`} onClick={clearScan}>
                      Choose another photo
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${buttonSecondary} w-full sm:w-auto`}
                    onClick={() => {
                      if (phase.retryExtract) void discard(phase.retryExtract);
                      clearScan();
                      changeTab("manual");
                    }}
                  >
                    Enter manually
                  </button>
                </div>
              </Panel>
            )}

            {phase.k === "not_receipt" && (
              <Panel title="This doesn't look like a receipt">
                <p role="alert" className="mb-4 text-sm font-medium text-danger">
                  This doesn&apos;t look like a receipt. Nothing was saved.
                </p>
                {previewUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="The photo that was rejected" className="mb-4 max-h-64 rounded-card border border-border object-contain" />
                )}
                <div className="flex flex-col gap-3 sm:flex-row">
                  <button type="button" className={`${buttonPrimary} w-full sm:w-auto`} onClick={() => void startOver(phase.receiptId)}>
                    Try another photo
                  </button>
                  <button
                    type="button"
                    className={`${buttonSecondary} w-full sm:w-auto`}
                    onClick={() => {
                      void discard(phase.receiptId);
                      clearScan();
                      changeTab("manual");
                    }}
                  >
                    Enter manually
                  </button>
                </div>
              </Panel>
            )}

            {phase.k === "review" && <Review phase={phase} previewUrl={previewUrl} saving={saving} errors={fieldErrors} onSubmit={(e) => void save(e, phase.receiptId)} buttons={formButtons(phase.receiptId)} formError={errorBlock} />}
          </>
        )}
      </div>

      <div role="tabpanel" id="panel-manual" aria-labelledby="tab-manual" hidden={tab !== "manual"}>
        <Panel title="Enter an expense">
          <form onSubmit={(e) => void save(e)} className="space-y-4" aria-busy={saving}>
            <ExpenseFields idPrefix="manual" values={emptyValues()} errors={tab === "manual" ? fieldErrors : {}} disabled={saving} />
            {tab === "manual" && errorBlock}
            {formButtons()}
          </form>
        </Panel>
      </div>
    </div>
  );
}

function Review({
  phase,
  previewUrl,
  saving,
  errors,
  onSubmit,
  buttons,
  formError,
}: {
  phase: Extract<Phase, { k: "review" }>;
  previewUrl: string | null;
  saving: boolean;
  errors: Record<string, string>;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  buttons: React.ReactNode;
  formError: React.ReactNode;
}) {
  const { extraction, mode } = phase;
  const draft = extraction?.draft ?? null;
  const values = draft ? draftValues(draft) : { ...emptyValues(), currency: "USD" };
  const conf = extraction ? CONFIDENCE[extraction.confidence] : null;
  const currencyHint = draft && draft.currency === null ? "The currency wasn't clear on the receipt. Choose it before saving." : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Receipt">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="Your receipt photo" className="max-h-[32rem] w-full rounded-card border border-border bg-background object-contain" />
        ) : (
          <p className="text-muted">No preview available.</p>
        )}
        {draft && draft.lineItems.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-accent">Line items read from the receipt ({draft.lineItems.length})</summary>
            <ul className="mt-2 divide-y divide-border rounded-card border border-border">
              {draft.lineItems.map((li, i) => (
                <li key={i} className="flex items-baseline justify-between gap-4 px-3 py-2">
                  <span className="min-w-0 break-words">{li.description}</span>
                  <span className="shrink-0 tabular-nums">{li.amount}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Panel>

      <Panel title="Check the details">
        <div className="mb-4 space-y-3">
          {mode === "demo" && (
            <p role="status" className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-background px-3 py-2 text-sm">
              <DemoBadge label="Demo AI" />
              <span>Demo extraction: a recorded answer, not read from your image</span>
            </p>
          )}
          {mode === "live" && conf && (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status="live" label="Read by AI" />
              <StatusBadge status={conf.status} label={conf.label} />
            </p>
          )}
          {mode === "demo" && conf && (
            <p className="text-sm">
              <StatusBadge status={conf.status} label={conf.label} />
            </p>
          )}
          {mode === "failed" && (
            <p role="alert" className="break-words rounded-card border border-border bg-building-soft px-3 py-2 text-sm font-medium text-building">
              {phase.message ?? "We couldn't read this receipt. Enter the details by hand."}
            </p>
          )}
          {extraction && extraction.warnings.length > 0 && (
            <div role="status" className="rounded-card border border-border bg-building-soft px-3 py-2 text-sm text-building">
              <p className="font-semibold">Check before saving</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {extraction.warnings.map((w, i) => (
                  <li key={i} className="break-words">
                    {w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-sm text-muted">The AI can be wrong. Nothing is saved until you press Save.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4" aria-busy={saving}>
          <ExpenseFields key={phase.receiptId} idPrefix="review" values={values} errors={errors} disabled={saving} currencyHint={currencyHint} />
          {formError}
          {buttons}
        </form>
      </Panel>
    </div>
  );
}
