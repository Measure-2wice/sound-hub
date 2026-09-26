"use client";

// SaveDraftActions (M2 #84).
//
// Background: the Professional Profile editor uses the explicit
// Saving / Saved / Couldn't save affordance trio per the M2 UX
// addendum's "Explicit-save feedback" canonical pattern. This
// component owns only the affordance state — the parent owns the
// submit handler and the underlying fetch call.
//
// Lifecycle:
//   - `idle`     — no action; the Save draft button is enabled.
//   - `saving`   — the request is in flight; the button shows
//                 "Saving draft…" and is disabled (no double-
//                 submit).
//   - `saved`    — the request succeeded; the button shows "Saved"
//                 briefly via `role="status"` so screen readers
//                 announce the change. The button reverts to idle
//                 after a short delay (the parent may also re-render
//                 on its own).
//   - `error`    — the request failed with a recoverable error;
//                 the button shows "Couldn't save · Try again" and
//                 re-enables so the user can retry without losing
//                 the entered values.

"use client";

import { useEffect, useState } from "react";

export type SaveDraftActionState = "idle" | "saving" | "saved" | "error";

export interface SaveDraftActionsProps {
  readonly state: SaveDraftActionState;
  readonly errorMessage: string | null;
  readonly onRetry: () => void;
  readonly testIdPrefix?: string;
}

export function SaveDraftActions({
  state,
  errorMessage,
  onRetry,
  testIdPrefix = "save-draft",
}: SaveDraftActionsProps) {
  const [savedAnnounced, setSavedAnnounced] = useState(false);
  useEffect(() => {
    if (state === "saved") {
      setSavedAnnounced(true);
      const timer = setTimeout(() => setSavedAnnounced(false), 1800);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state]);

  if (state === "error") {
    return (
      <div
        role="alert"
        aria-live="polite"
        className="flex items-center gap-3 text-base"
        data-testid={`${testIdPrefix}-error`}
      >
        <span className="text-ink" data-testid={`${testIdPrefix}-error-message`}>
          {errorMessage ?? "Couldn't save. Try again."}
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-2 px-4 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
          data-testid={`${testIdPrefix}-retry`}
        >
          Try again
        </button>
      </div>
    );
  }

  if (state === "saving") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-2 text-base text-muted"
        data-testid={`${testIdPrefix}-saving`}
      >
        <span className="material-symbols-outlined text-[20px] animate-spin">sync</span>
        <span>Saving draft…</span>
      </div>
    );
  }

  if (state === "saved" && savedAnnounced) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-2 text-base text-seaGlass"
        data-testid={`${testIdPrefix}-saved`}
      >
        <span className="material-symbols-outlined text-[20px]">check_circle</span>
        <span>Saved</span>
      </div>
    );
  }

  return null;
}
