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

import { useEffect, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "./SessionProvider";

export interface MagicLinkVerifierProps {
  readonly paramName: string;
  readonly children?: ReactNode;
}

export function MagicLinkVerifier({ paramName, children }: MagicLinkVerifierProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { verifyAndRefresh } = useSession();

  useEffect(() => {
    const verificationToken = searchParams.get(paramName);
    if (!verificationToken) {
      router.replace("/login");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await verifyAndRefresh({ verificationToken });
        if (!cancelled) router.replace("/dashboard");
      } catch {
        if (!cancelled) router.replace("/login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams, paramName, verifyAndRefresh]);

  return <>{children}</>;
}
