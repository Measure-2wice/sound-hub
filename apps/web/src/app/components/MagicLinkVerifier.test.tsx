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
    assert.ok(/verifyToken\(\s*\{\s*verificationToken/.test(source));
    assert.ok(/searchParams\.get\(paramName\)/.test(source));
    assert.ok(
      !/verifyToken\(\s*\{\s*requestId/.test(source),
      "MagicLinkVerifier MUST NOT submit a public requestId as the credential",
    );
  });
});
