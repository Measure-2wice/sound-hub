"use client";

// Dev verification URL landing page.
//
// Background: the deterministic identity adapter returns a
// `devVerificationUrl` from `POST /api/auth/magic-link` so the
// buildathon E2E journey can sign in without real email delivery.
// The URL points at `/auth/verify?request_id=...`; this page
// extracts the request id and posts it to the verify-token
// endpoint exactly like the production callback page. The two
// pages never diverge because they share the verifier component.

import { Suspense } from "react";
import { MagicLinkVerifier } from "../../components/MagicLinkVerifier";
import { Card } from "../../components/ui/Card";

export default function DevVerifyPage() {
  return (
    <div className="max-w-md mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold text-gray-900 mb-4">Verifying…</h1>
      <Card>
        <Card.Content>
          <p className="text-sm text-gray-700">
            Completing the deterministic sign-in. You will be redirected shortly.
          </p>
        </Card.Content>
      </Card>
      <Suspense fallback={null}>
        <MagicLinkVerifier paramName="request_id" />
      </Suspense>
    </div>
  );
}