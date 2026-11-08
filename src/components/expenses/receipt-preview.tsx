"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buttonSecondary } from "@/components/ui/styles";

const MAX_AUTO_REFRESH = 2;

/**
 * The stored receipt image. Signed links last five minutes, so when the image fails to load
 * (an expired link) this asks the owner-only url route for a fresh one, up to twice on its own,
 * then offers a button.
 */
export function ReceiptPreview({ receiptId, initialUrl }: { receiptId: string; initialUrl: string | null }) {
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const refreshes = useRef(0);
  const started = useRef(false);

  const refresh = useCallback(async () => {
    setState("loading");
    setMessage("");
    try {
      const res = await fetch(`/api/receipts/${receiptId}/url`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(res.status === 404 ? "This receipt image is no longer stored." : body.error || "The image link could not be refreshed.");
      }
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("The image link could not be refreshed.");
      setUrl(data.url);
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error && err.message ? err.message : "Couldn't reach the server. Check your connection and try again.");
    }
  }, [receiptId]);

  useEffect(() => {
    // No link rendered by the server (it was rate limited or storage was busy): fetch one now.
    if (!initialUrl && !started.current) {
      started.current = true;
      void refresh();
    }
  }, [initialUrl, refresh]);

  return (
    <div className="space-y-3">
      <div className="relative flex min-h-48 items-center justify-center overflow-hidden rounded-card border border-border bg-background">
        {url && (
          // Signed storage URL that changes every few minutes, so next/image's optimizer can't cache it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={url}
            src={url}
            alt="Uploaded receipt"
            onLoad={() => setState("ready")}
            onError={() => {
              if (refreshes.current < MAX_AUTO_REFRESH) {
                refreshes.current += 1;
                void refresh();
              } else {
                setState("error");
                setMessage("The image could not be loaded.");
              }
            }}
            className={`max-h-[32rem] w-full object-contain ${state === "ready" ? "" : "invisible"}`}
          />
        )}
        {state === "loading" && (
          <p role="status" className="absolute inset-0 flex items-center justify-center text-sm text-muted">
            Loading receipt image…
          </p>
        )}
        {state === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
            <p role="alert" className="text-sm font-medium text-danger">
              {message}
            </p>
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => {
                refreshes.current = 0;
                void refresh();
              }}
            >
              Try again
            </button>
          </div>
        )}
      </div>
      {url && state === "ready" && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:underline">
          Open full size
        </a>
      )}
    </div>
  );
}
