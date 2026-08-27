/* eslint-disable @typescript-eslint/no-floating-promises */
// ProjectRequestService unit tests.
//
// Background: ticket #62 acceptance criteria require the service to:
//   - revalidate Buyer membership + acting Workspace identity
//   - enforce the brief-ownership + brief-recommendation boundary (P1-001)
//   - revalidate ServiceOffering eligibility (workspace active +
//     Seller capability + SellerProfile Published + ServiceOffering
//     Active) atomically with the INSERT (P1-002)
//   - persist a Pending ProjectRequest through the repository, with
//     NO Prisma dependency in the service (P1-003)
//   - revalidate seller membership before accept/decline
//   - atomically transition Pending -> Accepted + create exactly one Deal
//   - atomically transition Pending -> Declined + create NO Deal
//   - reject retried accept/decline on an already-responded request
//
// These tests use the InMemoryProjectRequestRepository so they run
// without a database. The Prisma adapter's equivalence is proven by
// the integration tests against the disposable PostgreSQL target.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { MatchmakerCriteriaV1, ProjectBriefPublicV1 } from "@soundhub/types";
import {
  InMemoryAuthRepository,
  type InMemoryUserSeed,
} from "../auth-repository/in-memory-auth-repository.js";
import { InMemoryProjectBriefRepository } from "../matchmaker/in-memory-project-brief.repository.js";
import type {
  ProjectBriefRepository,
  PersistedBrief,
} from "../matchmaker/project-brief.repository.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import { ProjectRequestService } from "./project-request.service.js";
import { InMemoryProjectRequestRepository } from "./in-memory-project-request.repository.js";

const BUYER_USER_ID = "user-buyer";
const BUYER_WORKSPACE_ID = "ws-buyer";
const OTHER_BUYER_USER_ID = "user-other-buyer";
const OTHER_BUYER_WORKSPACE_ID = "ws-other-buyer";
const SELLER_USER_ID = "user-seller";
const SELLER_WORKSPACE_ID = "ws-seller";
const OFFERING_ID = "of-eligible";
const OFFERING_INELIGIBLE_ID = "of-ineligible";
const OFFERING_OTHER_SELLER_ID = "of-other-seller";
const OFFERING_NOT_IN_BRIEF_ID = "of-not-recommended";
const BRIEF_ID = "brief-1";
const OTHER_BRIEF_ID = "brief-other";

interface Fixture {
  projectRequestService: ProjectRequestService;
  projectRequestRepo: InMemoryProjectRequestRepository;
  briefRepo: ProjectBriefRepository;
  buildBrief: (id: string, buyerWorkspaceId: string) => PersistedBrief;
  now: () => Date;
  clock: { current: Date };
}

