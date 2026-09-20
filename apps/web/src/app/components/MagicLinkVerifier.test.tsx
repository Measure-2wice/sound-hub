/* eslint-disable @typescript-eslint/no-floating-promises */
// Magic-link callback contract tests (P0-001 producer/consumer alignment).
//
// Background: per ticket #59 P0-001 the producer (managed Supabase
// callback, deterministic dev verification URL) and the consumer
// (these callback pages) MUST agree on the credential query
// parameter name. Supabase appends the one-time credential as
// `?token=...`; the deterministic adapter emits
// `/auth/verify?token=...`. The callback pages must read the same
// `token` parameter — never `request_id`, which is the public
// correlation id and is NOT a credential.
//
// These tests pin the producer/consumer alignment statically:
//   - the callback pages configure `MagicLinkVerifier` with
//     `paramName="token"` (the producer-emitted parameter),
//   - the login page parses `?token=<credential>` from the dev
//     verification URL,
//   - the deterministic adapter emits `/auth/verify?token=...`.
//
// The runtime round-trip (emitted URL → callback → verify-token →
// HttpOnly session cookie) is exercised end-to-end in the API
// route tests; this file pins the contract at the React boundary.
//
// M2 (#82) visual-QA remediation pins the in-page recovery contract:
// an invalid / expired verification no longer silently redirects to
// /login. The verifier renders an `<Alert role="alert">` recovery
// surface in-place, moves focus to the alert's heading via a
// useRef-bound headingRef, and replaces the loading surface (its
// `children`) with the Alert — never both visible. The catch branch
// still MUST NOT redirect to /dashboard, set the user, or refresh
// the seam; the recovery Alert action button is the user opt-in
// path to /login.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}web`;

function readPage(relativePath: string): string {
  return readFileSync(`${repoRoot}/src/app/${relativePath}`, "utf8");
}

