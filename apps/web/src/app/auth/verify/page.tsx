"use client";

// Dev verification URL landing page.
//
// Background: the deterministic identity adapter returns a
// `devVerificationUrl` from `POST /api/auth/magic-link` so the
// buildathon E2E journey can sign in without real email delivery.
// The URL points at `/auth/verify?token=<verificationToken>`; this
// page extracts the PRIVATE one-time credential and posts it to
// the verify-token endpoint exactly like the production callback
// page. The two pages never diverge because they share the verifier
// component AND both configure `paramName="token"` — the
// canonical credential query parameter the managed and
// deterministic producers emit (per ticket #59 P0-001).
//
// M2 (#82) visual-QA remediation: the page-level loading surface
// is rendered AS `children` of `MagicLinkVerifier`. On invalid or
// expired verification the verifier replaces the loading surface
// with an in-page recovery alert — the two are mutually exclusive.
// The `role="status"` loading paragraph never sits alongside the
// recovery alert. The warm parchment canvas wrapper is scoped to
// this #82 page only — the global layout body color is untouched.

import { Suspense } from "react";
import { MagicLinkVerifier } from "../../components/MagicLinkVerifier";

export default function DevVerifyPage() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-md mx-auto px-6 py-12">
        <Suspense fallback={null}>
          <MagicLinkVerifier paramName="token">
            <h1 className="text-3xl font-bold text-ink mb-4">Signing you in…</h1>
            <div className="rounded-lg bg-surface border border-borderWarm p-4">
              <p role="status" className="text-base text-muted">
                We&apos;re confirming your sign-in. You&apos;ll be redirected shortly.
              </p>
            </div>
          </MagicLinkVerifier>
        </Suspense>
      </div>
    </div>
  );
}