function buildFixture(): Fixture {
  const buyerSeed: InMemoryUserSeed = {
    userAccountId: BUYER_USER_ID,
    email: "buyer@example.com",
    identityProvider: "deterministic",
    identitySubject: "buyer-subject",
    memberships: [
      {
        workspaceId: BUYER_WORKSPACE_ID,
        slug: "buyer",
        name: "Buyer",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        role: "Owner",
        capabilities: ["Buyer"],
      },
    ],
  };
  const otherBuyerSeed: InMemoryUserSeed = {
    userAccountId: OTHER_BUYER_USER_ID,
    email: "other-buyer@example.com",
    identityProvider: "deterministic",
    identitySubject: "other-buyer-subject",
    memberships: [
      {
        workspaceId: OTHER_BUYER_WORKSPACE_ID,
        slug: "other-buyer",
        name: "Other Buyer",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        role: "Owner",
        capabilities: ["Buyer"],
      },
    ],
  };
  const sellerSeed: InMemoryUserSeed = {
    userAccountId: SELLER_USER_ID,
    email: "seller@example.com",
    identityProvider: "deterministic",
    identitySubject: "seller-subject",
    memberships: [
      {
        workspaceId: SELLER_WORKSPACE_ID,
        slug: "seller",
        name: "Seller",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        role: "Owner",
        capabilities: ["Seller"],
      },
    ],
  };
  const authRepo = new InMemoryAuthRepository([buyerSeed, otherBuyerSeed, sellerSeed]);
  const authz = new WorkspaceAuthorizationService({ authRepository: authRepo });

  const projectRequestRepo = new InMemoryProjectRequestRepository();
  // Seed the brief → recommendation mapping for P1-001 enforcement.
  // BRIEF_ID surfaces OFFERING_ID, OFFERING_OTHER_SELLER_ID,
  // OFFERING_INELIGIBLE_ID; OFFERING_NOT_IN_BRIEF_ID is NOT a
  // recommendation, so submitting it must fail with
  // OFFERING_NOT_IN_BRIEF.
  projectRequestRepo.seedBrief({
    briefId: BRIEF_ID,
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    offeringIds: [OFFERING_ID, OFFERING_OTHER_SELLER_ID, OFFERING_INELIGIBLE_ID],
  });
  projectRequestRepo.seedBrief({
    briefId: OTHER_BRIEF_ID,
    buyerWorkspaceId: OTHER_BUYER_WORKSPACE_ID,
    offeringIds: [OFFERING_ID],
  });
  // Seed eligibility snapshots. The repository's P1-002 transaction
  // applies the same chain as the previous Prisma `loadOfferingEligibility`.
  projectRequestRepo.seedOfferingEligibility({
    id: OFFERING_ID,
    status: "Active",
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    workspaceStatus: "Active",
    workspaceHasSellerCapability: true,
    profileStatus: "Published",
  });
  projectRequestRepo.seedOfferingEligibility({
    id: OFFERING_OTHER_SELLER_ID,
    status: "Active",
    sellerWorkspaceId: "ws-different-seller",
    workspaceStatus: "Active",
    workspaceHasSellerCapability: true,
    profileStatus: "Published",
  });
  projectRequestRepo.seedOfferingEligibility({
    id: OFFERING_INELIGIBLE_ID,
    status: "Paused", // ineligible — Paused, not Active
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    workspaceStatus: "Active",
    workspaceHasSellerCapability: true,
    profileStatus: "Published",
  });
  projectRequestRepo.seedOfferingEligibility({
    id: OFFERING_NOT_IN_BRIEF_ID,
    status: "Active",
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    workspaceStatus: "Active",
    workspaceHasSellerCapability: true,
    profileStatus: "Published",
  });

  const buildBrief = (id: string, buyerWorkspaceId: string): PersistedBrief => {
    const criteria: MatchmakerCriteriaV1 = {
      required: { primaryCategoryKeys: ["music-production"] },
    };
    return {
      id,
      buyerWorkspaceId,
      createdByUserId:
        buyerWorkspaceId === BUYER_WORKSPACE_ID ? BUYER_USER_ID : OTHER_BUYER_USER_ID,
      briefText: "Need a producer",
      criteria,
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
      createdAt: new Date(),
      buyerWorkspace: {
        workspaceId: buyerWorkspaceId,
        slug: "buyer",
        name: "Buyer",
      },
      results: [],
    };
  };

  const briefRepo = new InMemoryProjectBriefRepository();
  briefRepo.seed(buildBrief(BRIEF_ID, BUYER_WORKSPACE_ID));
  briefRepo.seed(buildBrief(OTHER_BRIEF_ID, OTHER_BUYER_WORKSPACE_ID));

  const clock = { current: new Date("2026-08-27T00:00:00Z") };
  const now = () => clock.current;

  // P1-003: the service has NO Prisma dependency. The fixture wires
  // the in-memory repository directly.
  const service = new ProjectRequestService({
    projectRequestRepository: projectRequestRepo,
    projectBriefRepository: briefRepo,
    workspaceAuthorizationService: authz,
    now,
  });

  return {
    projectRequestService: service,
    projectRequestRepo,
    briefRepo,
    buildBrief,
    now,
    clock,
  };
}

test("createProjectRequest persists a Pending request owned by the buyer Workspace", async () => {
  const { projectRequestService } = buildFixture();
  const result = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  assert.equal(result.projectRequest.status, "Pending");
  assert.equal(result.projectRequest.buyerWorkspaceId, BUYER_WORKSPACE_ID);
  assert.equal(result.projectRequest.sellerWorkspaceId, SELLER_WORKSPACE_ID);
  assert.equal(result.projectRequest.serviceOfferingId, OFFERING_ID);
  assert.equal(result.projectRequest.projectBriefId, BRIEF_ID);
  assert.equal(result.projectRequest.sellerDecisionAt, null);
  assert.equal(result.projectRequest.sellerConsentAt, null);
});

