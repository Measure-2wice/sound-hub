// Post-intent navigation seam (M2 #83).
//
// Background: after a successful `POST /api/workspaces/:workspaceId/intent`
// response, the browser must navigate to the next surface. The
// server already validated the optional `returnTo`; the response
// echoes only the validated value. This seam is the SINGLE place
// that decides where the browser goes after intent — there is no
// reuse of `navigateAfterVerify` here.
//
// Rules:
//
//   1. Read ONLY `intentResponse.returnTo`. Never read raw query
//      parameters (`window.location.search`, `URLSearchParams`).
//      The server is the only authority for return destinations;
//      any raw-query trust would re-introduce authority from
//      attacker-controlled bytes.
//   2. If `returnTo` is a non-null string, navigate to it.
//   3. Otherwise navigate to `/dashboard`.
//
// The seam does NOT carry `setupState`. Recovery is rendered by the
// dashboard from the user payload's existing `setupState` field;
// intent is capability-only and cannot produce `setupState`.

import type { IntentResponseV1 } from "@soundhub/types";

export type IntentNavigateMethod = "push" | "replace";

export interface NavigateAfterIntentInput {
  readonly router: {
    push(href: string): void;
    replace(href: string): void;
  };
  /**
   * The successful intent response. The helper reads only
   * `response.returnTo`; nothing else.
   */
  readonly response: IntentResponseV1;
  /**
   * The history method to use. Defaults to `"push"` so the
   * back button returns to the previous surface (the user
   * explicitly chose to submit intent).
   */
  readonly method?: IntentNavigateMethod;
}

/**
 * Apply the post-intent navigation contract. Performs exactly one
 * `router[method]` call:
 *
 *   - `response.returnTo != null` → `response.returnTo`.
 *   - else → `/dashboard`.
 */
export function navigateAfterIntent(input: NavigateAfterIntentInput): void {
  const method = input.method ?? "push";
  const destination = input.response.returnTo ?? "/dashboard";
  if (method === "replace") {
    input.router.replace(destination);
  } else {
    input.router.push(destination);
  }
}
