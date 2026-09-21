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
//   5. Capability-gated revalidation: `/deals` requires Buyer;
//      `/seller-requests` and `/dashboard/audio` require Seller.
//      `/talent` is open.
//   6. Replay protection: `/api/*` and unknown destinations cannot
//      replay protected actions; the bounded set covers every
//      legitimate #83 destination, so anything else is invalid.
//   7. Fallback: any failure drops to `/dashboard`.

import type { Bg1PublicUserV1, MarketplaceCapabilityV1 } from "@soundhub/types";
import { isValidReturnPath } from "./return-context.js";

/**
 * The bounded #83 return-destination set. The resolver is
 * deliberately closed: the #83 slice ships a small, named list of
 * internal routes, and unknown routes fall back to `/dashboard`.
 * No pattern matching, no heuristics.
 */
export type PostCommandRouteV1 =
  | "/dashboard"
  | "/workspace/intent"
  | "/workspace/switch"
  | "/talent"
  | "/deals"
  | "/seller-requests"
  | "/dashboard/audio";

export const POST_COMMAND_ROUTES_V1: ReadonlySet<PostCommandRouteV1> = new Set([
  "/dashboard",
  "/workspace/intent",
  "/workspace/switch",
  "/talent",
  "/deals",
  "/seller-requests",
  "/dashboard/audio",
]);

/**
 * Routes that require a specific capability on the FRESH acting
 * Workspace. The route lookup is bounded — only routes in
 * `POST_COMMAND_ROUTES_V1` are recognized.
 */
const CAPABILITY_GATES: ReadonlyMap<PostCommandRouteV1, MarketplaceCapabilityV1> = new Map([
  ["/deals", "Buyer"],
  ["/seller-requests", "Seller"],
  ["/dashboard/audio", "Seller"],
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
  if (mentionsWorkspaceId(input.returnTo, input.freshUser) === "stale") {
    throw new SafeReturnToFallback(
      "returnTo names a workspaceId that is not a current member of the fresh user.",
      "stale-workspace",
    );
  }

  // Step 5: capability-gated revalidation.
  const required = CAPABILITY_GATES.get(route);
  if (required !== undefined) {
    const actor = resolveActorWorkspace(input.freshUser, input.actingWorkspaceId);
    if (!actor) {
      throw new SafeReturnToFallback(
        "Acting Workspace not present on the fresh user; cannot satisfy capability gate.",
        "missing-capability",
      );
    }
    if (!actor.capabilities.includes(required)) {
      throw new SafeReturnToFallback(
        `Acting Workspace lacks required capability (${required}) for ${route}.`,
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

function mentionsWorkspaceId(
  rawPath: string,
  freshUser: Bg1PublicUserV1,
): "ok" | "stale" | "absent" {
  // The bounded set does not include any route that takes a
  // workspaceId. If the URL carries `workspace=` or `workspaceId=`
  // AND the value is not in the fresh user, drop.
  const match = rawPath.match(/[?&](workspaceId|workspace)=([^&]+)/);
  if (!match) return "absent";
  const value = decodeWorkspaceIdParam(match[2] ?? "");
  if (!value) return "absent";
  const accessible = freshUser.workspaces.some((w) => w.workspaceId === value);
  return accessible ? "ok" : "stale";
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
