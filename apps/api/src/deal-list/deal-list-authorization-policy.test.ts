/* eslint-disable @typescript-eslint/no-floating-promises */
// Deal-list read authorization policy tests (ticket #74).
//
// Background: the list is a private, Workspace-scoped read. The pure
// evaluator here is the single decision point; the Prisma and
// in-memory adapters both defer to it. These tests pin the policy
// independently of any persistence.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateDealListReadAuthority,
  type DealListReadAuthoritySnapshot,
} from "./deal-list-authorization-policy.js";

const WORKSPACE_ID = "ws-buyer";

function snapshot(
  overrides: Partial<DealListReadAuthoritySnapshot> = {},
): DealListReadAuthoritySnapshot {
  return {
    actingWorkspaceId: WORKSPACE_ID,
    actingWorkspaceStatus: "Active",
    actingUserIsMember: true,
    ...overrides,
  };
}

test("authorizes a current member of an Active Workspace", () => {
  const verdict = evaluateDealListReadAuthority(snapshot());
  assert.deepEqual(verdict, { ok: true });
});

test("rejects when the acting Workspace does not exist", () => {
  const verdict = evaluateDealListReadAuthority(
    snapshot({ actingWorkspaceStatus: null, actingUserIsMember: false }),
  );
  assert.deepEqual(verdict, { ok: false, reason: "DEAL_LIST_FORBIDDEN" });
});

test("rejects a revoked member — membership row absence is the fail-closed signal", () => {
  // WorkspaceMembership has no revokedAt column; revocation deletes
  // the row, so actingUserIsMember: false IS the revoked case.
  const verdict = evaluateDealListReadAuthority(snapshot({ actingUserIsMember: false }));
  assert.deepEqual(verdict, { ok: false, reason: "DEAL_LIST_FORBIDDEN" });
});

test("rejects a Suspended Workspace even for a current member", () => {
  const verdict = evaluateDealListReadAuthority(snapshot({ actingWorkspaceStatus: "Suspended" }));
  assert.deepEqual(verdict, { ok: false, reason: "DEAL_LIST_FORBIDDEN" });
});

test("every rejection uses the same opaque reason", () => {
  // The response must not let a caller distinguish "no such Workspace"
  // from "you are not a member of it".
  const rejections = [
    snapshot({ actingWorkspaceStatus: null, actingUserIsMember: false }),
    snapshot({ actingUserIsMember: false }),
    snapshot({ actingWorkspaceStatus: "Suspended" }),
    snapshot({ actingWorkspaceStatus: "Suspended", actingUserIsMember: false }),
  ].map((input) => evaluateDealListReadAuthority(input));

  for (const verdict of rejections) {
    assert.equal(verdict.ok, false);
    assert.equal(
      verdict.ok === false ? verdict.reason : null,
      "DEAL_LIST_FORBIDDEN",
      "all rejections must be indistinguishable",
    );
  }
});

test("the authorization snapshot carries no owner-identity field", () => {
  // ADR-0001 / ADR-0004: humans act through audited memberships;
  // Workspace ownership is never an authorization signal. Guard the
  // snapshot shape so a future edit cannot smuggle ownerUserId in.
  const keys = Object.keys(snapshot());
  assert.deepEqual(keys.sort(), [
    "actingUserIsMember",
    "actingWorkspaceId",
    "actingWorkspaceStatus",
  ]);
});
