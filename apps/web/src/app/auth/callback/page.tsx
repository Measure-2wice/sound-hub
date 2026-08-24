"use client";

// Magic-link callback page.
//
// Background: managed providers redirect the browser back to a
// callback URL with the magic-link token as a query parameter. The
// BG1 architecture keeps the API boundary authoritative: the browser
// POSTs the request id to `/api/auth/verify-token`, the server
// validates the token, issues a session, and sets the HttpOnly
// cookie. This page is the URL target the provider redirects to —
// it pulls the request id from `?request_id=...` and posts it to
// the API.

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
        <MagicLinkVerifier paramName="request_id" />
      </Suspense>
    </div>
  );
}