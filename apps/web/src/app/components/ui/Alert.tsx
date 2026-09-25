"use client";

// In-page recovery / status Alert primitive (M2 #82).
//
// Background: the M2 UX addendum requires #82 to render in-page recovery
// surfaces on invalid/expired magic-link verification and to map sign-out
// transport failures to a bounded customer-safe message. No Alert / Banner /
// FieldError shared component exists in the repository, so this primitive
// covers the in-page surfaces this remediation pass introduces. It is NOT a
// transient toast / notification system — it is a present-on-arrival
// recovery surface, exactly the pattern called out in the addendum.
//
// Three variants separate recovery attention from genuine operation failure
// (per the addendum's gold-vs-failure rule):
//
//   - variant="recovery" (default for role="alert"):
//       warm parchment surface + restrained gold border. Used for the
//       invalid/expired sign-in link surface. Gold is appropriate because
//       this is genuine recovery context.
//
//   - variant="failure":
//       warm parchment surface + neutral warm border, NO gold accent.
//       Used for genuine operation failures (sign-out transport failure).
//       Gold is not applied to operation failures — the recovery cue
//       stays distinct from the failure cue.
//
//   - variant="status" (used only when role="status"):
//       warm parchment surface + neutral warm border, NO gold. Used for
//       the loading/verification surfaces on /auth/verify and /auth/callback.
//
// Each call site renders exactly one semantic region — never wrap an Alert
// in an outer role="alert" div. The optional `headingRef` lets the caller
// programmatically focus the alert's title after the alert renders, so
// keyboard and screen-reader users land on the error heading rather than
// the previous focus target (which `role="alert"` alone does not guarantee).

import type { HTMLAttributes, ReactNode, Ref } from "react";

type AlertRole = "alert" | "status";

type AlertVariant = "recovery" | "failure" | "status";

export interface AlertAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly testId?: string;
}

export interface AlertProps extends Omit<HTMLAttributes<HTMLElement>, "children" | "role"> {
  readonly role?: AlertRole;
  readonly variant?: AlertVariant;
  readonly testId?: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: AlertAction;
  // The heading is rendered as a real <h2 tabIndex={-1}> so it can receive
  // programmatic focus when the alert mounts. Callers pass a ref from a
  // useRef() so they can drive focus after the catch branch runs.
  readonly headingRef?: Ref<HTMLHeadingElement>;
}

const VARIANT_SURFACE: Record<AlertVariant, string> = {
  recovery: "bg-surface border border-gold/40",
  failure: "bg-surface border border-borderWarm",
  status: "bg-surface border border-borderWarm",
};

const VARIANT_TITLE: Record<AlertVariant, string> = {
  // Recovery and failure titles share the ink family; the surrounding
  // border distinguishes the cue.
  recovery: "text-ink",
  failure: "text-ink",
  status: "text-ink",
};

export function Alert({
  role = "alert",
  variant,
  testId,
  title,
  children,
  action,
  headingRef,
  ...rest
}: AlertProps) {
  // For role="status" the variant is implicitly the status treatment.
  const resolvedVariant: AlertVariant = role === "status" ? "status" : (variant ?? "recovery");
  const surfaceClasses = VARIANT_SURFACE[resolvedVariant];
  const titleClasses = VARIANT_TITLE[resolvedVariant];

  return (
    <section
      role={role}
      data-testid={testId}
      data-alert-variant={resolvedVariant}
      className={`rounded-lg p-4 ${surfaceClasses}`}
      {...rest}
    >
      <h2
        ref={headingRef}
        tabIndex={-1}
        className={`text-base font-medium ${titleClasses} focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine`}
      >
        {title}
      </h2>
      <p className="mt-2 text-base text-muted">{children}</p>
      {action && (
        <div className="mt-3">
          <button
            type="button"
            onClick={action.onClick}
            data-testid={action.testId}
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-4 text-base font-medium text-aubergine hover:text-aubergine-hover focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine focus:ring-2 focus:ring-aubergine rounded"
          >
            {action.label}
          </button>
        </div>
      )}
    </section>
  );
}
