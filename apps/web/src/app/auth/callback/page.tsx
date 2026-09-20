"use client";

// Magic-link callback page.
//
// Background: managed providers redirect the browser back to a
// callback URL with the magic-link credential as a query parameter.
// The BG1 architecture keeps the API boundary authoritative: the
// browser POSTs the private one-time credential to
// `/api/auth/verify-token` as `verificationToken`, the server
// validates it, issues a session, and sets the HttpOnly cookie.
// This page is the URL target the managed provider redirects to —
// it pulls the PRIVATE credential from `?token=...` (per ticket
// #59 P0-001) and posts it to the API.
//
// IMPORTANT: the producer (Supabase) and the consumer (this page)
// MUST agree on the query parameter name. Supabase appends the
// one-time credential as `?token=...` to the configured
// `emailRedirectTo` URL; this page reads the same `token`
// parameter. `requestId` is reserved for the PUBLIC correlation id
// emitted by `/api/auth/magic-link` and is NOT accepted here.
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

export default function AuthCallbackPage() {
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
