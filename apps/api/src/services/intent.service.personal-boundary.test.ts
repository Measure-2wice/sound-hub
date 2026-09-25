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
import type { ConvergenceKind } from "../lib/personal-workspace-convergence-domain.js";

const USER_ID = "user-personal-boundary";
const WS_PERSONAL = "ws-personal-personal-boundary";
const WS_ORG = "ws-org-personal-boundary";

const CONVERGED: ConvergenceKind = {
  kind: "converged",
  workspaceId: WS_PERSONAL,
  membershipId: "m-personal-boundary",
};

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
          convergence: CONVERGED,
          intent: { intent: "Hire", expectedCapabilities: [] },
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
          convergence: CONVERGED,
          intent: { intent: "Offer", expectedCapabilities: [] },
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
          convergence: CONVERGED,
          intent: { intent: "Both", expectedCapabilities: [] },
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
      convergence: CONVERGED,
      intent: { intent: "Hire", expectedCapabilities: [] },
    });
    assert.deepEqual(
      result.user.workspaces.find((w) => w.workspaceId === WS_PERSONAL)?.capabilities,
      ["Buyer"],
    );
    const view = await authRepo.getPublicUser(USER_ID);
    assert.deepEqual(view!.workspaces.find((w) => w.workspaceId === WS_ORG)?.capabilities, []);
  });

  // Canonical Personal Workspace enforcement: a user that can
  // access a SECOND, non-canonical Personal Workspace (the
  // canonical pointer is the one named by the convergence
  // classification) MUST NOT be able to provision capabilities
  // against the non-canonical alternative. The service fails
  // closed with INTENT_FORBIDDEN and ZERO capability writes on
  // either Workspace.
  test("Canonical Personal Workspace enforcement: non-canonical accessible Personal Workspace throws INTENT_FORBIDDEN; zero mutation", async () => {
    const WS_PERSONAL_2 = "ws-personal-personal-boundary-2";
    const authRepo = new InMemoryAuthRepository([
      {
        userAccountId: USER_ID,
        email: "boundary-canonical@example.test",
        identityProvider: "deterministic",
        identitySubject: "boundary-canonical",
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
            workspaceId: WS_PERSONAL_2,
            slug: "boundary-personal-2",
            name: "Boundary Personal 2 (non-canonical)",
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

    // The canonical Personal Workspace is WS_PERSONAL. The user
    // intentionally targets the non-canonical WS_PERSONAL_2.
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_PERSONAL_2,
          convergence: {
            kind: "converged",
            workspaceId: WS_PERSONAL,
            membershipId: "m-personal-boundary-canonical",
          },
          intent: { intent: "Hire", expectedCapabilities: [] },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_FORBIDDEN");
        return true;
      },
    );

    const view = await authRepo.getPublicUser(USER_ID);
    const canonical = view!.workspaces.find((w) => w.workspaceId === WS_PERSONAL);
    const nonCanonical = view!.workspaces.find((w) => w.workspaceId === WS_PERSONAL_2);
    assert.deepEqual(canonical?.capabilities, [], "canonical Personal has no capabilities");
    assert.deepEqual(nonCanonical?.capabilities, [], "non-canonical Personal has no capabilities");
  });

  test("Recovery state with accessible Personal Workspace still throws INTENT_FORBIDDEN (canonical pointer rejected)", async () => {
    const { service, authRepo } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_PERSONAL,
          convergence: {
            kind: "recovery",
            userAccountId: USER_ID,
            reason: "contradictory-personal-relationships",
          },
          intent: { intent: "Both", expectedCapabilities: [] },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_FORBIDDEN");
        return true;
      },
    );
    const view = await authRepo.getPublicUser(USER_ID);
    assert.deepEqual(view!.workspaces.find((w) => w.workspaceId === WS_PERSONAL)?.capabilities, []);
  });
});
