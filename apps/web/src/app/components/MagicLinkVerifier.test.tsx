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
    const source = readPage("login/page.tsx");
    assert.ok(
      /searchParams\.get\("token"\)/.test(source),
      "login page MUST extract the credential from the dev verification URL's ?token= parameter",
    );
    assert.ok(
      !/searchParams\.get\("request_id"\)/.test(source),
      "login page MUST NOT read the public correlation id 'request_id' as the credential",
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

  // The catch branch is what stops a failed verification from
  // marking the user signed in: it redirects to /login, never to
  // /dashboard, and never touches the session state. The verifier
  // already routes through the shared seam so a successful run
  // refreshes the navigation; this pin guards the failure path.
  test("the verifier's failure branch never lands on /dashboard or mutates session state", () => {
    const source = readPage("components/MagicLinkVerifier.tsx");
    const catchBranch = source.match(/catch\s*\{[\s\S]*?\}\s*\)/);
    assert.ok(catchBranch, "MagicLinkVerifier MUST have a catch branch for failed verification");
    assert.ok(
      /router\.replace\(\s*"\/login"\s*\)/.test(catchBranch[0]),
      "the catch branch MUST redirect to /login",
    );
    assert.ok(
      !/router\.replace\(\s*"\/dashboard"\s*\)/.test(catchBranch[0]),
      "the catch branch MUST NOT redirect to /dashboard — a failed verification cannot sign the user in",
    );
    assert.ok(
      !/setUser\(/.test(catchBranch[0]),
      "the catch branch MUST NOT mutate the session state directly",
    );
  });
});
