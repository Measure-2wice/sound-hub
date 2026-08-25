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

import { useEffect, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { verifyToken } from "../lib/auth-client";

export interface MagicLinkVerifierProps {
  readonly paramName: string;
  readonly children?: ReactNode;
}

export function MagicLinkVerifier({ paramName, children }: MagicLinkVerifierProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const verificationToken = searchParams.get(paramName);
    if (!verificationToken) {
      router.replace("/login");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await verifyToken({ verificationToken });
        if (!cancelled) router.replace("/dashboard");
      } catch {
        if (!cancelled) router.replace("/login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams, paramName]);

  return <>{children}</>;
}
