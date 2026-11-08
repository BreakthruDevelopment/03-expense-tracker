"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonDanger, buttonSecondary } from "@/components/ui/styles";
import { sendJson } from "@/lib/client-api";

/** Delete one person's stored receipt images (their expenses stay). Needs a confirm click. */
export function PurgeReceiptsButton({ userId, name, receipts }: { userId: string; name: string; receipts: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function purge() {
    setPending(true);
    setError("");
    const res = await sendJson("POST", `/api/admin/users/${encodeURIComponent(userId)}/purge-receipts`);
    setPending(false);
    setConfirming(false);
    if (res.ok) {
      const { purged } = res.data as { purged: number };
      setMessage(`Deleted ${purged} ${purged === 1 ? "image" : "images"}.`);
      router.refresh();
    } else {
      setError(res.message);
    }
  }

  if (confirming) {
    return (
      <div className="space-y-2" aria-busy={pending}>
        <p className="break-words text-sm">Delete {receipts} stored {receipts === 1 ? "image" : "images"} for {name}? Their expenses stay.</p>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <button type="button" disabled={pending} onClick={() => void purge()} className={buttonDanger}>
            {pending ? "Deleting…" : "Yes, delete images"}
          </button>
          <button type="button" disabled={pending} onClick={() => setConfirming(false)} className={buttonSecondary}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={receipts === 0}
        aria-label={`Purge receipt images for ${name}`}
        onClick={() => {
          setMessage("");
          setError("");
          setConfirming(true);
        }}
        className={`${buttonDanger} w-full sm:w-auto`}
      >
        Purge receipt images
      </button>
      {error && (
        <p role="alert" className="break-words text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="break-words text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
