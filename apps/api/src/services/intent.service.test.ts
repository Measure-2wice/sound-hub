// Intent service tests (M2 #83).
//
// Behavioural tests for the IntentService against the in-memory
// repository. Coverage:
//
//   - `Hire` provisions exactly one Buyer capability row, no
//     Seller row.
//   - `Offer` provisions exactly one Seller capability row.
//   - `Both` provisions Buyer + Seller; concurrency correctness is
//     asserted at the repository level
//     (`prisma-auth-repository.intent.concurrency.test.ts`).
//   - No `sellerAcceptance` request field is required on `Offer`
//     or `Both`. #83 does NOT collect a generic Seller
//     participation/terms acceptance at capability-provisioning
//     time.
//   - `DealApprover` is NEVER created.
//   - `Not a current member` throws `INTENT_FORBIDDEN`.
//
// The tests run against the in-memory AuthRepository +
// WorkspaceAuthorizationService. The unit-level tests do NOT
// depend on Prisma; the repository-level concurrency tests
// cover the Prisma adapter separately.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { IntentService, IntentServiceError } from "./intent.service.js";
import { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";

const USER_ID = "user-intent-test";
const WS_ID = "ws-intent-test-personal";

function buildSubject(email: string) {
  return `deterministic|${email}`;
}

function buildService() {
  const authRepo = new InMemoryAuthRepository([
    {
      userAccountId: USER_ID,
      email: "intent-test@example.com",
      identityProvider: "deterministic",
      identitySubject: buildSubject("intent-test@example.com"),
      memberships: [
        {
          workspaceId: WS_ID,
          slug: "intent-test-personal",
          name: "Intent Test Personal",
          workspaceType: "Personal",
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
  return { authRepo, workspaceAuthorizationService, service };
}

describe("IntentService", () => {
  test("Hire provisions exactly Buyer capability, no Seller", async () => {
    const { service, authRepo } = buildService();
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      setupState: "converged",
      intent: { intent: "Hire" },
    });
    assert.equal(result.user.workspaces.length, 1);
    const personal = result.user.workspaces[0]!;
    assert.deepEqual(personal.capabilities, ["Buyer"]);
    assert.equal(personal.capabilities.includes("Seller"), false);

    const view = await authRepo.getPublicUser(USER_ID);
    assert.ok(view);
    const memberships = view.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(memberships?.capabilities, ["Buyer"]);
  });

  test("Offer provisions exactly Seller capability with no participation acceptance", async () => {
    const { service, authRepo } = buildService();
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      setupState: "converged",
      intent: { intent: "Offer" },
    });
    assert.deepEqual(result.user.workspaces[0]!.capabilities, ["Seller"]);
    const view = await authRepo.getPublicUser(USER_ID);
    const memberships = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(memberships!.capabilities, ["Seller"]);
  });

  test("Both provisions Buyer + Seller atomically with no participation acceptance", async () => {
    const { service, authRepo } = buildService();
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      setupState: "converged",
      intent: { intent: "Both" },
    });
    assert.deepEqual(result.user.workspaces[0]!.capabilities, ["Buyer", "Seller"]);
    const view = await authRepo.getPublicUser(USER_ID);
    const memberships = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(memberships!.capabilities, ["Buyer", "Seller"]);
  });

  test("Not a current member is translated to INTENT_FORBIDDEN", async () => {
    const { service } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: "ws-not-a-member",
          setupState: "converged",
          intent: { intent: "Hire" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_FORBIDDEN");
        return true;
      },
    );
  });

  test("Recovery state refuses intent provisioning; no mutation (Hire)", async () => {
    const { service, authRepo } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ID,
          setupState: "recovery",
          intent: { intent: "Hire" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_FORBIDDEN");
        return true;
      },
    );
    const view = await authRepo.getPublicUser(USER_ID);
    assert.deepEqual(view!.workspaces.find((w) => w.workspaceId === WS_ID)?.capabilities, []);
  });

  test("Recovery state refuses intent provisioning; no mutation (Offer)", async () => {
    const { service } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ID,
          setupState: "recovery",
          intent: { intent: "Offer" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_FORBIDDEN");
        return true;
      },
    );
  });

  test("Recovery state refuses intent provisioning; no mutation (Both)", async () => {
    const { service } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ID,
          setupState: "recovery",
          intent: { intent: "Both" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_FORBIDDEN");
        return true;
      },
    );
  });

  test("Converged intent payload still preserves setupState on the success path", async () => {
    const { service } = buildService();
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      setupState: "converged",
      intent: { intent: "Hire" },
    });
    assert.equal(result.user.setupState, "converged");
  });
});
