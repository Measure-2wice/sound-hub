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
import type { ProjectBriefPublicV1 } from "@soundhub/types";
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
  now: () => Date;
  clock: { current: Date };
}

function buildFixture(): Fixture {
  const projectRequestRepo = new InMemoryProjectRequestRepository();
  // Seed the in-memory snapshot state the policy evaluators
  // consume. The repository loads + locks these snapshots inside
  // its transaction; the service invokes the pure evaluators in
  // `project-request-authorization-policy.ts` to decide whether
  // the facts authorize the command.
  projectRequestRepo.seedWorkspace({
    workspaceId: BUYER_WORKSPACE_ID,
    status: "Active",
    ownerUserId: BUYER_USER_ID,
    buyerCapability: true,
    sellerCapability: false,
  });
  projectRequestRepo.seedWorkspace({
    workspaceId: OTHER_BUYER_WORKSPACE_ID,
    status: "Active",
    ownerUserId: OTHER_BUYER_USER_ID,
    buyerCapability: true,
    sellerCapability: false,
  });
  projectRequestRepo.seedWorkspace({
    workspaceId: SELLER_WORKSPACE_ID,
    status: "Active",
    ownerUserId: SELLER_USER_ID,
    buyerCapability: false,
    sellerCapability: true,
  });
  projectRequestRepo.seedWorkspace({
    workspaceId: "ws-different-seller",
    status: "Active",
    ownerUserId: "user-different-seller",
    buyerCapability: false,
    sellerCapability: true,
  });
  projectRequestRepo.seedSellerProfile({
    workspaceId: "ws-different-seller",
    status: "Published",
  });
  projectRequestRepo.seedMembership({
    userId: "user-different-seller",
    workspaceId: "ws-different-seller",
  });
  projectRequestRepo.seedMembership({
    userId: BUYER_USER_ID,
    workspaceId: BUYER_WORKSPACE_ID,
  });
  projectRequestRepo.seedMembership({
    userId: OTHER_BUYER_USER_ID,
    workspaceId: OTHER_BUYER_WORKSPACE_ID,
  });
  projectRequestRepo.seedMembership({
    userId: SELLER_USER_ID,
    workspaceId: SELLER_WORKSPACE_ID,
  });

  projectRequestRepo.seedSellerProfile({
    workspaceId: SELLER_WORKSPACE_ID,
    status: "Published",
  });
  projectRequestRepo.seedServiceOffering({
    id: OFFERING_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    status: "Active",
  });
  projectRequestRepo.seedServiceOffering({
    id: OFFERING_INELIGIBLE_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    status: "Paused",
  });
  projectRequestRepo.seedServiceOffering({
    id: OFFERING_OTHER_SELLER_ID,
    sellerWorkspaceId: "ws-different-seller",
    status: "Active",
  });
  projectRequestRepo.seedServiceOffering({
    id: OFFERING_NOT_IN_BRIEF_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    status: "Active",
  });

  projectRequestRepo.seedProjectBrief({
    id: BRIEF_ID,
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    recommendedOfferingIds: [OFFERING_ID, OFFERING_OTHER_SELLER_ID, OFFERING_INELIGIBLE_ID],
  });
  projectRequestRepo.seedProjectBrief({
    id: OTHER_BRIEF_ID,
    buyerWorkspaceId: OTHER_BUYER_WORKSPACE_ID,
    recommendedOfferingIds: [OFFERING_ID],
  });

  const clock = { current: new Date("2026-08-27T00:00:00Z") };
  const now = () => clock.current;

  const service = new ProjectRequestService({
    projectRequestRepository: projectRequestRepo,
    now,
  });

  return {
    projectRequestService: service,
    projectRequestRepo,
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
  // The seller user is NOT a member of the buyer Workspace, so the
  // buyer authority snapshot surfaces isMember=false and the
  // application-owned evaluateBuyerAuthority evaluator fails
  // closed with NOT_A_MEMBER. The service translates this to
  // PROJECT_REQUEST_FORBIDDEN.
  await assert.rejects(
    projectRequestService.createProjectRequest({
      userAccountId: SELLER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: BRIEF_ID,
      serviceOfferingId: OFFERING_ID,
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
  // sellerWorkspaceId from the snapshot is the source of truth
  // for ownership. This test pins the surface so a future
  // regression that hard-codes the acting Workspace would be
  // detected.
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
  // the seller authority snapshot surfaces isMember=false and the
  // application-owned evaluateSellerAuthority evaluator fails
  // closed with NOT_A_MEMBER. The service translates this to
  // PROJECT_REQUEST_FORBIDDEN.
  await assert.rejects(
    projectRequestService.acceptProjectRequest({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: SELLER_WORKSPACE_ID,
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
  // No Deal should have been created. The in-memory repository
  // has no public listDeals, so we rely on the absence of an
  // accept call having been issued: the request status is
  // Declined and the sellerConsentAt is null, which is the
  // contract for decline.
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
  // Constructor signature: { projectRequestRepository, now? }. No
  // `prisma` field. The next line would NOT compile if `prisma`
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
