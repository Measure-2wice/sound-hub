// Server-side post-command return-destination resolver (M2 #83).
//
// Background: `safeReturnTo` represents CONTEXTUAL authorization,
// not just URL safety. After every M2 #83 consequential command
// (`POST /api/workspaces/:workspaceId/intent`,
// `POST /api/auth/acting-workspace`), the server resolves the
// destination against the FRESH post-command user payload. The
// browser consumes only the server-resolved value; the server is
// the only reader of `returnTo`-shaped inputs.
//
// Scope (bounded by design — M2 #83 review §5):
//
//   This resolver handles the explicit #83 return route set; it
//   does NOT build a general route-manifest authorization engine.
//   Destinations outside the bounded set fall back to `/dashboard`
//   rather than being pattern-matched or guessed.
//
// Algorithm (first failure drops to `/dashboard`):
//
//   1. Shape + same-origin: `isValidReturnPath(returnTo, allowedOrigin)`.
//   2. Reject action endpoints (`/api/*`).
//   3. Resolve against the bounded #83 route set.
//   4. Workspace-scoped revalidation: if `workspaceId` appears as
//      a path segment or query parameter, it must match a current,
//      Active member Workspace of the fresh user.
//   5. Capability-gated revalidation: the route lookup is bounded
//      to `POST_COMMAND_ROUTES_V1`. Routes are gated by a SET of
//      capabilities; the actor satisfies the gate when they hold
//      AT LEAST ONE listed capability. `/deals` is gated by Buyer
//      OR Seller (Deal parties are both Buyer and Seller sides;
//      the destination is reachable from either side). `/talent`
//      is open.
//   6. Replay protection: `/api/*` and unknown destinations cannot
//      replay protected actions; the bounded set covers every
//      legitimate #83 destination, so anything else is invalid.
//   7. Fallback: any failure drops to `/dashboard`.

import {
  type Bg1PublicUserV1,
  type MarketplaceCapabilityV1,
  type PostCommandRouteV1,
  postCommandRouteValuesV1,
} from "@soundhub/types";
import { isValidReturnPath } from "./return-context.js";

/**
 * Maximum `safeReturnTo` length honored by the response contract
 * (`bg1ActingWorkspaceResponseV1Schema.safeReturnTo` → `.max(256)`
 * in `packages/types/src/index.ts`). The composed cross-Workspace
 * switch path MUST stay at or below this cap or the schema parser
 * will throw `too_big` for the entire response body. The constant
 * names a single source of truth so the resolver, the schema, and
 * any focused tests can all reference the same number.
 */
const SAFE_RETURN_TO_MAX_LENGTH = 256;

/**
 * The bounded #83 return-destination set. The resolver is
 * deliberately closed: the #83 slice ships a small, named list of
 * internal routes, and unknown routes fall back to `/dashboard`.
 * No pattern matching, no heuristics.
 *
 * Re-exported here for downstream consumers (and tests) that want
 * the server-side name. The canonical list lives in
 * `@soundhub/types` so the typed client narrowing helper on the
 * Workspace-switch interstitial stays consistent with the server's
 * closed enum.
 */
export type { PostCommandRouteV1 };

export const POST_COMMAND_ROUTES_V1: ReadonlySet<PostCommandRouteV1> = new Set(
  postCommandRouteValuesV1,
);

/**
 * Routes that require the FRESH acting Workspace to hold AT
 * LEAST ONE of the listed capabilities. The route lookup is
 * bounded — only routes in `POST_COMMAND_ROUTES_V1` are
 * recognized. A route without a gate entry is open to any actor.
 *
 * `/deals` is gated by `Buyer OR Seller`: Deals are a party
 * destination for BOTH buyer and seller Workspaces, so a
 * Seller-only Workspace returning from Offer intent or a
 * Seller-Workspace switch must be able to resume the valid
 * `/deals` continuation under the fresh post-command actor.
 */
const CAPABILITY_GATES: ReadonlyMap<
  PostCommandRouteV1,
  ReadonlySet<MarketplaceCapabilityV1>
