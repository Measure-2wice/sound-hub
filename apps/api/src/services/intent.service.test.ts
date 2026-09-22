// Intent service tests (M2 #83).
//
// Behavioural tests for the IntentService against the in-memory
// repository. Coverage:
//
//   - `Hire` on empty Personal provisions exactly Buyer.
//   - `Offer` on empty Personal provisions exactly Seller.
//   - `Both` on empty Personal provisions Buyer + Seller
//     atomically.
//   - No `sellerAcceptance` request field is required.
//   - `DealApprover` is NEVER created.
//   - Later capability addition through the SAME command:
//     `[Buyer] + Offer → Both`; `[Seller] + Hire → Both`.
//   - Identical retries (chosen ⊆ persisted) are no-op idempotent
//     success — even when `expectedCapabilities` is stale.
//   - Stale `expectedCapabilities` against a fresh persisted
//     state → `INTENT_CONFLICT` (NOT `INTENT_FORBIDDEN`), with the
//     fresh state preserved.
//   - `Not a current member` translates to `INTENT_FORBIDDEN`
//     (authorization failure is distinct from capability-precondition
//     mismatch).
//   - Recovery refuses all mutations.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { IntentConflictError } from "../auth-repository/auth-repository.js";
import { IntentService, IntentServiceError } from "./intent.service.js";
import { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";
import type { ConvergenceKind } from "../lib/personal-workspace-convergence-domain.js";
import type { IntentKindV1, IntentRequestV1, MarketplaceCapabilityV1 } from "@soundhub/types";

const USER_ID = "user-intent-test";
const WS_ID = "ws-intent-test-personal";

function buildSubject(email: string) {
  return `deterministic|${email}`;
}

const CONVERGED: ConvergenceKind = {
  kind: "converged",
  workspaceId: WS_ID,
  membershipId: "m-intent-test",
};
const RECOVERY: ConvergenceKind = {
  kind: "recovery",
  userAccountId: USER_ID,
  reason: "pointer-workspace-missing",
};

// Helpers — the request body shape (intent + expectedCapabilities
// + optional returnTo) is the executable contract; tests build it
// verbatim.
function submitEmpty(intent: IntentKindV1): IntentRequestV1 {
  return { intent, expectedCapabilities: [] };
}

function submitWithExpected(
  intent: IntentKindV1,
  expectedCapabilities: readonly MarketplaceCapabilityV1[],
): IntentRequestV1 {
  return { intent, expectedCapabilities: [...expectedCapabilities] };
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
  test("Hire on empty Personal provisions exactly Buyer, no Seller", async () => {
    const { service, authRepo } = buildService();
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitEmpty("Hire"),
    });
    assert.equal(result.user.workspaces.length, 1);
    const personal = result.user.workspaces[0]!;
    assert.deepEqual(personal.capabilities, ["Buyer"]);
    assert.equal(personal.capabilities.includes("Seller"), false);

    const view = await authRepo.getPublicUser(USER_ID);
    const memberships = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(memberships?.capabilities, ["Buyer"]);
  });

  test("Offer on empty Personal provisions exactly Seller with no participation acceptance", async () => {
    const { service, authRepo } = buildService();
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitEmpty("Offer"),
    });
    assert.deepEqual(result.user.workspaces[0]!.capabilities, ["Seller"]);
    const view = await authRepo.getPublicUser(USER_ID);
    const memberships = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(memberships!.capabilities, ["Seller"]);
  });

  test("Both on empty Personal provisions Buyer + Seller atomically with no participation acceptance", async () => {
    const { service, authRepo } = buildService();
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitEmpty("Both"),
    });
    assert.deepEqual(result.user.workspaces[0]!.capabilities, ["Buyer", "Seller"]);
    const view = await authRepo.getPublicUser(USER_ID);
    const memberships = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(memberships!.capabilities, ["Buyer", "Seller"]);
  });

  test("Later-add: [Buyer] + Offer -> Both (expectedCapabilities=[Buyer])", async () => {
    const { service, authRepo } = buildService();
    await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitEmpty("Hire"),
    });
    // The Personal Workspace now has Buyer; the explicit
    // later-add shape is `Offer` with the observed capability
    // set. Final state is Buyer+Seller=Both.
    await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitWithExpected("Offer", ["Buyer"]),
    });
    const view = await authRepo.getPublicUser(USER_ID);
    const personal = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(personal?.capabilities, ["Buyer", "Seller"]);
  });

  test("Later-add: [Seller] + Hire -> Both (expectedCapabilities=[Seller])", async () => {
    const { service, authRepo } = buildService();
    await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitEmpty("Offer"),
    });
    await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitWithExpected("Hire", ["Seller"]),
    });
    const view = await authRepo.getPublicUser(USER_ID);
    const personal = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(personal?.capabilities, ["Buyer", "Seller"]);
  });

  test("Idempotent retry: re-submitting the same intent against the same state is a no-op", async () => {
    const { service, authRepo } = buildService();
    await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitEmpty("Both"),
    });
    // Re-submit Both against the now-Both state. The chosen
    // set `{Buyer,Seller}` is already covered; the command is
    // a no-op success.
    await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitEmpty("Both"),
    });
    const view = await authRepo.getPublicUser(USER_ID);
    const personal = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(personal?.capabilities, ["Buyer", "Seller"]);
  });

  test("Idempotent with stale expected: chosen already covered succeeds even when expectedCapabilities is stale", async () => {
    const { service, authRepo } = buildService();
    // Persisted state = Both.
    await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitEmpty("Both"),
    });
    // Stale UI submits Hire with expected=[] (the state the
    // human initially observed, before the Both submission).
    // The chosen set {Buyer} is already covered by persisted
    // Both — idempotent success, zero writes.
    await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitWithExpected("Hire", []),
    });
    const view = await authRepo.getPublicUser(USER_ID);
    const personal = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(personal?.capabilities, ["Buyer", "Seller"]);
  });

  test("Conflicting stale precondition: persisted=Buyer + submit Offer with expected=[] -> IntentConflictError (distinct from authorization); final=Buyer", async () => {
    const { service, authRepo } = buildService();
    // Persisted state = Buyer.
    await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitEmpty("Hire"),
    });
    // Stale UI observed [] (before Hire committed). Submits
    // Offer with expected=[]. Precondition mismatch — the
    // customer must reload and re-submit with the fresh state.
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ID,
          convergence: CONVERGED,
          intent: submitWithExpected("Offer", []),
        }),
      (err: unknown) => {
        // The atomic primitive's IntentConflictError bubbles
        // up intact so the route can emit the dedicated
        // INT-prefix envelope with the fresh capability set
        // attached. The service does NOT collapse it into
        // IntentServiceError — that would lose the
        // actionable recovery payload.
        assert.ok(err instanceof IntentConflictError);
        assert.deepEqual(err.existing, ["Buyer"]);
        assert.deepEqual(err.expected, []);
        assert.deepEqual(err.fresh, ["Buyer"]);
        return true;
      },
    );
    const view = await authRepo.getPublicUser(USER_ID);
    const personal = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(
      personal?.capabilities,
      ["Buyer"],
      "transaction rolled back; persisted state preserved",
    );
  });

  test("Conflicting stale precondition: persisted=Seller + submit Hire with expected=[] -> IntentConflictError; final=Seller", async () => {
    const { service, authRepo } = buildService();
    await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      convergence: CONVERGED,
      intent: submitEmpty("Offer"),
    });
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ID,
          convergence: CONVERGED,
          intent: submitWithExpected("Hire", []),
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentConflictError);
        assert.deepEqual(err.existing, ["Seller"]);
        return true;
      },
    );
    const view = await authRepo.getPublicUser(USER_ID);
    const personal = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(personal?.capabilities, ["Seller"]);
  });

  test("Not a current member is translated to INTENT_FORBIDDEN (NOT INTENT_CONFLICT)", async () => {
    const { service } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: "ws-not-a-member",
          convergence: CONVERGED,
          intent: submitEmpty("Hire"),
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
          convergence: RECOVERY,
          intent: submitEmpty("Hire"),
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
          convergence: RECOVERY,
          intent: submitEmpty("Offer"),
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
          convergence: RECOVERY,
          intent: submitEmpty("Both"),
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
      convergence: CONVERGED,
      intent: submitEmpty("Hire"),
    });
    assert.equal(result.user.setupState, "converged");
  });
});
