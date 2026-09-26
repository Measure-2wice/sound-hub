// Post-publish / post-update navigation seam (M2 #84).
//
// Background: after a successful `POST /api/workspaces/:workspaceId/seller-profile/publish`
// (or `PUT .../seller-profile`) the browser must navigate to the
// next surface. The SERVER has already resolved the destination via
// `resolvePostCommandReturnDestination` at
// `apps/api/src/lib/post-command-return-destination.ts`. This helper
// is the single browser-side consumer of the resolved destination.
//
// Rules:
//   1. Read ONLY `response.safeReturnTo`. Never inspect
//      `response.user`, never read raw query parameters, never
//      pattern-match routes.
//   2. If `safeReturnTo` is a non-null string, navigate to it.
//   3. Otherwise navigate to `/dashboard`.
//
// This mirrors `navigateAfterIntent` at
// `apps/web/src/app/lib/navigate-after-intent.ts` but applies to
// the publication/update outcome rather than the intent-selection
// outcome. The two surfaces intentionally share the same server-
// resolved destination shape so the browser doesn't need to
// reason about server policy.

import type { SellerProfilePublicationResponseV1 } from "@soundhub/types";

export type PublishNavigateMethod = "push" | "replace";

export interface NavigateAfterPublishInput {
  readonly router: {
    push(href: string): void;
    replace(href: string): void;
  };
  readonly response: SellerProfilePublicationResponseV1;
  readonly method?: PublishNavigateMethod;
}

export function navigateAfterPublish(input: NavigateAfterPublishInput): void {
  const method = input.method ?? "push";
  const destination = input.response.safeReturnTo ?? "/dashboard";
  if (method === "replace") {
    input.router.replace(destination);
  } else {
    input.router.push(destination);
  }
}