> = new Map([
  ["/deals", new Set<MarketplaceCapabilityV1>(["Buyer", "Seller"])],
  ["/seller-requests", new Set<MarketplaceCapabilityV1>(["Seller"])],
  ["/dashboard/audio", new Set<MarketplaceCapabilityV1>(["Seller"])],
  // M2 (#84): Professional Profile editor + publication review. The
  // SellerProfile slice is Personal-Workspace-only AND
  // Seller-capable. A Buyer-only Workspace returning from a non-#84
  // command cannot resume the editor under a stale Buyer actor.
  // Personal-only authorization is enforced at the route layer
  // (requirePersonalActingMembership); the capability gate here
  // closes the return-target path so a Buyer returning from intent
  // selection cannot use `returnTo: "/seller/profile/edit"` to bypass
  // the route-layer check.
  ["/seller/profile/edit", new Set<MarketplaceCapabilityV1>(["Seller"])],
  ["/seller/profile/review", new Set<MarketplaceCapabilityV1>(["Seller"])],
]);

export interface ResolveReturnInput {
  /**
   * The raw `returnTo` carried by the request body, or any string the
   * caller wants revalidated. `null` / `undefined` short-circuits to
   * `null` so the browser stays on its current surface.
   */
  readonly returnTo: string | null | undefined;
  /**
   * The fresh post-command user payload. The resolver reads
   * `user.workspaces[]` for Workspace-scoped revalidation and
   * `actingWorkspace` for capability revalidation when the path
   * resolves to a capability-gated route.
   */
  readonly freshUser: Bg1PublicUserV1;
  /**
   * The acting-Workspace id the command established (Personal
   * pointer or post-switch target). Used for capability revalidation
   * when the route is capability-gated. The resolver falls back to
   * `freshUser.workspaces[i].workspaceType === "Personal"` selection
   * when `actingWorkspaceId` is `null`.
   */
  readonly actingWorkspaceId: string | null;
  /**
   * The configured allowed origin, forwarded verbatim to
   * `isValidReturnPath`.
   */
  readonly allowedOrigin: string;
}

export interface ResolvedDestination {
  /**
   * The bounded #83 route the request resolved to. `null` when the
   * resolver could not validate the input (caller falls back to
   * `/dashboard`) OR when no `returnTo` was supplied (caller stays
   * on its current surface).
   */
  readonly route: PostCommandRouteV1;
  /**
   * The exact path the browser should navigate to. Equals `route`
   * for the bounded #83 set (no workspaceId segment is preserved;
   * the resolver strips such segments so a stale workspaceId can
   * never silently reach the browser).
   */
  readonly path: string;
}

/**
 * Resolve a post-command return destination against the fresh
 * user. Returns `null` when no `returnTo` was supplied. Returns a
 * `ResolvedDestination` whose `path` is the bounded #83 route the
 * caller can navigate to without further client-side reasoning.
 *
 * Failure mode (caller fallback): the resolver throws
 * `SafeReturnToFallback` to signal "the input was unsafe; the
 * caller MUST fall back to `/dashboard`". Throwing keeps the
 * resolver's contract explicit — the caller does not have to
 * reason about partial returns.
 */
export class SafeReturnToFallback extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "shape"
      | "action-endpoint"
      | "unknown-route"
      | "stale-workspace"
      | "missing-capability",
  ) {
    super(message);
    this.name = "SafeReturnToFallback";
  }
}

/**
 * Apply the bounded post-command destination resolver. Returns
 * `null` when no `returnTo` was supplied; the caller MUST treat
 * that as "stay on current surface" (never navigate). Throws
 * `SafeReturnToFallback` when the supplied value cannot be
 * authorized; the caller MUST fall back to `/dashboard` on catch.
 */
