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

import { Suspense } from "react";
import { MagicLinkVerifier } from "../../components/MagicLinkVerifier";
import { Card } from "../../components/ui/Card";

export default function AuthCallbackPage() {
  return (
    <div className="max-w-md mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold text-gray-900 mb-4">Signing you in…</h1>
      <Card>
        <Card.Content>
          <p className="text-sm text-gray-700">
            Verifying your magic link. You will be redirected shortly.
          </p>
        </Card.Content>
      </Card>
      <Suspense fallback={null}>
        <MagicLinkVerifier paramName="token" />
      </Suspense>
    </div>
  );
}
