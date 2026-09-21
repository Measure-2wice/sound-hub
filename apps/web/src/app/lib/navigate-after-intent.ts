// Post-intent navigation seam (M2 #83 remediation §5).
//
// Background: after a successful `POST /api/workspaces/:workspaceId/intent`
// response, the browser must navigate to the next surface. The
// SERVER has already resolved the destination: the route applies
// the bounded post-command return-destination resolver
// (`apps/api/src/lib/post-command-return-destination.ts`) against
// the fresh post-provision user payload. This seam is the SINGLE
// place that decides where the browser goes after intent — there
// is no reuse of `navigateAfterVerify` here.
//
// Rules:
//
//   1. Read ONLY `intentResponse.safeReturnTo`. Never inspect
//      `response.user`, never read raw query parameters, never
//      pattern-match routes. The server is the only reader of
//      `returnTo`-shaped inputs.
//   2. If `safeReturnTo` is a non-null string, navigate to it.
//   3. Otherwise navigate to `/dashboard`.
//
// `safeReturnTo` represents contextual authorization — the
// destination is reachable from the fresh post-provision user
// (Workspace + capability + route shape). It is NOT a client-side
// security validator; the server is the authority.

import type { IntentResponseV1 } from "@soundhub/types";

export type IntentNavigateMethod = "push" | "replace";

export interface NavigateAfterIntentInput {
  readonly router: {
    push(href: string): void;
    replace(href: string): void;
  };
  /**
   * The successful intent response. The helper reads only
   * `response.safeReturnTo`; nothing else.
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
 *   - `response.safeReturnTo != null` → `response.safeReturnTo`.
 *   - else → `/dashboard`.
 *
 * The helper does NOT call `window.location`, does NOT inspect
 * `response.user`, does NOT match routes. The browser is the dumb
 * consumer of the server-resolved destination.
 */
export function navigateAfterIntent(input: NavigateAfterIntentInput): void {
  const method = input.method ?? "push";
  const destination = input.response.safeReturnTo ?? "/dashboard";
  if (method === "replace") {
    input.router.replace(destination);
  } else {
    input.router.push(destination);
  }
}