export function resolvePostCommandReturnDestination(
  input: ResolveReturnInput,
): ResolvedDestination | null {
  if (input.returnTo === null || input.returnTo === undefined) {
    return null;
  }
  if (typeof input.returnTo !== "string" || input.returnTo.length === 0) {
    return null;
  }
  // Step 1: same-origin path shape.
  if (!isValidReturnPath(input.returnTo, input.allowedOrigin)) {
    throw new SafeReturnToFallback("returnTo failed same-origin path validation.", "shape");
  }
  // Step 2: reject action endpoints.
  if (input.returnTo.startsWith("/api/")) {
    throw new SafeReturnToFallback(
      "returnTo points at an action endpoint; refusing.",
      "action-endpoint",
    );
  }
  // Step 3: resolve against the bounded #83 set. The resolver
  // preserves ONLY the bounded route — query parameters and path
  // segments beyond the recognized prefix are dropped so a stale
  // workspaceId cannot silently reach the browser.
  const pathOnly = stripQueryAndWorkspaceSegments(input.returnTo);
  if (!POST_COMMAND_ROUTES_V1.has(pathOnly as PostCommandRouteV1)) {
    throw new SafeReturnToFallback(
      `returnTo references a route outside the bounded #83 set (${pathOnly}); refusing.`,
      "unknown-route",
    );
  }
  const route = pathOnly as PostCommandRouteV1;

  // Step 4: Workspace-scoped revalidation. If the original (or
  // stripped) path carried a `workspaceId` that is not in the
  // fresh user's accessible Workspaces, drop.
  //
  // Codex CHANGES_REQUESTED P1-003 (cross-Workspace destination):
  // when returnTo names a `workspaceId` that IS a current member
  // of the fresh user but is NOT the post-command acting Workspace,
  // the destination must be reachable from the new actor — the
  // bounded resolver returns `/workspace/switch?target=<id>` so
  // the customer lands on a confirmation interstitial, NOT on a
  // resource owned by a Workspace they are no longer acting as.
  // This binds the navigation context to the command's resolved
  // Workspace; cross-Workspace destinations cannot replay or
  // leak.
  const workspaceIdParam = extractWorkspaceIdParam(input.returnTo);
  if (workspaceIdParam !== null) {
    const accessible = input.freshUser.workspaces.some((w) => w.workspaceId === workspaceIdParam);
    if (!accessible) {
      throw new SafeReturnToFallback(
        "returnTo names a workspaceId that is not a current member of the fresh user.",
        "stale-workspace",
      );
    }
    if (input.actingWorkspaceId !== null && input.actingWorkspaceId !== workspaceIdParam) {
      // Cross-Workspace: route through the switch interstitial.
      // The ORIGINAL `returnTo` is preserved (URL-encoded) as the
      // `return` query parameter of the switch URL — the
      // interstitial forwards it into the post-switch
      // acting-workspace commit, and the SERVER resolves the
      // continuation against the FRESH actor. The browser never
      // honors the raw `?return=` value directly; the server's
      // `safeReturnTo` from the post-switch commit is the only
      // path the browser navigates to. Cancel ignores `?return=`
      // entirely (see `workspace/switch/page.tsx`).
      //
      // The composed switch URL MUST stay inside the bounded
      // `safeReturnTo` response contract
      // (`bg1ActingWorkspaceResponseV1Schema.safeReturnTo` max
      // length 256). URL-encoding can expand an input — every
      // `/`, `?`, `&`, `=`, and non-ASCII byte becomes a `%xx`
      // triplet — so a 256-character input that expands to
      // ~800 encoded characters would crash the downstream
      // response parser with `too_big`. When the composed path
      // would exceed the cap, drop the preserved `?return=` and
      // emit the bounded `/workspace/switch?target=<id>` form;
      // the switch still routes through the explicit confirmation
      // interstitial, the customer can still commit, and the
      // POST-COMMIT resolver returns the documented safe
      // fallback (`/dashboard`) for the missing continuation.
      const composedPath = `/workspace/switch?target=${encodeURIComponent(workspaceIdParam)}&return=${encodeURIComponent(input.returnTo)}`;
      if (composedPath.length <= SAFE_RETURN_TO_MAX_LENGTH) {
        return {
          route: "/dashboard",
          path: composedPath,
        };
      }
      return {
        route: "/dashboard",
        path: `/workspace/switch?target=${encodeURIComponent(workspaceIdParam)}`,
      };
    }
  }

  // Step 5: capability-gated revalidation.
  const requiredCapabilities = CAPABILITY_GATES.get(route);
  if (requiredCapabilities !== undefined) {
    const actor = resolveActorWorkspace(input.freshUser, input.actingWorkspaceId);
    if (!actor) {
      throw new SafeReturnToFallback(
        "Acting Workspace not present on the fresh user; cannot satisfy capability gate.",
        "missing-capability",
      );
    }
    // The gate is satisfied when the actor holds AT LEAST ONE of the
    // listed capabilities. A Seller-only Workspace returning to
    // `/deals` and a Buyer-only Workspace returning to `/deals` both
    // pass — Deals are a Deal-party destination, not a
    // Buyer-exclusive one.
    const satisfied = actor.capabilities.some((cap) => requiredCapabilities.has(cap));
    if (!satisfied) {
      const requiredList = [...requiredCapabilities].join(" | ");
      throw new SafeReturnToFallback(
        `Acting Workspace lacks required capability (${requiredList}) for ${route}.`,
        "missing-capability",
      );
    }
  }

  return { route, path: route };
}

