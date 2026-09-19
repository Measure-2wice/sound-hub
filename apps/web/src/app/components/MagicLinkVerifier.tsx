"use client";

// Magic-link verification shared component.
//
// Background: both the Supabase callback URL
// (`/auth/callback?token=...`) and the deterministic adapter's dev
// verification URL (`/auth/verify?token=...`) POST the private
// verification credential to the API. The shared component
// encapsulates the call so the two pages cannot drift in their
// handling of expired / already-used / network-failure outcomes.
//
// Per ticket #59 P2-001 the credential field is named
// `verificationToken` on the wire — distinct from the public
// `requestId` correlation id returned from `/api/auth/magic-link`.
// Presenting the public correlation id to `/api/auth/verify-token`
// is rejected as an unknown credential, so the component must
// always read the private token from the URL query parameter.
//
// The verifier consumes the shared session seam
// (`SessionProvider.verifyAndRefresh`) so a successful verification
// immediately re-pulls the authoritative user and every other
// auth-aware client component (the navigation's `SessionStatus`,
// the dashboard) sees the new identity without a full page
// reload. A failed verification throws from `verifyAndRefresh`
// without touching session state, so the navigation cannot read
// "signed in" for an unverified session.
//
// M2 (#82): the verify-token response carries a validated
// `returnTo` field and a server-derived `setupState`. The
// verifier applies `returnTo` when present (and only when the
// setup is "converged" — recovery overrides the return context).
// When `setupState === "recovery"`, the verifier routes the
// browser to `/dashboard?recovery=1` so the dashboard renders the
// recovery surface.
//
// M2 (#82) visual-QA remediation: an invalid or expired verification
// no longer silently redirects to `/login`. The verifier now owns
// the in-page recovery state machine:
//
//   - pending verification: returns its `children` (the page-level
//     loading surface — `role="status"`).
//   - failed verification: returns an in-page `<Alert>` recovery
//     surface directly, REPLACING the loading surface. The two
//     surfaces are mutually exclusive — the loading copy never sits
//     alongside the recovery alert.
//   - successful verification: `router.replace(...)` from the
//     success branch; nothing on the verify/callback page renders.
//
// Focus behavior: when the recovery alert renders, a `useEffect`
// moves focus to the alert's heading (via `errorHeadingRef`). This
// supplements `role="alert"` because role-alert alone does not move
// focus — a screen reader user can otherwise land on stale focus
// from the loading surface.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "./SessionProvider";
import { Alert } from "./ui/Alert";

export interface MagicLinkVerifierProps {
  readonly paramName: string;
  readonly children?: ReactNode;
}

export function MagicLinkVerifier({ paramName, children }: MagicLinkVerifierProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { verifyAndRefresh } = useSession();

  // In-page recovery state. When set, the verifier returns the
  // recovery Alert instead of the loading children. The two are
  // mutually exclusive — never both rendered.
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const errorHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const verificationToken = searchParams.get(paramName);
    if (!verificationToken) {
      router.replace("/login");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await verifyAndRefresh({ verificationToken });
        if (cancelled) return;
        // Apply return context ONLY when the setup is converged.
        // Recovery overrides return context so a retry does not
        // land back at an inaccessible destination.
        //
        // The verifier branches per case so each literal /
        // validated-path value lands at a Next-typed-route
        // boundary directly. The recovery literal matches
        // `${StaticRoutes}${SearchOrHash}` (`/dashboard` +
        // `?recovery=1`) and `/dashboard` matches `StaticRoutes`,
        // so both pass through without a cast. For the
        // `response.returnTo` branch, the cast
        // `(response.returnTo as Route) ?? "/dashboard"` keeps
        // `response.returnTo` typed as `string | null` until the
        // cast point — `null` is not assignable to either
        // `Route = string & {}` (un-augmented) or
        // `Route = RouteImpl<string>` (augmented), so the cast
        // is structurally necessary in both environments and the
        // `@typescript-eslint/no-unnecessary-type-assertion`
        // rule does not flag it. The runtime `?? "/dashboard"`
        // collapses the null case to the canonical dashboard;
        // the cast is a type-level assertion only (no runtime
        // coercion), so a null value still routes safely.
        if (response.user.setupState === "recovery") {
          router.replace("/dashboard?recovery=1");
        } else {
          router.replace((response.returnTo as Route) ?? "/dashboard");
        }
      } catch {
        // Render the in-page recovery surface in-place. The catch
        // branch MUST NOT redirect to /dashboard, set the user, or
        // refresh the seam — a failed verification cannot mark the
        // user signed in. The action button inside the recovery
        // Alert is the user opt-in path to /login.
        if (!cancelled) setVerificationError("This sign-in link can't be used.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams, paramName, verifyAndRefresh]);

  // Move focus to the recovery alert's heading when it renders so
  // keyboard / screen-reader users land on the error summary rather
  // than the previous focus target. role="alert" alone does not
  // guarantee focus movement.
  useEffect(() => {
    if (verificationError !== null && errorHeadingRef.current !== null) {
      errorHeadingRef.current.focus();
    }
  }, [verificationError]);

  if (verificationError !== null) {
    return (
      <Alert
        role="alert"
        variant="recovery"
        testId="magic-link-verifier-error"
        title="This sign-in link can't be used."
        headingRef={errorHeadingRef}
        action={{
          label: "Request a new sign-in link",
          onClick: () => {
            router.replace("/login");
          },
          testId: "magic-link-verifier-resend",
        }}
      >
        The link may have expired or already been used. You can request a new one below.
      </Alert>
    );
  }
  return <>{children}</>;
}
