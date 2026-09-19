// Personal Workspace recovery command semantics (M2 #82).
//
// Background: recovery means the authenticated human has identity
// but no Personal Workspace authority. Organization Workspace
// memberships remain usable on recovery (the existing
// `WorkspaceAuthorizationService` boundary is reused — current
// membership is the only authority source).
//
// These tests pin the two cases:
//   1. Recovery user acting on a Personal Workspace id fails with
//      NOT_A_MEMBER (no Personal Workspace or no Owner membership).
//   2. Recovery user with current Organization membership acting on
//      the Organization Workspace id succeeds (current membership
//      check passes).
//
// The test does NOT require the convergence service to be involved;
// the WorkspaceAuthorizationService is the existing GS 4 / GS 5 /
// GS 6 boundary. The recovery semantics are an emergent property of
// that boundary + the `setupState` field, not a new authorization
// rule.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";

const USER_ID = "user-recovery";
const PERSONAL_WORKSPACE_ID = "ws-personal-broken";
const ORG_WORKSPACE_ID = "ws-org";

function makeRepo(): InMemoryAuthRepository {
  // The user has an Organization membership (current, Owner) and
  // no Personal Workspace membership at all — the recovery case
  // described in the spec. The user IS authenticated; the
  // WorkspaceAuthorizationService must authorize the Organization
  // Workspace but reject the Personal Workspace.
  return new InMemoryAuthRepository([
    {
      userAccountId: USER_ID,
      email: "recovery@example.com",
      identityProvider: "deterministic",
      identitySubject: "recovery-subject",
      memberships: [
        {
          workspaceId: ORG_WORKSPACE_ID,
          slug: "acme",
          name: "Acme Org",
          workspaceType: "Organization",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Buyer"],
        },
      ],
    },
  ]);
}

describe("Recovery command semantics", () => {
  let repo: InMemoryAuthRepository;
  let service: WorkspaceAuthorizationService;

  beforeEach(() => {
    repo = makeRepo();
    service = new WorkspaceAuthorizationService({ authRepository: repo });
  });

  test("recovery user acting on an Organization Workspace id succeeds (current membership)", async () => {
    const membership = await service.requireActingMembership({
      userAccountId: USER_ID,
      workspaceId: ORG_WORKSPACE_ID,
    });
    assert.equal(membership.workspace.workspaceId, ORG_WORKSPACE_ID);
    assert.equal(membership.workspace.workspaceType, "Organization");
    assert.equal(membership.role, "Owner");
  });

  test("recovery user acting on an unknown Personal Workspace id fails with NOT_A_MEMBER", async () => {
    // The user has no Personal Workspace membership at all; the
    // Personal Workspace id is unknown to them. The existing GS 4
    // boundary returns NOT_A_MEMBER.
    await assert.rejects(
      () =>
        service.requireActingMembership({
          userAccountId: USER_ID,
          workspaceId: PERSONAL_WORKSPACE_ID,
        }),
      (err: unknown) => err instanceof Error && err.name === "AuthorizationError",
    );
  });

  test("recovery user requires the Buyer capability on the Organization Workspace to act as Buyer", async () => {
    // The user has Buyer capability on the Organization
    // Workspace. The capability check must succeed on recovery.
    const membership = await service.requireCapability({
      userAccountId: USER_ID,
      workspaceId: ORG_WORKSPACE_ID,
      requiredCapability: "Buyer",
    });
    assert.equal(membership.workspace.workspaceId, ORG_WORKSPACE_ID);
    assert.deepEqual(membership.capabilities, ["Buyer"]);
  });

  test("recovery user fails the Seller capability check on the Organization Workspace (current capability)", async () => {
    // The Organization Workspace has only Buyer capability; a
    // Seller-required command fails with MISSING_CAPABILITY on
    // recovery (or any state) — the boundary does not change.
    await assert.rejects(
      () =>
        service.requireCapability({
          userAccountId: USER_ID,
          workspaceId: ORG_WORKSPACE_ID,
          requiredCapability: "Seller",
        }),
      (err: unknown) => {
        if (!(err instanceof Error)) return false;
        return (
          err.name === "AuthorizationError" &&
          "code" in err &&
          (err as { code: string }).code === "MISSING_CAPABILITY"
        );
      },
    );
  });
});