/**
 * Strip query parameters and any `workspaceId` / `workspace` path
 * segments so the bounded comparison stays simple. The bounded route
 * is the only path the browser receives; workspaceId-specific
 * destinations are out of scope for #83.
 *
 * Examples:
 *   "/talent?workspaceId=wsX"               -> "/talent"
 *   "/deals?workspace=wsX&q=foo"            -> "/deals"
 *   "/workspaces/wsX/deals"                 -> "/"  (not in set; falls back)
 */
function stripQueryAndWorkspaceSegments(rawPath: string): string {
  const queryIndex = rawPath.indexOf("?");
  const pathOnly = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
  if (!pathOnly.startsWith("/")) return "/";
  // Truncate at any second `/` that is not followed by a recognized
  // segment. The bounded set never contains a workspaceId segment.
  const segments = pathOnly.split("/");
  if (segments.length === 0) return "/";
  const prefix = segments[1] ?? "";
  const isPlain = segments.length === 2;
  if (!isPlain) {
    // Multiple segments. The only multi-segment route in the
    // bounded set is `/workspace/intent`, `/workspace/switch`, and
    // `/dashboard/audio`. None include a workspaceId segment, so
    // any 3+ segment path is out of scope.
    const firstTwo = `/${prefix}/${segments[2] ?? ""}`;
    if (
      firstTwo === "/workspace/intent" ||
      firstTwo === "/workspace/switch" ||
      firstTwo === "/dashboard/audio"
    ) {
      if (segments.length > 3) return "/"; // extra segments drop
      return firstTwo;
    }
    return "/";
  }
  return `/${prefix}`;
}

/**
 * Extract the `workspaceId` / `workspace` query parameter from a raw
 * path. Returns `null` when absent. Used by the post-command
 * destination resolver to detect cross-Workspace destinations
 * (P1-003): if returnTo names a workspaceId that is current but
 * different from the command actor, the resolver routes the
 * destination through `/workspace/switch?target=<id>`.
 */
function extractWorkspaceIdParam(rawPath: string): string | null {
  const match = rawPath.match(/[?&](?:workspaceId|workspace)=([^&]+)/);
  if (!match) return null;
  return decodeWorkspaceIdParam(match[1] ?? "");
}

function decodeWorkspaceIdParam(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function resolveActorWorkspace(
  freshUser: Bg1PublicUserV1,
  actingWorkspaceId: string | null,
): Bg1PublicUserV1["workspaces"][number] | null {
  if (actingWorkspaceId !== null) {
    const match = freshUser.workspaces.find((w) => w.workspaceId === actingWorkspaceId);
    if (match) return match;
  }
  // Fallback: surface the Personal Workspace if available; else the
  // first accessible Workspace.
  const personal = freshUser.workspaces.find((w) => w.workspaceType === "Personal");
  return personal ?? freshUser.workspaces[0] ?? null;
}
