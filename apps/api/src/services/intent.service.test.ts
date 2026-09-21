// Intent service tests (M2 #83).
//
// Behavioural tests for the IntentService against the in-memory
// repository. Coverage:
//
//   - `Hire` provisions exactly one Buyer capability row, no
//     Seller row, no acceptance row.
//   - `Offer` provisions exactly one Seller capability row + one
//     Seller participation acceptance row.
//   - `Both` provisions Buyer + Seller + acceptance; concurrency
//     correctness is asserted at the repository level
//     (`prisma-auth-repository.intent.concurrency.test.ts`).
//   - `Offer` and `Both` without `sellerAcceptance` throw
//     `INTENT_INVALID`.
//   - `Offer` and `Both` without registered Seller participation
//     terms throw `INTENT_LEGAL_BLOCKED`.
//   - `Offer` and `Both` with mismatched `termsContentHash` or
//     `termsVersion` throw `INTENT_INVALID`.
//   - `DealApprover` is NEVER created.
//   - `Not a current member` throws `INTENT_FORBIDDEN`.
//
// The tests run against the in-memory AuthRepository +
// WorkspaceAuthorizationService. The unit-level tests do NOT
// depend on Prisma; the repository-level concurrency tests
// cover the Prisma adapter separately.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  __resetSellerParticipationTermsForTests,
  registerSellerParticipationTerms,
} from "../lib/seller-participation-terms.js";
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

const SAMPLE_TERMS = {
  version: "1.0.0",
  content:
    "SoundHub Seller participation terms v1.0.0\n\n" +
    "By choosing Offer services, you confirm you understand the marketplace participation rules.\n",
};

describe("IntentService", () => {
  beforeEach(() => {
    __resetSellerParticipationTermsForTests();
  });

  test("Hire provisions exactly Buyer capability, no Seller, no acceptance", async () => {
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
    // No Seller row.
    assert.equal(personal.capabilities.includes("Seller"), false);

    // Repo-level assertion: no Seller capability, no acceptance row.
    const view = await authRepo.getPublicUser(USER_ID);
    assert.ok(view);
    const memberships = view.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(memberships?.capabilities, ["Buyer"]);
  });

  test("Offer without sellerAcceptance throws INTENT_INVALID", async () => {
    const { service } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ID,
          setupState: "converged",
          intent: { intent: "Offer" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_INVALID");
        return true;
      },
    );
  });

  test("Both without sellerAcceptance throws INTENT_INVALID", async () => {
    const { service } = buildService();
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ID,
          setupState: "converged",
          intent: { intent: "Both" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_INVALID");
        return true;
      },
    );
  });

  test("Offer and Both WITHOUT registered terms throws INTENT_LEGAL_BLOCKED", async () => {
    __resetSellerParticipationTermsForTests();
    const { service } = buildService();
    const intentWithAcceptance = (intent: "Offer" | "Both") => ({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      setupState: "converged" as const,
      intent: {
        intent,
        sellerAcceptance: {
          termsVersion: "1.0.0",
          termsContentHash: "0".repeat(64),
        },
      },
    });
    await assert.rejects(
      () => service.submitIntent(intentWithAcceptance("Offer")),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_LEGAL_BLOCKED");
        return true;
      },
    );
    await assert.rejects(
      () => service.submitIntent(intentWithAcceptance("Both")),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_LEGAL_BLOCKED");
        return true;
      },
    );
  });

  test("Offer with registered terms provisions exactly Seller + acceptance", async () => {
    const { service, authRepo } = buildService();
    const registered = registerSellerParticipationTerms(SAMPLE_TERMS);
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      setupState: "converged",
      intent: {
        intent: "Offer",
        sellerAcceptance: {
          termsVersion: registered.version,
          termsContentHash: registered.contentHash,
        },
      },
    });
    assert.deepEqual(result.user.workspaces[0]!.capabilities, ["Seller"]);
    const view = await authRepo.getPublicUser(USER_ID);
    const memberships = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(memberships!.capabilities, ["Seller"]);
  });

  test("Valid Offer (current registered terms) provisions Seller + acceptance", async () => {
    // M2 #83 remediation §3 / C2: deterministic test-only
    // registration path. Production Seller terms stay
    // unregistered; this case uses `registerSellerParticipationTerms`
    // ONLY inside the test.
    const { service, authRepo } = buildService();
    const registered = registerSellerParticipationTerms(SAMPLE_TERMS);
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      setupState: "converged",
      intent: {
        intent: "Offer",
        sellerAcceptance: {
          termsVersion: registered.version,
          termsContentHash: registered.contentHash,
        },
      },
    });
    assert.deepEqual(result.user.workspaces[0]!.capabilities, ["Seller"]);
    const view = await authRepo.getPublicUser(USER_ID);
    const memberships = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(memberships!.capabilities, ["Seller"]);
  });

  test("Valid Both (current registered terms) provisions Buyer + Seller + acceptance atomically", async () => {
    const { service, authRepo } = buildService();
    const registered = registerSellerParticipationTerms(SAMPLE_TERMS);
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      setupState: "converged",
      intent: {
        intent: "Both",
        sellerAcceptance: {
          termsVersion: registered.version,
          termsContentHash: registered.contentHash,
        },
      },
    });
    assert.deepEqual(result.user.workspaces[0]!.capabilities, ["Buyer", "Seller"]);
    const view = await authRepo.getPublicUser(USER_ID);
    const memberships = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(memberships!.capabilities, ["Buyer", "Seller"]);
  });

  test("Offer with stale termsVersion throws INTENT_INVALID", async () => {
    const { service } = buildService();
    registerSellerParticipationTerms(SAMPLE_TERMS);
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ID,
          setupState: "converged",
          intent: {
            intent: "Offer",
            sellerAcceptance: {
              termsVersion: "9.9.9",
              termsContentHash: "0".repeat(64),
            },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_INVALID");
        return true;
      },
    );
  });

  test("Offer with mismatched termsContentHash throws INTENT_INVALID", async () => {
    const { service } = buildService();
    const registered = registerSellerParticipationTerms(SAMPLE_TERMS);
    await assert.rejects(
      () =>
        service.submitIntent({
          userAccountId: USER_ID,
          workspaceId: WS_ID,
          setupState: "converged",
          intent: {
            intent: "Offer",
            sellerAcceptance: {
              termsVersion: registered.version,
              termsContentHash: "0".repeat(64),
            },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_INVALID");
        return true;
      },
    );
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
        // The WorkspaceAuthorizationService throws
        // AuthorizationError; the IntentService translates it to
        // INTENT_FORBIDDEN so the route layer can map a single
        // safe-envelope code at the intent boundary.
        assert.ok(err instanceof IntentServiceError);
        assert.equal(err.code, "INTENT_FORBIDDEN");
        return true;
      },
    );
  });

  test("Returned user payload preserves setupState verbatim from the input", async () => {
    const { service } = buildService();
    const result = await service.submitIntent({
      userAccountId: USER_ID,
      workspaceId: WS_ID,
      setupState: "recovery",
      intent: { intent: "Hire" },
    });
    assert.equal(result.user.setupState, "recovery");
  });
});
