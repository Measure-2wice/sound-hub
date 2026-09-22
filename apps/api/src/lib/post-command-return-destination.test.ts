// M2 #83 remediation (§5): post-command return-destination
// resolver behaviour. The resolver is the SERVER-SIDE authority
// for `safeReturnTo`. The browser consumes only the resolved
// output and never re-derives authorization.
//
// Coverage:
//   - happy path / open route (`/talent`)
//   - capability-gated route + actor has capability
//   - capability-gated route + actor lacks capability → falls back
//   - Workspace-scoped query param + accessible → kept
//   - Workspace-scoped query param + stale → falls back
//   - action endpoint → falls back
//   - unknown internal route → falls back
//   - shape validation fail (e.g., `https://evil/x`) → falls back
//   - null returnTo → null

import assert from "node:assert/strict";
import { describe, test } from "node:test";

/* eslint-disable @typescript-eslint/no-floating-promises */
import type { Bg1PublicUserV1 } from "@soundhub/types";
import {
  SafeReturnToFallback,
  resolvePostCommandReturnDestination,
} from "./post-command-return-destination.js";

const ALLOWED_ORIGIN = "http://localhost:3000";

function buildUser(input: {
  readonly personal?: boolean;
  readonly org?: boolean;
  readonly buyer?: boolean;
  readonly seller?: boolean;
  readonly personalId?: string;
  readonly orgId?: string;
}): Bg1PublicUserV1 {
  const workspaces: Bg1PublicUserV1["workspaces"] = [];
  if (input.personal) {
    workspaces.push({
      workspaceId: input.personalId ?? "ws-personal",
      slug: "personal",
      name: "Personal",
      workspaceType: "Personal",
      workspaceStatus: "Active",
      capabilities: [
        ...(input.buyer ? ["Buyer" as const] : []),
        ...(input.seller ? ["Seller" as const] : []),
      ],
    });
  }
  if (input.org) {
    workspaces.push({
      workspaceId: input.orgId ?? "ws-org",
      slug: "org",
      name: "Org",
      workspaceType: "Organization",
      workspaceStatus: "Active",
      capabilities: [
        ...(input.buyer ? ["Buyer" as const] : []),
        ...(input.seller ? ["Seller" as const] : []),
      ],
    });
  }
  return {
    userAccountId: "user-1",
    email: "u@example.test",
    displayName: null,
    identityProvider: "deterministic",
    setupState: "converged",
    workspaces,
  };
}

describe("resolvePostCommandReturnDestination", () => {
  test("null returnTo short-circuits to null", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: null,
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.equal(result, null);
  });

  test("undefined returnTo short-circuits to null", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: undefined,
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.equal(result, null);
  });

  test("valid open route /dashboard is accepted", () => {
    const user = buildUser({ personal: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/dashboard",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/dashboard", path: "/dashboard" });
  });

  test("valid open route /talent is accepted (no capability required)", () => {
    const user = buildUser({ personal: true }); // no capabilities
    const result = resolvePostCommandReturnDestination({
      returnTo: "/talent",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/talent", path: "/talent" });
  });

  test("/deals + actor with Buyer capability is kept", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/deals",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/deals", path: "/deals" });
  });

  test("/deals + actor without Buyer capability falls back", () => {
    const user = buildUser({ personal: true }); // no Buyer
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "/deals",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "missing-capability",
    );
  });

  test("/seller-requests + actor with Seller capability is kept", () => {
    const user = buildUser({ personal: true, seller: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/seller-requests",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/seller-requests", path: "/seller-requests" });
  });

  test("/seller-requests + actor without Seller capability falls back", () => {
    const user = buildUser({ personal: true }); // no Seller
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "/seller-requests",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "missing-capability",
    );
  });

  test("/dashboard/audio + actor with Seller capability is kept", () => {
    const user = buildUser({ personal: true, seller: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/dashboard/audio",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/dashboard/audio", path: "/dashboard/audio" });
  });

  test("workspace-scoped query parameter + accessible workspace is kept", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/deals?workspace=ws-personal&q=foo",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/deals", path: "/deals" });
  });

  test("workspace-scoped query parameter + stale workspace falls back", () => {
    const user = buildUser({ personal: true, buyer: true });
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "/talent?workspace=ws-not-mine",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "stale-workspace",
    );
  });

  test("/api/* endpoint falls back", () => {
    const user = buildUser({ personal: true });
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "/api/auth/sign-out",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "action-endpoint",
    );
  });

  test("unknown internal route falls back", () => {
    const user = buildUser({ personal: true });
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "/admin",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "unknown-route",
    );
  });

  test("Cross-Workspace destination (returnTo names a different accessible workspaceId) routes through the switch interstitial (P1-003)", () => {
    const user = buildUser({ personal: true, buyer: true, personalId: "ws-personal" });
    user.workspaces.push({
      workspaceId: "ws-org-other",
      slug: "org-other",
      name: "Other Org",
      workspaceType: "Organization",
      workspaceStatus: "Active",
      capabilities: ["Buyer"],
      role: "Owner",
      joinedAt: "2025-01-01T00:00:00.000Z",
    } as never);
    const result = resolvePostCommandReturnDestination({
      returnTo: "/deals?workspaceId=ws-org-other",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    // The accessible-but-different workspaceId is routed through
    // the switch interstitial instead of leaking a
    // cross-Workspace destination.
    assert.deepEqual(result, {
      route: "/dashboard",
      path: "/workspace/switch?target=ws-org-other",
    });
  });

  test("Same-Workspace destination (returnTo names the acting workspaceId) is kept", () => {
    const user = buildUser({ personal: true, buyer: true });
    const result = resolvePostCommandReturnDestination({
      returnTo: "/deals?workspaceId=ws-personal",
      freshUser: user,
      actingWorkspaceId: "ws-personal",
      allowedOrigin: ALLOWED_ORIGIN,
    });
    assert.deepEqual(result, { route: "/deals", path: "/deals" });
  });

  test("malformed cross-origin path falls back (shape)", () => {
    const user = buildUser({ personal: true });
    assert.throws(
      () =>
        resolvePostCommandReturnDestination({
          returnTo: "https://evil.example/x",
          freshUser: user,
          actingWorkspaceId: "ws-personal",
          allowedOrigin: ALLOWED_ORIGIN,
        }),
      (err: unknown) => err instanceof SafeReturnToFallback && err.reason === "shape",
    );
  });
});
