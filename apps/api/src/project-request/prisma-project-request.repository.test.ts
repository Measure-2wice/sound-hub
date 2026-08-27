/* eslint-disable @typescript-eslint/no-floating-promises */
// Prisma adapter integration tests for ProjectRequestRepository.
//
// Background: ticket #62 GS 26 requires the persistence boundary to
// use natural uniqueness constraints + guarded state transitions so
// retries cannot create inappropriate duplicate ProjectRequests or
// multiple Deals for one accepted ProjectRequest. These tests prove
// the Prisma adapter enforces both invariants against a real
// PostgreSQL database.
//
// The tests follow the M1 repository convention: each test resets
// the project_requests and deals tables (and their prerequisites)
// between cases so a run never depends on test ordering. The
// disposable test database lives at TEST_DATABASE_URL.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import {
  PrismaProjectRequestRepository,
  PendingDuplicateError,
} from "./prisma-project-request.repository.js";
import { loadOrCreateFixture, type ProjectRequestFixture } from "./test-fixture.js";

let prisma: PrismaClient;
let fixture: ProjectRequestFixture;
let repo: PrismaProjectRequestRepository;
const clockNow = new Date("2026-08-27T12:00:00Z");

before(async () => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prisma = createPrismaClient(url);
  fixture = await loadOrCreateFixture(prisma);
});

after(async () => {
  if (prisma) {
    await prisma.$disconnect();
  }
});

beforeEach(async () => {
  // Reset only the BG4 rows so the fixture's identity rows (Users,
  // Workspaces, Profiles, Briefs, Offerings) stay stable.
  await prisma.deal.deleteMany({
    where: { projectBriefId: fixture.brief.id },
  });
  await prisma.projectRequest.deleteMany({
    where: { projectBriefId: fixture.brief.id },
  });
  repo = new PrismaProjectRequestRepository(prisma);
});

test("createProjectRequest persists a Pending row", async () => {
  const row = await repo.createProjectRequest({
    buyerWorkspaceId: fixture.buyerWorkspace.id,
    sellerWorkspaceId: fixture.sellerWorkspace.id,
    serviceOfferingId: fixture.offering.id,
    projectBriefId: fixture.brief.id,
    createdByUserId: fixture.buyerUser.id,
  });
  assert.equal(row.status, "Pending");
  assert.equal(row.buyerWorkspaceId, fixture.buyerWorkspace.id);
  assert.equal(row.sellerWorkspaceId, fixture.sellerWorkspace.id);
  assert.equal(row.serviceOfferingId, fixture.offering.id);
  assert.equal(row.projectBriefId, fixture.brief.id);
  assert.equal(row.createdByUserId, fixture.buyerUser.id);
});

test("createProjectRequest rejects a Pending duplicate with PendingDuplicateError", async () => {
  await repo.createProjectRequest({
    buyerWorkspaceId: fixture.buyerWorkspace.id,
    sellerWorkspaceId: fixture.sellerWorkspace.id,
    serviceOfferingId: fixture.offering.id,
    projectBriefId: fixture.brief.id,
    createdByUserId: fixture.buyerUser.id,
  });
  await assert.rejects(
    repo.createProjectRequest({
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      sellerWorkspaceId: fixture.sellerWorkspace.id,
      serviceOfferingId: fixture.offering.id,
      projectBriefId: fixture.brief.id,
      createdByUserId: fixture.buyerUser.id,
    }),
    (err: unknown) => err instanceof PendingDuplicateError,
  );
});

test("acceptProjectRequest atomically creates the Deal and transitions to Accepted", async () => {
  const created = await repo.createProjectRequest({
    buyerWorkspaceId: fixture.buyerWorkspace.id,
    sellerWorkspaceId: fixture.sellerWorkspace.id,
    serviceOfferingId: fixture.offering.id,
    projectBriefId: fixture.brief.id,
    createdByUserId: fixture.buyerUser.id,
  });
  const result = await repo.acceptProjectRequest({
    projectRequestId: created.id,
    sellerDecisionByUserId: fixture.sellerUser.id,
    now: clockNow,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.projectRequest.status, "Accepted");
  assert.equal(result.value.deal.status, "Negotiating");
  assert.equal(result.value.deal.projectRequestId, created.id);
});

test("acceptProjectRequest retried after Accept returns ALREADY_RESPONDED (no second Deal)", async () => {
  const created = await repo.createProjectRequest({
    buyerWorkspaceId: fixture.buyerWorkspace.id,
    sellerWorkspaceId: fixture.sellerWorkspace.id,
    serviceOfferingId: fixture.offering.id,
    projectBriefId: fixture.brief.id,
    createdByUserId: fixture.buyerUser.id,
  });
  const first = await repo.acceptProjectRequest({
    projectRequestId: created.id,
    sellerDecisionByUserId: fixture.sellerUser.id,
    now: clockNow,
  });
  assert.equal(first.ok, true);
  const second = await repo.acceptProjectRequest({
    projectRequestId: created.id,
    sellerDecisionByUserId: fixture.sellerUser.id,
    now: clockNow,
  });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "ALREADY_RESPONDED");
  // Exactly one Deal in the database.
  const dealCount = await prisma.deal.count({
    where: { projectRequestId: created.id },
  });
  assert.equal(dealCount, 1);
});

test("declineProjectRequest transitions to Declined and creates no Deal", async () => {
  const created = await repo.createProjectRequest({
    buyerWorkspaceId: fixture.buyerWorkspace.id,
    sellerWorkspaceId: fixture.sellerWorkspace.id,
    serviceOfferingId: fixture.offering.id,
    projectBriefId: fixture.brief.id,
    createdByUserId: fixture.buyerUser.id,
  });
  const result = await repo.declineProjectRequest({
    projectRequestId: created.id,
    sellerDecisionByUserId: fixture.sellerUser.id,
    now: clockNow,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "Declined");
  assert.equal(result.value.sellerConsentAt, null);
  const dealCount = await prisma.deal.count({
    where: { projectRequestId: created.id },
  });
  assert.equal(dealCount, 0);
});

test("acceptProjectRequest retried after Decline returns ALREADY_RESPONDED", async () => {
  const created = await repo.createProjectRequest({
    buyerWorkspaceId: fixture.buyerWorkspace.id,
    sellerWorkspaceId: fixture.sellerWorkspace.id,
    serviceOfferingId: fixture.offering.id,
    projectBriefId: fixture.brief.id,
    createdByUserId: fixture.buyerUser.id,
  });
  const declined = await repo.declineProjectRequest({
    projectRequestId: created.id,
    sellerDecisionByUserId: fixture.sellerUser.id,
    now: clockNow,
  });
  assert.equal(declined.ok, true);
  const accepted = await repo.acceptProjectRequest({
    projectRequestId: created.id,
    sellerDecisionByUserId: fixture.sellerUser.id,
    now: clockNow,
  });
  assert.equal(accepted.ok, false);
  if (accepted.ok) return;
  assert.equal(accepted.reason, "ALREADY_RESPONDED");
  const dealCount = await prisma.deal.count({
    where: { projectRequestId: created.id },
  });
  assert.equal(dealCount, 0);
});
