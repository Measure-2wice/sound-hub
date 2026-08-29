/* eslint-disable @typescript-eslint/no-floating-promises */
// Shared session seam regression coverage (BG1 QA finding).
//
// Background: BG1 local QA observed that the navigation's
// `SessionStatus` kept showing "Sign in" after a successful
// magic-link verification until the user performed a full page
// reload. The root cause was that each auth-aware client component
// (the navigation, the dashboard, the magic-link verifier, the
// login page's dev verification handler) fetched `/api/auth/me`
// independently on mount and never re-fetched after auth actions,
// so client-side route changes could not reconcile them.
//
// The fix introduces a single `SessionProvider` seam that owns the
// authoritative user and exposes helpers (`verifyAndRefresh`,
// `signOutAndRefresh`) so every auth action triggers exactly one
// refresh and every consumer stays in lock-step. These tests pin
// that contract at the source level so a regression that reverts
// to ad-hoc per-component fetching fails the suite immediately.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}web`;

function readFile(relativePath: string): string {
  return readFileSync(`${repoRoot}/src/app/${relativePath}`, "utf8");
}

describe("BG1 shared session seam (verification → navigation synchronization)", () => {
  test("layout wraps the body in <SessionProvider> so every auth-aware client component reads the same seam", () => {
    const source = readFile("layout.tsx");
    assert.ok(
      /<SessionProvider>[\s\S]*<\/SessionProvider>/.test(source),
      "root layout MUST render <SessionProvider> around the navigation and main content so the session seam is shared",
    );
  });

  test("SessionProvider exports a hook with verifyAndRefresh and signOutAndRefresh helpers", () => {
    const source = readFile("components/SessionProvider.tsx");
    assert.ok(
      /export function useSession\(/.test(source),
      "SessionProvider MUST export a useSession hook so consumers have one seam to read from",
    );
    assert.ok(
      /verifyAndRefresh:\s*async\s*\(/.test(source) || /verifyAndRefresh[^,}]*\(/.test(source),
      "the hook value MUST expose verifyAndRefresh so verification can refresh the session in one place",
    );
    assert.ok(
      /signOutAndRefresh:\s*async\s*\(/.test(source) || /signOutAndRefresh[^,}]*\(/.test(source),
      "the hook value MUST expose signOutAndRefresh so sign-out can clear every consumer in one place",
    );
    // Failure path: a failed verify must NOT mutate `user`. The
    // helper must run `verifyToken` first and only refresh on
    // success — touching the state on failure would let a rejected
    // token read as "signed in" in the navigation. We extract the
    // helper body by anchoring on the useCallback declaration and
    // its `[refresh]` dependency close.
    const verifyBodyMatch = source.match(
      /verifyAndRefresh\s*=\s*useCallback\(\s*async\s*\([\s\S]*?\},\s*\[refresh\]\s*,?\s*\)/,
    );
    assert.ok(verifyBodyMatch, "the verifyAndRefresh helper must be defined in SessionProvider");
    assert.ok(
      /verifyToken\(\s*input\s*\)/.test(verifyBodyMatch[0]),
      "verifyAndRefresh MUST run verifyToken first so the helper only refreshes on a 2xx response",
    );
    assert.ok(
      /await\s+refresh\(\)/.test(verifyBodyMatch[0]),
      "verifyAndRefresh MUST await refresh() after the verify resolves so the navigation reflects the new session",
    );
  });
});

describe("BG1 magic-link verifier → navigation synchronization", () => {
  test("MagicLinkVerifier calls the shared verifyAndRefresh helper, NOT verifyToken directly", () => {
    const source = readFile("components/MagicLinkVerifier.tsx");
    assert.ok(
      /useSession\(\)/.test(source),
      "MagicLinkVerifier MUST consume the shared session seam via useSession() so verification refreshes the navigation",
    );
    assert.ok(
      /verifyAndRefresh\(/.test(source),
      "MagicLinkVerifier MUST call verifyAndRefresh from the seam so a successful verification re-pulls the authoritative user",
    );
    assert.ok(
      !/import\s*\{[^}]*verifyToken[^}]*\}\s*from\s*"\.\.\/lib\/auth-client"/.test(source),
      "MagicLinkVerifier MUST NOT import verifyToken directly — that path bypasses the seam and leaves the navigation stale",
    );
  });

  test("login page's dev verification handler calls the shared verifyAndRefresh helper, NOT verifyToken directly", () => {
    const source = readFile("login/page.tsx");
    assert.ok(
      /useSession\(\)/.test(source),
      "the login page MUST consume the shared session seam so the dev verification path refreshes the navigation",
    );
    assert.ok(
      /verifyAndRefresh\(/.test(source),
      "the login page's dev verification handler MUST call verifyAndRefresh from the seam",
    );
    assert.ok(
      !/await\s+verifyToken\(/.test(source),
      "the login page MUST NOT call verifyToken directly — that path bypasses the seam and leaves the navigation stale",
    );
  });
});

describe("BG1 sign-out → navigation synchronization", () => {
  test("SessionStatus signs out through the shared seam, NOT a full page reload", () => {
    const source = readFile("components/SessionStatus.tsx");
    assert.ok(
      /useSession\(\)/.test(source),
      "SessionStatus MUST consume the shared session seam so sign-out clears every consumer consistently",
    );
    assert.ok(
      /signOutAndRefresh\(/.test(source),
      "SessionStatus MUST call signOutAndRefresh from the seam so sign-out does not require a full page reload",
    );
    assert.ok(
      !/window\.location\.reload\(/.test(source),
      "SessionStatus MUST NOT use window.location.reload() — the seam handles the refresh and a reload would be redundant",
    );
  });

  test("dashboard signs out through the shared seam, NOT a full page navigation", () => {
    const source = readFile("dashboard/page.tsx");
    assert.ok(
      /useSession\(\)/.test(source),
      "the dashboard MUST consume the shared session seam so sign-out clears the navigation consistently",
    );
    assert.ok(
      /signOutAndRefresh\(/.test(source),
      "the dashboard's sign-out handler MUST call signOutAndRefresh from the seam",
    );
    assert.ok(
      !/window\.location\.href\s*=/.test(source),
      "the dashboard MUST NOT use window.location.href = '/' for sign-out — the seam handles the refresh and a full nav is redundant",
    );
  });
});

describe("BG1 failed verification cannot mark the user signed in", () => {
  test("MagicLinkVerifier never refreshes or navigates to /dashboard on a failed verify", () => {
    const source = readFile("components/MagicLinkVerifier.tsx");
    // The catch branch redirects to /login (never /dashboard) and
    // never calls refresh / setUser — so a rejected token cannot
    // leave the navigation reading "signed in".
    const catchBranch = source.match(/catch\s*\{[\s\S]*?\}\s*\)/);
    assert.ok(catchBranch, "MagicLinkVerifier MUST have a catch branch for failed verification");
    assert.ok(
      /router\.replace\(\s*"\/login"\s*\)/.test(catchBranch[0]),
      "the catch branch MUST redirect to /login so a failed verification never lands on the dashboard",
    );
    assert.ok(
      !/router\.replace\(\s*"\/dashboard"\s*\)/.test(catchBranch[0]),
      "the catch branch MUST NOT redirect to /dashboard — a failed verification cannot sign the user in",
    );
    assert.ok(
      !/setUser\(/.test(catchBranch[0]),
      "the catch branch MUST NOT mutate the session state — failed verifications leave the seam as it found it",
    );
    assert.ok(
      !/refresh\(/.test(catchBranch[0]),
      "the catch branch MUST NOT call refresh — the authoritative session did not change",
    );
  });

  test("SessionProvider.verifyAndRefresh only refreshes after verifyToken resolves", () => {
    const source = readFile("components/SessionProvider.tsx");
    // The helper's body must run verifyToken first and only then
    // refresh — that ordering is what keeps a failed verify from
    // marking the user signed in. We extract the verifyAndRefresh
    // callback body by anchoring on its declaration and the closing
    // `}, [refresh]` of its useCallback.
    const helperBody = source.match(
      /verifyAndRefresh\s*=\s*useCallback\(\s*async\s*\([\s\S]*?\},\s*\[refresh\]\s*,?\s*\)/,
    );
    assert.ok(
      helperBody,
      "verifyAndRefresh must be a useCallback with [refresh] dependency in SessionProvider",
    );
    const verifyThenRefresh = /await\s+verifyToken\(\s*input\s*\)\s*;\s*await\s+refresh\(\)/.test(
      helperBody[0],
    );
    assert.ok(
      verifyThenRefresh,
      "verifyAndRefresh MUST await verifyToken THEN await refresh — the order is what keeps failed verifications from marking the user signed in",
    );
  });
});
