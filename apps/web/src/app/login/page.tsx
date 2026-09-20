"use client";

// Login page.
//
// Background: the BG1 integrated browser journey signs in by
// submitting an email to the magic-link endpoint, then either
// following the email link or, in the deterministic / test /
// fallback path, the dev verification URL the server returns. The
// page is the single browser entry point for both flows.
//
// Per GS 4 the page must never accept or surface a client-asserted
// UserAccount. The only state the browser maintains is the email
// form value; every authority decision happens server-side after
// the session cookie is set.
//
// M2 (#82) visual-QA remediation: the submit button uses the
// aubergine semantic-action family (authentication actions are
// structural / management). Error surfaces render the in-page
// `Alert` primitive with role="alert" and variant=failure — bounded
// copy, no gold accent (genuine operation failure). The warm
// parchment canvas wrapper is scoped to this #82 page only.
//
// M2 (#82) Tenki remediation: the dev-verification handler
// delegates to `navigateAfterVerify` so the recovery-vs-returnTo
// precedence is pinned at one call site (shared with the
// MagicLinkVerifier callback page). The dev-verification path
// and the email-callback path converge on identical landing rules:
//   - recovery state → /dashboard?recovery=1
//   - validated returnTo → destination
//   - otherwise → /dashboard
//
// Production composition: this module is the production wrapper
// that reads every dependency from the Next runtime / shared
// session seam (`useRouter`, `useSession`, `requestMagicLink`,
// `readReturnFromUrl`) and mounts `<LoginPageContent />` with the
// live values. The inner component (`page-content.tsx`) is the
// testable composition that owns the form state and the dev-
// verification handler — every dependency is a prop so the
// JSDOM/React test infrastructure can mount the real component
// with stubbed router + session and observe the resulting
// `router.push` calls.

import { useRouter } from "next/navigation";
import { requestMagicLink, readReturnFromUrl } from "../lib/auth-client";
import { useSession } from "../components/SessionProvider";
import { LoginPageContent } from "./page-content";

export default function LoginPage() {
  const router = useRouter();
  const session = useSession();
  const returnTo = readReturnFromUrl();

  return (
    <LoginPageContent
      router={router}
      session={session}
      magicLinkClient={{ requestMagicLink }}
      returnTo={returnTo}
    />
  );
}
