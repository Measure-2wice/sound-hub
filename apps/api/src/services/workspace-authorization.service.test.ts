// WorkspaceAuthorizationService tests.
//
// Background: BG1 requires that consequential commands authorize
// exclusively via current WorkspaceMembership (GS 4), never via the
// legacy `Workspace.ownerUserId` column (GS 5). These tests pin
// every branch the service can produce.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  AuthorizationError,
  WorkspaceAuthorizationService,
} from "./workspace-authorization.service.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";

const BUYER_USER = "user-buyer";
const SELLER_USER = "user-seller";
const BUYER_WORKSPACE = "ws-buyer";
const SELLER_WORKSPACE = "ws-seller";

describe("WorkspaceAuthorizationService", () => {
  let authRepo: InMemoryAuthRepository;
  let service: WorkspaceAuthorizationService;

  beforeEach(() => {
    authRepo = new InMemoryAuthRepository([
      {
        userAccountId: BUYER_USER,
        email: "buyer@example.com",
        identityProvider: "deterministic",
        identitySubject: "buyer-subject",
        memberships: [
          {
            workspaceId: BUYER_WORKSPACE,
            slug: "buyer-workspace",
            name: "Buyer Workspace",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: ["Buyer"],
          },
        ],
      },
      {
        userAccountId: SELLER_USER,
        email: "seller@example.com",
        identityProvider: "deterministic",
        identitySubject: "seller-subject",
        memberships: [
          {
            workspaceId: SELLER_WORKSPACE,
            slug: "seller-workspace",
            name: "Seller Workspace",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: ["Seller"],
          },
        ],
      },
    ]);
    service = new WorkspaceAuthorizationService({ authRepository: authRepo });
  });

  test("a member with current membership is authorized", async () => {
    const membership = await service.requireActingMembership({
      userAccountId: BUYER_USER,
      workspaceId: BUYER_WORKSPACE,
    });
    assert.equal(membership.workspace.workspaceId, BUYER_WORKSPACE);
    assert.equal(membership.role, "Owner");
    assert.deepEqual(membership.capabilities, ["Buyer"]);
  });

  test("a non-member is rejected with NOT_A_MEMBER (GS 4)", async () => {
    await assert.rejects(
      () =>
        service.requireActingMembership({
          userAccountId: BUYER_USER,
          workspaceId: SELLER_WORKSPACE,
        }),
      (err: unknown) => err instanceof AuthorizationError && err.code === "NOT_A_MEMBER",
    );
  });

  test("a matching legacy ownerUserId without current membership is rejected (GS 5)", async () => {
    // The InMemoryAuthRepository does not model ownerUserId; the
    // authorization service never consults it. We simulate the GS 5
    // scenario by removing the membership row from the user's view.
    authRepo = new InMemoryAuthRepository([
      {
        userAccountId: BUYER_USER,
        email: "buyer@example.com",
        identityProvider: "deterministic",
        identitySubject: "buyer-subject",
        memberships: [], // explicit empty: no current membership
      },
    ]);
    service = new WorkspaceAuthorizationService({ authRepository: authRepo });
    await assert.rejects(
      () =>
        service.requireActingMembership({
          userAccountId: BUYER_USER,
          workspaceId: BUYER_WORKSPACE,
        }),
      (err: unknown) => err instanceof AuthorizationError && err.code === "NOT_A_MEMBER",
    );
  });

  test("a member of a Suspended workspace is rejected with WORKSPACE_INELIGIBLE", async () => {
    authRepo = new InMemoryAuthRepository([
      {
        userAccountId: BUYER_USER,
        email: "buyer@example.com",
        identityProvider: "deterministic",
        identitySubject: "buyer-subject",
        memberships: [
          {
            workspaceId: BUYER_WORKSPACE,
            slug: "buyer-workspace",
            name: "Buyer Workspace",
            workspaceType: "Personal",
            workspaceStatus: "Suspended",
            role: "Owner",
            capabilities: ["Buyer"],
          },
        ],
      },
    ]);
    service = new WorkspaceAuthorizationService({ authRepository: authRepo });
    await assert.rejects(
      () =>
        service.requireActingMembership({
          userAccountId: BUYER_USER,
          workspaceId: BUYER_WORKSPACE,
        }),
      (err: unknown) => err instanceof AuthorizationError && err.code === "WORKSPACE_INELIGIBLE",
    );
  });

  test("requireCapability passes when the Workspace has the capability", async () => {
    const membership = await service.requireCapability({
      userAccountId: SELLER_USER,
      workspaceId: SELLER_WORKSPACE,
      requiredCapability: "Seller",
    });
    assert.equal(membership.role, "Owner");
    assert.deepEqual(membership.capabilities, ["Seller"]);
  });

  test("requireCapability fails with MISSING_CAPABILITY when the Workspace lacks it", async () => {
    await assert.rejects(
      () =>
        service.requireCapability({
          userAccountId: BUYER_USER,
          workspaceId: BUYER_WORKSPACE,
          requiredCapability: "Seller",
        }),
      (err: unknown) => err instanceof AuthorizationError && err.code === "MISSING_CAPABILITY",
    );
  });

  test("requireCapability fails with NOT_A_MEMBER (not MISSING_CAPABILITY) when membership is absent", async () => {
    await assert.rejects(
      () =>
        service.requireCapability({
          userAccountId: SELLER_USER,
          workspaceId: BUYER_WORKSPACE,
          requiredCapability: "Buyer",
        }),
      (err: unknown) => err instanceof AuthorizationError && err.code === "NOT_A_MEMBER",
    );
  });

  test("a buyer with current membership is rejected from a seller command (capability check)", async () => {
    // A BUYER-capable Workspace cannot satisfy a SELLER-required
    // command even though it has a current membership. This is the
    // marketplace authority boundary: authority comes from current
    // membership + Workspace capability, not from anything else.
    await assert.rejects(
      () =>
        service.requireCapability({
          userAccountId: BUYER_USER,
          workspaceId: BUYER_WORKSPACE,
          requiredCapability: "Seller",
        }),
      (err: unknown) => err instanceof AuthorizationError && err.code === "MISSING_CAPABILITY",
    );
  });
});