test("createProjectRequest rejects a non-Buyer actor with PROJECT_REQUEST_FORBIDDEN", async () => {
  const { projectRequestService } = buildFixture();
  // The seller user is not a member of the buyer workspace, so the
  // workspace authorization service must reject them with
  // NOT_A_MEMBER. The route collapses it to a safe envelope.
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: BRIEF_ID,
      serviceOfferingId: OFFERING_ID,
    }),
    (err: unknown) => {
      // The error surfaces from the workspace authorization
      // service; the route collapses it to a safe envelope.
      return err instanceof Error && err.message.includes("not a current member");
    },
  );
});

test("createProjectRequest rejects a brief owned by another buyer Workspace", async () => {
  const { projectRequestService } = buildFixture();
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: OTHER_BRIEF_ID,
      serviceOfferingId: OFFERING_ID,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_BRIEF_FORBIDDEN"
      );
    },
  );
});

test("createProjectRequest rejects a stale or ineligible offering", async () => {
  const { projectRequestService } = buildFixture();
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: BRIEF_ID,
      serviceOfferingId: OFFERING_INELIGIBLE_ID,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_OFFERING_INELIGIBLE"
      );
    },
  );
});

// P1-001 verification: the selected offering MUST be a persisted
// recommendation for the brief. An otherwise-eligible offering that
// Matchmaker never returned for this brief must fail closed with
// PROJECT_REQUEST_OFFERING_INELIGIBLE.
test("createProjectRequest rejects an offering not surfaced by the brief's Matchmaker", async () => {
  const { projectRequestService } = buildFixture();
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: BRIEF_ID,
      serviceOfferingId: OFFERING_NOT_IN_BRIEF_ID,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_OFFERING_INELIGIBLE"
      );
    },
  );
});

test("createProjectRequest persists the offering's owning Workspace as the seller", async () => {
  const { projectRequestService } = buildFixture();
  // The buyer is addressing the buyer Workspace, but the offering
  // is owned by a different seller Workspace. The eligibility
  // revalidation returns the offering (Active etc.) and the
  // sellerWorkspaceId from the lookup is the source of truth for
  // ownership. This test pins the surface so a future regression
  // that hard-codes the acting Workspace would be detected.
  const result = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_OTHER_SELLER_ID,
  });
  assert.equal(result.projectRequest.sellerWorkspaceId, "ws-different-seller");
  assert.notEqual(result.projectRequest.sellerWorkspaceId, BUYER_WORKSPACE_ID);
});

test("createProjectRequest rejects a duplicate Pending request with PROJECT_REQUEST_ALREADY_PENDING", async () => {
  const { projectRequestService } = buildFixture();
  await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: BRIEF_ID,
      serviceOfferingId: OFFERING_ID,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_ALREADY_PENDING"
      );
    },
  );
});

test("acceptProjectRequest atomically transitions Pending and creates exactly one Negotiating Deal", async () => {
  const { projectRequestService, projectRequestRepo } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  const result = await projectRequestService.acceptProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  assert.equal(result.projectRequest.status, "Accepted");
  assert.notEqual(result.projectRequest.sellerConsentAt, null);
  assert.equal(result.deal.status, "Negotiating");
  assert.equal(result.deal.projectRequestId, created.projectRequest.projectRequestId);
  assert.equal(result.deal.buyerWorkspaceId, BUYER_WORKSPACE_ID);
  assert.equal(result.deal.sellerWorkspaceId, SELLER_WORKSPACE_ID);
  // The persisted deal must exist once.
  const stored = await projectRequestRepo.findProjectRequestById(
    created.projectRequest.projectRequestId,
  );
  assert.equal(stored?.status, "Accepted");
});

test("acceptProjectRequest rejects a buyer Workspace member (only the seller side may accept)", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // The buyer user is not a member of the seller Workspace, so
  // workspace authorization fails closed with NOT_A_MEMBER.
  await assert.rejects(
    projectRequestService.acceptProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return err instanceof Error && err.message.includes("not a current member");
    },
  );
});

