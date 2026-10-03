"use client";

// M2 (#86, slice 86F): minimal accessible confirmation-dialog primitive.
//
// The codebase's established Alert primitive renders inline recovery /
// status surfaces, not modal confirmations. The slice plan requires
// accessible dialogs for Pause / Reactivate / Update / final-sample
// removal. This primitive is the smallest reusable dialog that
// satisfies the M2 UX contract:
//
//   - `role="alertdialog"` + `aria-modal="true"` (correct semantics)
//   - `aria-labelledby` → the title (accessible name)
//   - `aria-describedby` → the body (accessible description)
//   - initial focus moves to the confirm button (safe default; the
//     primary action lives on the keyboard tab order)
//   - Tab / Shift+Tab focus is CONTAINED inside the dialog while
//     open (the M2 UX contract: "Dialogs and interstitials move
//     focus appropriately into the active surface, contain keyboard
//     focus while modal, and restore focus to the invoking control
//     or appropriate destination when dismissed.")
//   - Escape dismisses when cancellation is allowed. Escape is NOT
//     an unconditional rule after an operation is irreversible or
//     actively committing (the M2 UX contract: "Before consequential
//     submission they provide Cancel, Back, or Escape dismissal
//     where safe. Escape is not an unconditional rule after an
//     operation is irreversible or actively committing.") — the
//     `pending` flag gates Escape during an active commit.
//   - background scroll is locked while open
//   - focus is restored to the previously-focused element on close
//   - `prefers-reduced-motion` disables the fade
//
// The component is non-portal (the slice plan does not require overlay
// stacking; the existing in-page layout carries a clear visual
// separation). When modal semantics are required, the same shape
// composes into a portal at the slice page boundary.

import { useCallback, useEffect, useId, useMemo, useRef, type ReactNode } from "react";

export interface ConfirmationDialogProps {
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly pending?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly testIdPrefix: string;
  readonly identityContext?: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
  testIdPrefix,
  identityContext,
}: ConfirmationDialogProps) {
  const reactId = useId();
  const titleId = `${reactId}-title`;
  const descId = `${reactId}-desc`;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // M2 (#86, slice 86F Tenki PR feedback): callers pass inline
  // arrow functions for `onCancel` (and `onConfirm`). Without
  // stabilization, every parent re-render would re-run this
  // effect — the cleanup re-calls `restoreFocusRef.current.focus()`
  // while the dialog is still open, stealing focus from the
  // user's current position. We stabilize via refs so the effect
  // only runs once per mount (when the dialog opens) and once on
  // unmount (when the dialog closes).
  const onCancelRef = useRef<() => void>(() => {});
  const onConfirmRef = useRef<() => void>(() => {});
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);
  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  // Focus entry + Escape-to-dismiss + body scroll lock + focus
  // containment. Runs once per mount; `pending` is read via a
  // ref so a pending-state change does not tear down + re-arm the
  // effect mid-commit (which would re-snapshot `restoreFocusRef`
  // and call focus() on a now-stale element).
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      confirmRef.current?.focus();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape dismisses when cancellation is allowed. Per the M2 UX
      // contract, Escape is NOT unconditional while a command is
      // actively committing (the `pending` flag, read via ref so
      // the latest value is honored without re-binding).
      if (event.key === "Escape" && !pendingRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      // Tab / Shift+Tab focus containment. The dialog body is the
      // only focusable scope while open; we wrap to the first /
      // last focusable element when the user tabs past the edge.
      if (event.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => el.offsetParent !== null);
        if (focusables.length === 0) {
          event.preventDefault();
          confirmRef.current?.focus();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === first || active === root) {
            event.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      // M2 (#86, slice 86F Tenki PR feedback): only restore focus
      // when the dialog actually unmounts. The cleanup runs once
      // at unmount; the effect never re-binds during the dialog's
      // lifetime (see the ref-based stabilization above).
      restoreFocusRef.current?.focus?.();
    };
    // The effect intentionally depends on the empty dependency
    // array — it is the dialog's mount lifecycle. `onCancel` /
    // `pending` reach the handler via refs so identity changes do
    // not tear the effect down mid-dialog.
  }, []);

  const buttonClass = useMemo(
    () =>
      destructive
        ? "inline-flex items-center justify-center min-h-[44px] py-2 px-4 text-base font-medium text-white bg-coral hover:opacity-90 rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral disabled:opacity-50"
        : "inline-flex items-center justify-center min-h-[44px] py-2 px-4 text-base font-medium text-white bg-coral hover:opacity-90 rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral disabled:opacity-50",
    [destructive],
  );

  const handleConfirm = useCallback(() => {
    onConfirmRef.current();
  }, []);
  const handleCancel = useCallback(() => {
    if (pendingRef.current) return;
    onCancelRef.current();
  }, []);

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-testid={testIdPrefix}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 motion-safe:animate-[fade-in_120ms_ease-out]"
    >
      <div className="w-full max-w-md rounded-lg border border-borderWarm bg-canvas p-6 shadow-lg">
        <h2 id={titleId} className="font-serif text-lg text-ink mb-2" tabIndex={-1}>
          {title}
        </h2>
        {identityContext ? (
          <p className="text-xs text-muted mb-3" data-testid={`${testIdPrefix}-context`}>
            {identityContext}
          </p>
        ) : null}
        <div id={descId} className="text-sm text-ink mb-4">
          {description}
        </div>
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            className="inline-flex items-center justify-center min-h-[44px] py-2 px-4 text-sm font-medium text-ink underline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50"
            data-testid={`${testIdPrefix}-cancel`}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            className={buttonClass}
            data-testid={`${testIdPrefix}-confirm`}
          >
            {pending ? `${confirmLabel}…` : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
