// Intent service Personal-Workspace boundary (M2 #83 remediation
// §2). Inverse-authorization tests proving that valid Organization
// Owner membership does NOT permit intent provisioning.
//
// Coverage:
//   - Owning an Organization with zero capabilities → Hire throws
//     `INTENT_FORBIDDEN`. No rows created.
//   - Owning an Organization → Offer boundary check fires. No
//     Seller row written.
//   - Same Workspace after switching back to Personal (positive
//     control) → Hire succeeds, Buyer provisioned.

import assert from "node:assert/strict";

/* eslint-disable @typescript-eslint/no-floating-promises */
import { describe, test } from "node:test";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { IntentService, IntentServiceError } from "./intent.service.js";
import { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";

const USER_ID = "user-personal-boundary";
const WS_PERSONAL = "ws-personal-personal-boundary";
const WS_ORG = "ws-org-personal-boundary";

function buildService() {
  const authRepo = new InMemoryAuthRepository([
    {
      userAccountId: USER_ID,
      email: "boundary@example.test",
      identityProvider: "deterministic",
      identitySubject: "boundary",
      memberships: [
        {
          workspaceId: WS_PERSONAL,
          slug: "boundary-personal",
          name: "Boundary Personal",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: [],
        },
        {
          workspaceId: WS_ORG,
          slug: "boundary-org",
          name: "Boundary Org",
          workspaceType: "Organization",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: [],
        },
      ],
    },
  ]);
  const workspaceAuthorizationService = new WorkspaceAuthorizationService({
    authRepository: authRepo,
  });
  const service = new IntentService({ authRepository: authRepo, workspaceAuthorizationService });
  return { authRepo, service };
}

describe("IntentService Personal-Workspace boundary (inverse authorization)", () => {
  test("Hire against an Organization Workspace throws INTENT_FORBIDDEN; zero mutation", async () => {
    const { service, authRepo } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ORG,
          setupState: "converged",
          intent: { intent: "Hire" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_FORBIDDEN");
        return true;
      },
    );
    const view = await authRepo.getPublicUser(USER_ID);
    const orgMembership = view!.workspaces.find((w) => w.workspaceId === WS_ORG);
    assert.deepEqual(orgMembership?.capabilities, []);
    const personalMembership = view!.workspaces.find((w) => w.workspaceId === WS_PERSONAL);
    assert.deepEqual(personalMembership?.capabilities, []);
  });

  test("Offer against an Organization Workspace throws INTENT_FORBIDDEN; zero mutation", async () => {
    const { service, authRepo } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ORG,
          setupState: "converged",
          intent: { intent: "Offer" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_FORBIDDEN");
        return true;
      },
    );
    const view = await authRepo.getPublicUser(USER_ID);
    const orgMembership = view!.workspaces.find((w) => w.workspaceId === WS_ORG);
    assert.deepEqual(orgMembership?.capabilities, []);
  });

  test("Both against an Organization Workspace throws INTENT_FORBIDDEN; zero mutation", async () => {
    const { service, authRepo } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ORG,
          setupState: "converged",
          intent: { intent: "Both" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_FORBIDDEN");
        return true;
      },
    );
    const view = await authRepo.getPublicUser(USER_ID);
    const orgMembership = view!.workspaces.find((w) => w.workspaceId === WS_ORG);
    assert.deepEqual(orgMembership?.capabilities, []);
  });

  test("Same user, Personal Workspace, Hire succeeds (positive control)", async () => {
    const { service, authRepo } = buildService();
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_PERSONAL,
      setupState: "converged",
      intent: { intent: "Hire" },
    });
    assert.deepEqual(
      result.user.workspaces.find((w) => w.workspaceId === WS_PERSONAL)?.capabilities,
      ["Buyer"],
    );
    const view = await authRepo.getPublicUser(USER_ID);
    assert.deepEqual(view!.workspaces.find((w) => w.workspaceId === WS_ORG)?.capabilities, []);
  });
});