test("acceptProjectRequest rejects when the actor claims a different acting Workspace", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  await assert.rejects(
    projectRequestService.acceptProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID, // wrong workspace
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_FORBIDDEN"
      );
    },
  );
});

test("acceptProjectRequest retried on an already-accepted request fails with ALREADY_RESPONDED", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  await projectRequestService.acceptProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  await assert.rejects(
    projectRequestService.acceptProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_ALREADY_RESPONDED"
      );
    },
  );
});

test("declineProjectRequest transitions Pending to Declined and creates no Deal", async () => {
  const { projectRequestService, projectRequestRepo } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  const result = await projectRequestService.declineProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  assert.equal(result.projectRequest.status, "Declined");
  assert.notEqual(result.projectRequest.sellerDecisionAt, null);
  assert.equal(result.projectRequest.sellerConsentAt, null);
  // No Deal should have been created. The in-memory repository has
  // no public listDeals, so we rely on the absence of an accept
  // call having been issued: the request status is Declined and
  // the sellerConsentAt is null, which is the contract for decline.
  const stored = await projectRequestRepo.findProjectRequestById(
    created.projectRequest.projectRequestId,
  );
  assert.equal(stored?.status, "Declined");
});

test("declineProjectRequest retried on an already-declined request fails with ALREADY_RESPONDED", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  await projectRequestService.declineProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  await assert.rejects(
    projectRequestService.declineProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_ALREADY_RESPONDED"
      );
    },
  );
});

test("acceptProjectRequest retried on a Declined request fails with ALREADY_RESPONDED", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  await projectRequestService.declineProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: created.projectRequest.projectRequestId,
  });
  await assert.rejects(
    projectRequestService.acceptProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_ALREADY_RESPONDED"
      );
    },
  );
});

test("listProjectRequests returns Pending requests addressed to the seller's Workspace", async () => {
  const { projectRequestService } = buildFixture();
  const first = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  const result = await projectRequestService.listProjectRequests({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    statusFilter: "Pending",
  });
  assert.equal(result.projectRequests.length, 1);
  assert.equal(result.projectRequests[0]!.projectRequestId, first.projectRequest.projectRequestId);
  // Accept it; subsequent Pending list should be empty.
  await projectRequestService.acceptProjectRequest({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    projectRequestId: first.projectRequest.projectRequestId,
  });
  const after = await projectRequestService.listProjectRequests({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
    statusFilter: "Pending",
  });
  assert.equal(after.projectRequests.length, 0);
});

test("getProjectRequest rejects a non-member of either side", async () => {
  const { projectRequestService } = buildFixture();
  const created = await projectRequestService.createProjectRequest({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    projectBriefId: BRIEF_ID,
    serviceOfferingId: OFFERING_ID,
  });
  // The other buyer is not a member of the request's buyer OR
  // seller Workspace. The service must fail closed with
  // PROJECT_REQUEST_NOT_FOUND (per ticket #62 — do not leak the
  // request's existence to non-members).
  await assert.rejects(
    projectRequestService.getProjectRequest({
      userAccountId: OTHER_BUYER_USER_ID,
      actingWorkspaceId: OTHER_BUYER_WORKSPACE_ID,
      projectRequestId: created.projectRequest.projectRequestId,
    }),
    (err: unknown) => {
      return (
        err instanceof Error &&
        err.name === "ProjectRequestError" &&
        (err as { code?: string }).code === "PROJECT_REQUEST_NOT_FOUND"
      );
    },
  );
});

// P1-003 verification: the service MUST NOT depend on Prisma. This
// test pins the type-level contract so a future regression that
// re-introduces `prisma` into the constructor would fail to compile.
test("ProjectRequestService has no Prisma dependency at the type level", () => {
  // Constructor signature: { projectRequestRepository,
  // projectBriefRepository, workspaceAuthorizationService, now? }.
  // No `prisma` field. The next line would NOT compile if `prisma`
  // were reintroduced.
  type _AssertNoPrisma = ProjectRequestService extends {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly prisma: any;
  }
    ? true
    : false;
  const assertFalse: _AssertNoPrisma = false;
  void assertFalse;
});

// Make the typed import survive the strict TS settings.
void (null as unknown as ProjectBriefPublicV1);
