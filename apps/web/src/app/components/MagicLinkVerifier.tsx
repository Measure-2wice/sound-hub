"use client";

// Magic-link verification shared component.
//
// Background: both the Supabase callback URL (`/auth/callback?token=...`)
// and the deterministic adapter's dev verification URL
// (`/auth/verify?request_id=...`) POST the request id to the API. The
// shared component encapsulates the call so the two pages cannot
// drift in their handling of expired / already-used / network-
// failure outcomes.

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
    const requestId = searchParams.get(paramName);
    if (!requestId) {
      router.replace("/login" as unknown as Parameters<typeof router.replace>[0]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await verifyToken({ requestId });
        if (!cancelled)
          router.replace("/dashboard" as unknown as Parameters<typeof router.replace>[0]);
      } catch {
        if (!cancelled) router.replace("/login" as unknown as Parameters<typeof router.replace>[0]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams, paramName]);

  return <>{children}</>;
}