describe("BG1 magic-link callback pages (P0-001 producer/consumer alignment)", () => {
  test("/auth/callback configures the verifier with paramName='token'", () => {
    const source = readPage("auth/callback/page.tsx");
    assert.ok(
      /paramName="token"/.test(source),
      "auth/callback page MUST configure MagicLinkVerifier with paramName='token' (the producer-emitted credential parameter)",
    );
    assert.ok(
      !/paramName="request_id"/.test(source),
      "auth/callback MUST NOT read the public correlation id 'request_id' as a credential",
    );
  });

  test("/auth/verify configures the verifier with paramName='token'", () => {
    const source = readPage("auth/verify/page.tsx");
    assert.ok(
      /paramName="token"/.test(source),
      "auth/verify page MUST configure MagicLinkVerifier with paramName='token' (the producer-emitted credential parameter)",
    );
    assert.ok(
      !/paramName="request_id"/.test(source),
      "auth/verify MUST NOT read the public correlation id 'request_id' as a credential",
    );
  });

  test("the login page extracts the credential from ?token= in the dev verification URL", () => {
    // The login page is a thin production wrapper that delegates
    // to `LoginPageContent` for the credential extraction. The
    // source-pattern assertion pins the extraction at the
    // composable layer so a future refactor cannot silently swap
    // the `?token=` parameter for the public `?request_id`.
    const source = readPage("login/page-content.tsx");
    assert.ok(
      /searchParams\.get\("token"\)/.test(source),
      "login page-content MUST extract the credential from the dev verification URL's ?token= parameter",
    );
    assert.ok(
      !/searchParams\.get\("request_id"/.test(source),
      "login page-content MUST NOT read the public correlation id 'request_id' as the credential",
    );
  });

  test("the verifier component reads from useSearchParams and posts as verificationToken", () => {
    const source = readPage("components/MagicLinkVerifier.tsx");
    // Per P0-001 the verifier posts the captured credential
    // under the documented `verificationToken` field; the public
    // correlation id `requestId` is NEVER used as the credential.
    // The verifier routes through the shared `verifyAndRefresh`
    // helper from `SessionProvider` so the navigation's
    // `SessionStatus` re-renders on a successful verify.
    assert.ok(/verifyAndRefresh\(\s*\{\s*verificationToken/.test(source));
    assert.ok(/searchParams\.get\(paramName\)/.test(source));
    assert.ok(
      !/verifyToken\(\s*\{\s*requestId/.test(source),
      "MagicLinkVerifier MUST NOT submit a public requestId as the credential",
    );
  });

  // BG1 QA finding (stale navigation after verification): the
  // verifier must refresh the shared session seam, NOT call the
  // auth-client helper directly — a direct call leaves the
  // navigation's SessionStatus stale until a full page reload.
  test("the verifier calls the shared session seam (verifyAndRefresh) so the navigation reflects the new identity", () => {
    const source = readPage("components/MagicLinkVerifier.tsx");
    assert.ok(
      /useSession\(\)/.test(source),
      "MagicLinkVerifier MUST consume the shared session seam via useSession() so a successful verification refreshes the navigation",
    );
    assert.ok(
      /verifyAndRefresh\(/.test(source),
      "MagicLinkVerifier MUST call verifyAndRefresh from the seam, not verifyToken directly",
    );
  });

  // M2 (#82) visual-QA in-page recovery contract. The catch branch
  // now sets `verificationError` so the verifier renders an in-page
  // `<Alert role="alert">` recovery surface in-place. The catch
  // branch still MUST NOT redirect to /dashboard, set the user, or
  // refresh the seam — a failed verification cannot sign the user
  // in. The recovery Alert's action button is the user opt-in
  // path to /login.
  test("the verifier's failure branch renders an in-page recovery Alert and never lands on /dashboard or mutates session state", () => {
    const source = readPage("components/MagicLinkVerifier.tsx");
    const catchBranch = source.match(/catch\s*\{[\s\S]*?\}\s*\)/);
    assert.ok(catchBranch, "MagicLinkVerifier MUST have a catch branch for failed verification");
    assert.ok(
      /setVerificationError\(/.test(catchBranch[0]),
      "the catch branch MUST set verificationError so the in-page recovery Alert renders",
    );
    assert.ok(
      !/router\.replace\(\s*"\/dashboard"\s*\)/.test(catchBranch[0]),
      "the catch branch MUST NOT redirect to /dashboard — a failed verification cannot sign the user in",
    );
    assert.ok(
      !/setUser\(/.test(catchBranch[0]),
      "the catch branch MUST NOT mutate the session state directly",
    );
    assert.ok(
      !/refresh\(/.test(catchBranch[0]),
      "the catch branch MUST NOT call refresh — the authoritative session did not change",
    );

    // In-page recovery Alert renders the truthful neutral wording
    // ("This sign-in link can't be used.") and a "Request a new
    // sign-in link" action button (the action only navigates back
    // to the login form; the wording is truthful about that).
    // The verifier passes the testids to the Alert primitive which
    // emits them as data-testid attributes — the literal string
    // appears in both files. We assert on the literal identifier
    // so the contract is pinned at the call site regardless of
    // whether the Alert primitive ever renames its emission.
    assert.ok(
      /"magic-link-verifier-error"/.test(source),
      "the in-page recovery surface MUST carry the magic-link-verifier-error identifier (passed to the Alert primitive)",
    );
    assert.ok(
      /"magic-link-verifier-resend"/.test(source),
      "the in-page recovery surface MUST expose a Request-a-new-link action button with magic-link-verifier-resend identifier",
    );
    assert.ok(
      /label:\s*"Request a new sign-in link"/.test(source),
      "the recovery action label MUST be 'Request a new sign-in link' (truthful — the action only navigates back to /login)",
    );
    assert.ok(
      /This sign-in link can.{1,3}t be used\./.test(source),
      "the recovery heading MUST use the truthful neutral wording 'This sign-in link can't be used.' (does not claim the link 'expired')",
    );
    assert.ok(
      /role="alert"/.test(source),
      'the recovery surface MUST carry role="alert" (exactly one semantic alert region — no nested wrappers)',
    );

    // Deliberate focus behavior — the verifier moves focus to the
    // alert's heading on render. role="alert" alone does not
    // guarantee focus movement, so the useEffect + headingRef pair
    // is required.
    assert.ok(
      /errorHeadingRef/.test(source),
      "the verifier MUST use a headingRef to drive focus after the recovery Alert renders",
    );
    assert.ok(
      /errorHeadingRef\.current\.focus\(\)/.test(source) ||
        /errorHeadingRef\.current\?\.focus\(\)/.test(source),
      "the verifier MUST focus the error heading after the recovery Alert renders (deliberate focus behavior)",
    );

    // The action's onClick still routes the user to /login when
    // they opt in. The silent catch-branch redirect is gone.
    assert.ok(
      /onClick:\s*\(\)\s*=>\s*\{\s*router\.replace\("\/login"\)\s*;?\s*\}/.test(source) ||
        /onClick:\s*\(\)\s*=>\s*router\.replace\("\/login"\)/.test(source),
      "the recovery Alert action's onClick MUST route the user to /login when they opt in",
    );
  });

  // Loading vs recovery are mutually exclusive — the verifier
  // returns either the loading children (passed by the page) OR
  // the recovery Alert, never both after the catch branch runs.
  test("the verifier renders either loading children or the recovery Alert, never both", () => {
    const source = readPage("components/MagicLinkVerifier.tsx");
    // The recovery branch returns an Alert (no fragment wrapping
    // it) and the non-error branch returns <>{children}</>. A naive
    // regression that always renders children alongside the Alert
    // would fail this assertion.
    const recoveryReturnMatch = source.match(
      /if\s*\(verificationError\s*!==\s*null\)\s*\{[\s\S]*?return\s*\(\s*<Alert/,
    );
    assert.ok(
      recoveryReturnMatch,
      "the verifier MUST return the Alert directly (not wrapped in a fragment) when verificationError is set, so children (loading) do not also render",
    );
    assert.ok(
      /return\s*<>\s*\{children\}\s*<\/>/.test(source),
      "the verifier MUST return the loading children via a fragment when verificationError is null",
    );
  });
});
