"use client";

// ErrorSummary (M2 #84).
//
// Background: the M2 UX addendum requires that "Substantial or
// consequential forms with multiple possible errors include a
// focusable, linked error summary that navigates to each invalid
// field". The repo has no `aria-invalid` / `aria-describedby`
// patterns yet (verified against apps/web/src/app) — this
// component introduces the smallest possible accessibility surface
// that satisfies the addendum's requirement:
//
//   - Renders a focusable `role="alert"` `tabIndex={-1}` container.
//   - On mount, focuses the heading via a `useRef`.
//   - Lists each error with an anchor link to the corresponding
//     field id (the field is expected to set the matching `id`).
//
// The parent is responsible for providing the list of errors AND
// for wiring the anchor `href="#<fieldId>"`. The summary does not
// invent field ids; it trusts the parent's path → field id
// mapping.

"use client";

import { useEffect, useRef } from "react";

export interface ErrorSummaryItem {
  readonly id: string;
  readonly path: string;
  readonly message: string;
}

export interface ErrorSummaryProps {
  readonly title: string;
  readonly errors: readonly ErrorSummaryItem[];
  readonly testId?: string;
}

export function ErrorSummary({ title, errors, testId = "error-summary" }: ErrorSummaryProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (errors.length === 0) return;
    // Focus the container (not the heading) so screen readers
    // announce the whole region. The heading is inside the
    // focused subtree.
    containerRef.current?.focus();
  }, [errors.length]);

  if (errors.length === 0) return null;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      role="alert"
      aria-live="polite"
      className="rounded-xl border border-error bg-error-container/40 p-4"
      data-testid={testId}
    >
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold text-on-error-container mb-2"
      >
        {title}
      </h2>
      <ul className="space-y-1 text-sm text-on-error-container">
        {errors.map((err) => (
          <li key={err.path} data-testid={`${testId}-item-${err.path}`}>
            <a
              href={`#${err.id}`}
              className="underline hover:no-underline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
              data-testid={`${testId}-link-${err.path}`}
            >
              {err.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
