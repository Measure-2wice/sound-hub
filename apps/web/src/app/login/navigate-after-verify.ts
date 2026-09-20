// Shared navigation contract for verified magic-link sign-ins.
//
// Background: BG1 has two browser entry points that converge on the
// same authenticated landing rules:
//
//   1. The managed (Supabase) callback URL and the deterministic
//      dev-verification URL flow through `MagicLinkVerifier` (the
//      callback page).
//   2. The login page's deterministic "Continue with dev
//      verification URL" button calls the same shared session seam.
//
// Both paths must land at exactly one of:
//
//   - `/dashboard?recovery=1` when the convergence service
//     classifies the user as `setupState === "recovery"` (multiple
//     Owner Personal Workspaces, NULL pointer, etc.) — the
//     dashboard renders the recovery surface from that flag.
//   - The validated internal return destination
//     (`response.returnTo`) when present and the setup is
//     "converged". `returnTo` is silently null when no cookie was
//     set, when the cookie was invalid, or when recovery overrode
//     the cookie — the browser never falls through to a return
//     destination behind a recovery-bound sign-in.
//   - `/dashboard` (the canonical landing) otherwise.
//
// The two paths previously diverged on the recovery-vs-returnTo
// precedence (the dev-verification handler pushed `/dashboard`
// regardless of `response.user.setupState`), which the Tenki
// review flagged as Medium. This helper pins the precedence at one
// call site so neither path can drift.
//
// Method semantics: the callback path uses `router.replace` (the
// verification surface must not stay in history — pressing back
// should not return to a one-shot URL). The login page's
// dev-verification button uses `router.push` (the button is a
// deliberate user action, so the user expects the back button to
// return to the sign-in surface). Both call sites converge on the
// same destination rule here; the caller picks `push` vs `replace`.

import type { Bg1VerifyTokenResponseV1 } from "@soundhub/types";

export type NavigateAfterVerifyMethod = "push" | "replace";

export interface NavigateAfterVerifyInput {
  /**
   * The Next App Router instance. The helper calls exactly one
   * `push(...)` or `replace(...)` on this router — never both, so a
   * regression that re-introduces an unconditional second
   * navigation (the original Tenki Medium bug) is observable at
   * the call site.
   */
  readonly router: {
    push(href: string): void;
    replace(href: string): void;
  };
  /**
   * The response returned by `verifyAndRefresh`. The helper reads
   * `response.user.setupState` (recovery override) and
   * `response.returnTo` (validated destination) — never anything
   * else.
   */
  readonly response: Bg1VerifyTokenResponseV1;
  /**
   * The history method to use. The callback verifier passes
   * `"replace"` (the verification surface must not stay in
   * history); the login-page dev-verification button passes
   * `"push"` (the user explicitly clicked a button, so the back
   * button should return to the sign-in surface). Defaults to
   * `"push"` so callers that don't pass an explicit method behave
   * like the user-driven entry point.
   */
  readonly method?: NavigateAfterVerifyMethod;
}

/**
 * Apply the converged navigation contract. Performs exactly one
 * `router[method]` call:
 *
 *   - `response.user.setupState === "recovery"` → `/dashboard?recovery=1`
 *     (recovery always wins; a pending `returnTo` is silently
 *     dropped so a retry does not land back at an inaccessible
 *     destination).
 *   - else `response.returnTo != null` → `response.returnTo`.
 *   - else → `/dashboard`.
 *
 * `response.returnTo` is typed as `string | null`; the truthy
 * check filters the `null` case so the destination is always a
 * concrete string before reaching the router.
 */
export function navigateAfterVerify(input: NavigateAfterVerifyInput): void {
  const method = input.method ?? "push";
  let destination: string;
  if (input.response.user.setupState === "recovery") {
    destination = "/dashboard?recovery=1";
  } else if (input.response.returnTo) {
    destination = input.response.returnTo;
  } else {
    destination = "/dashboard";
  }
  if (method === "replace") {
    input.router.replace(destination);
  } else {
    input.router.push(destination);
  }
}
