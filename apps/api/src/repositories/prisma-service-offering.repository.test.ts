// PrismaServiceOfferingRepository integration tests (M2 #85).
//
// Background: ticket #85 acceptance criteria require the
// ServiceOffering repository to:
//   - persist a Draft row via `saveDraft` (lazy first-save / resume /
//     update) and reject the save when the existing row is not Draft.
//   - atomic Draft -> Active transition plus append-only
//     `ServiceOfferingActivation` evidence row insertion via `activate`.
//   - retry-idempotency convergence: same `idempotencyKey` returns the
//     already-persisted outcome without creating a second evidence row.
//   - DB unique constraint `(offeringId, idempotencyKey)` is the second
//     defense when a concurrent same-key request slips past the
//     pre-transaction check.
//   - listing and find-by-id are scoped to the owning Workspace.
//   - activation requires all functional fields; missing fields
//     surface as a typed repository error.
//   - audio sample count is exposed for the activation completeness
//     assertion.
//
// These tests run against the disposable PostgreSQL target via
// `pnpm db:test:reset`. They assert observable persisted outcomes only.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PrismaClient } from "@soundhub/db";
import { createTestPrismaClient } from "../lib/test-database.js";
import { PrismaServiceOfferingRepository } from "./prisma-service-offering.repository.js";
import {
  ServiceOfferingAlreadyPausedError,
  ServiceOfferingInvalidUpdateError,
  ServiceOfferingNotDraftError,
  ServiceOfferingNotFoundError,
  ServiceOfferingNotOwnedError,
  ServiceOfferingSellerProfileNotPublishedError,
  ServiceOfferingUpdateNotActiveError,
} from "./service-offering.repository.js";
import { SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS } from "@soundhub/types";
import { sellerProfileWorkspaceLockSql } from "./seller-profile-workspace-lock.js";

let prisma: PrismaClient;
let repo: PrismaServiceOfferingRepository;

const USER_ID = "user-85-prisma";
const WORKSPACE_ID = "ws-85-prisma-personal";
const EMAIL = "prisma-85@example.com";

interface Fixture {
  userId: string;
  workspaceId: string;
  sellerProfileId: string;
}

async function loadFixture(): Promise<Fixture> {
  // Ensure the canonical ServiceCategory + PricingUnit tables contain
  // the keys the tests reference. The seed populates the full
  // catalog; tests only need a small handful.
  await prisma.serviceCategory.upsert({
    where: { key: "music-production" },
    create: {
      key: "music-production",
      name: "Music production",
      bundleOnly: false,
    },
    update: {},
  });
  await prisma.pricingUnit.upsert({
    where: { key: "per-track" },
    create: { key: "per-track", name: "Per track" },
    update: {},
  });

  const user = await prisma.userAccount.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: EMAIL },
    update: { email: EMAIL },
  });

  const workspace = await prisma.workspace.upsert({
    where: { id: WORKSPACE_ID },
    create: {
      id: WORKSPACE_ID,
      slug: "ws-85-prisma-personal",
      name: "85 Prisma Personal",
      type: "Personal",
      status: "Active",
      ownerUserId: user.id,
    },
    update: { status: "Active" },
  });

  await prisma.workspaceMembership.upsert({
    where: {
      userId_workspaceId: { userId: user.id, workspaceId: workspace.id },
    },
    create: {
      userId: user.id,
      workspaceId: workspace.id,
      role: "Owner",
    },
    update: { role: "Owner" },
  });
  await prisma.workspaceCapability.upsert({
    where: {
      workspaceId_capability: {
        workspaceId: workspace.id,
        capability: "Seller",
      },
    },
    create: { workspaceId: workspace.id, capability: "Seller" },
    update: {},
  });

  const sellerProfile = await prisma.sellerProfile.upsert({
    where: { workspaceId: workspace.id },
    create: {
      workspaceId: workspace.id,
      professionalName: "85 Prisma Test",
      bio: "Test profile",
      status: "Published",
    },
    update: { status: "Published" },
  });

  return {
    userId: user.id,
    workspaceId: workspace.id,
    sellerProfileId: sellerProfile.id,
  };
}

async function seedOffering(input: {
  readonly id: string;
  readonly fixture: Fixture;
  readonly status?: "Draft" | "Active" | "Paused" | "Archived";
}) {
  return prisma.serviceOffering.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      slug: `${input.id}-slug`,
      sellerProfileId: input.fixture.sellerProfileId,
      title: "Test offering",
      description: "Test description",
      status: input.status ?? "Draft",
    },
    update: { status: input.status ?? "Draft" },
  });
}

const PLAYBACK = (input: { offeringId: string; sampleId: string }) =>
  `https://api.test/services/${input.offeringId}/samples/${input.sampleId}/play`;

async function cleanTestRows(): Promise<void> {
  await prisma.serviceOfferingAudioSample.deleteMany({
    where: { offering: { id: { startsWith: "of_test_" } } },
  });
  // M2 (#86, slice 86B): pause evidence rows must be cleaned alongside
  // activations so consecutive tests do not collide on the
  // (offeringId, idempotencyKey) unique index when they reuse the
  // same `idempotencyKey` constant.
  await prisma.serviceOfferingPause.deleteMany({
    where: { offeringId: { startsWith: "of_test_" } },
  });
  await prisma.serviceOfferingActivation.deleteMany({
    where: { offeringId: { startsWith: "of_test_" } },
  });
  // M2 (#86, slice 86C): update evidence rows are cleaned alongside
  // pause + activation rows so consecutive updateActive tests do not
  // collide on the (offeringId, idempotencyKey) unique index.
  await prisma.serviceOfferingUpdate.deleteMany({
    where: { offeringId: { startsWith: "of_test_" } },
  });
  await prisma.serviceOffering.deleteMany({
    where: { id: { startsWith: "of_test_" } },
  });
}

before(() => {
  prisma = createTestPrismaClient();
  repo = new PrismaServiceOfferingRepository(prisma);
});

after(async () => {
  await prisma?.$disconnect();
});

void test("saveDraft: a fresh Draft row persists the RELAXED payload (nullable primaryCategory/serviceMode allowed)", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_relaxed";
  await seedOffering({ id, fixture });
  const draft = await repo.saveDraft({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    title: "Draft title",
    description: "Draft desc",
    primaryCategoryKey: null,
    serviceMode: null,
    serviceAreas: [],
    pricing: null,
    genreTags: ["dancehall"],
    includedServiceCategoryKeys: [],
    playbackUrlFor: PLAYBACK,
    now: new Date(),
  });
  assert.equal(draft.title, "Draft title");
  assert.equal(draft.primaryCategoryKey, null);
  assert.equal(draft.serviceMode, null);
  assert.equal(draft.pricing, null);
});

void test("saveDraft: rejected with ServiceOfferingNotFoundError when no offering row exists", async () => {
  const fixture = await loadFixture();
  await assert.rejects(
    () =>
      repo.saveDraft({
        offeringId: "of_missing",
        workspaceId: fixture.workspaceId,
        title: "x",
        description: "x",
        primaryCategoryKey: null,
        serviceMode: null,
        serviceAreas: [],
        pricing: null,
        genreTags: [],
        includedServiceCategoryKeys: [],
        playbackUrlFor: PLAYBACK,
        now: new Date(),
      }),
    (err: unknown) => err instanceof ServiceOfferingNotFoundError,
  );
});

void test("saveDraft: rejected with ServiceOfferingNotDraftError when the offering is Active", async () => {
  const fixture = await loadFixture();
  const id = "of_test_active";
  await seedOffering({ id, fixture, status: "Active" });
  await assert.rejects(
    () =>
      repo.saveDraft({
        offeringId: id,
        workspaceId: fixture.workspaceId,
        title: "x",
        description: "x",
        primaryCategoryKey: null,
        serviceMode: null,
        serviceAreas: [],
        pricing: null,
        genreTags: [],
        includedServiceCategoryKeys: [],
        playbackUrlFor: PLAYBACK,
        now: new Date(),
      }),
    (err: unknown) => err instanceof ServiceOfferingNotDraftError,
  );
});

void test("activate: transitions Draft -> Active and inserts ONE ServiceOfferingActivation evidence row", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_activate";
  await seedOffering({ id, fixture });
  const category = await prisma.serviceCategory.findUnique({
    where: { key: "music-production" },
  });
  const unit = await prisma.pricingUnit.findUnique({
    where: { key: "per-track" },
  });
  assert.ok(category);
  assert.ok(unit);
  // Seed 1 live sample so activation completeness can succeed.
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  const idempotencyKey = "idempotency-1";
  const result = await repo.activate({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    sellerProfileId: fixture.sellerProfileId,
    activatedByUserId: fixture.userId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey,
    requestId: "req-1",
    playbackUrlFor: PLAYBACK,
    now: new Date(),
  });
  assert.equal(result.offering.status, "Active");
  assert.equal(result.evidence.confirmationVersion, "m2-service-activation-v1");
  const evidence = await prisma.serviceOfferingActivation.findUnique({
    where: {
      offeringId_idempotencyKey: { offeringId: id, idempotencyKey },
    },
  });
  assert.ok(evidence);
  assert.equal(evidence.activatedByUserId, fixture.userId);
});

void test("activate: same idempotencyKey converges on the existing evidence row (no duplicate insert)", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_idem";
  await seedOffering({ id, fixture });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  const idempotencyKey = "idempotency-2";
  const first = await repo.activate({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    sellerProfileId: fixture.sellerProfileId,
    activatedByUserId: fixture.userId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey,
    requestId: "req-1",
    playbackUrlFor: PLAYBACK,
    now: new Date(),
  });
  const second = await repo.activate({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    sellerProfileId: fixture.sellerProfileId,
    activatedByUserId: fixture.userId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey,
    requestId: "req-2",
    playbackUrlFor: PLAYBACK,
    now: new Date(),
  });
  assert.equal(first.evidence.idempotencyKey, second.evidence.idempotencyKey);
  // Exactly ONE evidence row exists for the (offeringId, idempotencyKey) tuple.
  const count = await prisma.serviceOfferingActivation.count({
    where: { offeringId: id, idempotencyKey },
  });
  assert.equal(count, 1);
});

void test("activate: rejected with ServiceOfferingNotOwnedError when the offering belongs to a different Workspace", async () => {
  const fixture = await loadFixture();
  const id = "of_test_other";
  await seedOffering({ id, fixture });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  await assert.rejects(
    () =>
      repo.activate({
        offeringId: id,
        workspaceId: "ws_other_workspace",
        sellerProfileId: fixture.sellerProfileId,
        activatedByUserId: fixture.userId,
        title: "x",
        description: "x",
        primaryCategoryKey: "music-production",
        serviceMode: "Remote",
        serviceAreas: [],
        pricing: {
          kind: "StartingAt",
          amountMinor: 60000,
          currency: "USD",
          unitId: "per-track",
        },
        genreTags: [],
        includedServiceCategoryKeys: [],
        confirmationVersion: "m2-service-activation-v1",
        idempotencyKey: "idempotency-3",
        requestId: "req-1",
        playbackUrlFor: PLAYBACK,
        now: new Date(),
      }),
    (err: unknown) => err instanceof ServiceOfferingNotOwnedError,
  );
});

void test("countLiveConfirmedSamples returns 0 for an offering with no audio samples", async () => {
  const fixture = await loadFixture();
  const id = "of_test_no_samples";
  await seedOffering({ id, fixture });
  const count = await repo.countLiveConfirmedSamples(id);
  assert.equal(count, 0);
});

// M2 (#86, slice 86B): pause / reactivate repository tests.
//
// These mirror the in-memory adapter tests in their intent — the
// Prisma adapter must produce the same observable outcomes. The
// advisory lock + idempotency pre-check + atomic transition + lookup-
// before-precondition rule all apply identically.

void test("pause: Active -> Paused flips the row's status and inserts ONE pause evidence row", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_pause_active";
  await seedOffering({ id, fixture, status: "Active" });
  const idempotencyKey = "idempotency-pause-1";
  const result = await repo.pause({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    pausedByUserId: fixture.userId,
    reason: "user_initiated",
    idempotencyKey,
    requestId: "req-1",
    now: new Date("2026-09-27T13:00:00.000Z"),
    playbackUrlFor: PLAYBACK,
  });
  assert.equal(result.convergedFromExistingPause, false);
  assert.equal(result.offering.status, "Paused");
  assert.equal(result.evidence.reason, "user_initiated");
  const evidence = await prisma.serviceOfferingPause.findUnique({
    where: { offeringId_idempotencyKey: { offeringId: id, idempotencyKey } },
  });
  assert.ok(evidence);
  assert.equal(evidence.pausedByUserId, fixture.userId);
  assert.equal(evidence.reason, "user_initiated");
});

void test("pause: same-key retry converges on the existing pause row (no duplicate insert)", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_pause_idem";
  await seedOffering({ id, fixture, status: "Active" });
  const idempotencyKey = "idempotency-pause-idem";
  const first = await repo.pause({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    pausedByUserId: fixture.userId,
    reason: "user_initiated",
    idempotencyKey,
    requestId: "req-1",
    now: new Date("2026-09-27T13:00:00.000Z"),
    playbackUrlFor: PLAYBACK,
  });
  const second = await repo.pause({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    pausedByUserId: fixture.userId,
    reason: "user_initiated",
    idempotencyKey,
    requestId: "req-2",
    now: new Date("2026-09-27T14:00:00.000Z"),
    playbackUrlFor: PLAYBACK,
  });
  assert.equal(second.convergedFromExistingPause, true);
  assert.deepEqual(second.evidence, first.evidence);
});

void test("pause: different-key on Paused throws ServiceOfferingAlreadyPausedError", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_pause_already";
  await seedOffering({ id, fixture, status: "Active" });
  await repo.pause({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    pausedByUserId: fixture.userId,
    reason: "user_initiated",
    idempotencyKey: "idempotency-pause-1",
    requestId: "req-1",
    now: new Date(),
    playbackUrlFor: PLAYBACK,
  });
  await assert.rejects(
    repo.pause({
      offeringId: id,
      workspaceId: fixture.workspaceId,
      pausedByUserId: fixture.userId,
      reason: "user_initiated",
      idempotencyKey: "idempotency-pause-2-different",
      requestId: "req-2",
      now: new Date(),
      playbackUrlFor: PLAYBACK,
    }),
    (err: unknown) => err instanceof ServiceOfferingAlreadyPausedError,
  );
});

void test("pause: a Draft offering throws ServiceOfferingNotActiveError with currentStatus=Draft", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_pause_draft";
  await seedOffering({ id, fixture, status: "Draft" });
  await assert.rejects(
    repo.pause({
      offeringId: id,
      workspaceId: fixture.workspaceId,
      pausedByUserId: fixture.userId,
      reason: "user_initiated",
      idempotencyKey: "idempotency-pause-draft",
      requestId: "req-1",
      now: new Date(),
      playbackUrlFor: PLAYBACK,
    }),
    (err: unknown) => {
      const e = err as { name?: string; currentStatus?: string };
      assert.equal(e.name, "ServiceOfferingNotActiveError");
      assert.equal(e.currentStatus, "Draft");
      return true;
    },
  );
});

void test("pause: a missing offering throws ServiceOfferingNotFoundError", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  await assert.rejects(
    repo.pause({
      offeringId: "of_test_pause_missing",
      workspaceId: fixture.workspaceId,
      pausedByUserId: fixture.userId,
      reason: "user_initiated",
      idempotencyKey: "idempotency-pause-missing",
      requestId: "req-1",
      now: new Date(),
      playbackUrlFor: PLAYBACK,
    }),
    (err: unknown) => err instanceof ServiceOfferingNotFoundError,
  );
});

void test("pause: cross-workspace throws ServiceOfferingNotOwnedError", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_pause_cross";
  await seedOffering({ id, fixture, status: "Active" });
  await assert.rejects(
    repo.pause({
      offeringId: id,
      workspaceId: "ws_some_other_workspace",
      pausedByUserId: fixture.userId,
      reason: "user_initiated",
      idempotencyKey: "idempotency-pause-cross",
      requestId: "req-1",
      now: new Date(),
      playbackUrlFor: PLAYBACK,
    }),
    (err: unknown) => err instanceof ServiceOfferingNotOwnedError,
  );
});

void test("pause: persists the reason enum verbatim (final_sample_removal path)", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_pause_reason";
  await seedOffering({ id, fixture, status: "Active" });
  const result = await repo.pause({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    pausedByUserId: fixture.userId,
    reason: "final_sample_removal",
    idempotencyKey: "idempotency-pause-reason",
    requestId: "req-1",
    now: new Date(),
    playbackUrlFor: PLAYBACK,
  });
  assert.equal(result.evidence.reason, "final_sample_removal");
  const evidence = await prisma.serviceOfferingPause.findUnique({
    where: {
      offeringId_idempotencyKey: { offeringId: id, idempotencyKey: "idempotency-pause-reason" },
    },
  });
  assert.equal(evidence?.reason, "final_sample_removal");
});

void test("reactivate: Paused -> Active flips status, inserts ONE new activation row, preserves existing activation rows", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_reactivate";
  await seedOffering({ id, fixture, status: "Paused" });
  // Seed a CONFIRMED Live sample so activation completeness can pass.
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  const idempotencyKey = "idempotency-reactivate-1";
  const result = await repo.reactivate({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    reactivatedByUserId: fixture.userId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey,
    requestId: "req-1",
    playbackUrlFor: PLAYBACK,
    now: new Date("2026-09-27T13:00:00.000Z"),
  });
  assert.equal(result.convergedFromExistingActivation, false);
  assert.equal(result.offering.status, "Active");
  const evidence = await prisma.serviceOfferingActivation.findUnique({
    where: { offeringId_idempotencyKey: { offeringId: id, idempotencyKey } },
  });
  assert.ok(evidence);
  assert.equal(evidence.activatedByUserId, fixture.userId);
});

void test("reactivate: same-key retry converges on the existing activation row", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_reactivate_idem";
  await seedOffering({ id, fixture, status: "Paused" });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  const idempotencyKey = "idempotency-reactivate-idem";
  const first = await repo.reactivate({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    reactivatedByUserId: fixture.userId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey,
    requestId: "req-1",
    playbackUrlFor: PLAYBACK,
    now: new Date(),
  });
  const second = await repo.reactivate({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    reactivatedByUserId: fixture.userId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey,
    requestId: "req-2",
    playbackUrlFor: PLAYBACK,
    now: new Date(),
  });
  assert.equal(second.convergedFromExistingActivation, true);
  assert.deepEqual(second.evidence, first.evidence);
});

void test("reactivate: an Active offering throws ServiceOfferingNotPausedError with currentStatus=Active", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_reactivate_active";
  await seedOffering({ id, fixture, status: "Active" });
  await assert.rejects(
    repo.reactivate({
      offeringId: id,
      workspaceId: fixture.workspaceId,
      reactivatedByUserId: fixture.userId,
      title: "Haitian dancehall production",
      description: "Description",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: {
        kind: "StartingAt",
        amountMinor: 60000,
        currency: "USD",
        unitId: "per-track",
      },
      genreTags: [],
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "idempotency-reactivate-active",
      requestId: "req-1",
      playbackUrlFor: PLAYBACK,
      now: new Date(),
    }),
    (err: unknown) => {
      const e = err as { name?: string; currentStatus?: string };
      assert.equal(e.name, "ServiceOfferingNotPausedError");
      assert.equal(e.currentStatus, "Active");
      return true;
    },
  );
});

void test("reactivate: no CONFIRMED Live samples throws ServiceOfferingIncompleteError carrying samples_required", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_reactivate_no_samples";
  await seedOffering({ id, fixture, status: "Paused" });
  // No CONFIRMED Live sample — the activation completeness recheck
  // must produce the samples_required field error.
  await assert.rejects(
    repo.reactivate({
      offeringId: id,
      workspaceId: fixture.workspaceId,
      reactivatedByUserId: fixture.userId,
      title: "Haitian dancehall production",
      description: "Description",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: {
        kind: "StartingAt",
        amountMinor: 60000,
        currency: "USD",
        unitId: "per-track",
      },
      genreTags: [],
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "idempotency-reactivate-no-samples",
      requestId: "req-1",
      playbackUrlFor: PLAYBACK,
      now: new Date(),
    }),
    (err: unknown) => {
      const e = err as { name?: string; fieldErrors?: Array<{ path: string; code: string }> };
      assert.equal(e.name, "ServiceOfferingIncompleteError");
      assert.ok(
        e.fieldErrors?.some((f) => f.path === "samples" && f.code === "samples_required"),
        "IncompleteError must carry the samples_required field error",
      );
      return true;
    },
  );
});

void test("listForOwner returns only offerings owned by the target Workspace", async () => {
  const fixture = await loadFixture();
  // Cleanly delete any prior test offerings (and their dependent
  // activation rows / pricing rows) so the list assertion can
  // assert a known starting state. Cascade via raw SQL keeps the
  // dependent rows out of the way.
  await prisma.$executeRawUnsafe(
    `DELETE FROM "service_offering_activations" WHERE "offeringId" LIKE 'of_test_list_%'`,
  );
  await prisma.serviceOffering.deleteMany({
    where: { id: { startsWith: "of_test_list_" } },
  });
  await seedOffering({ id: "of_test_list_a", fixture });
  await seedOffering({ id: "of_test_list_b", fixture });
  const list = await repo.listForOwner({
    workspaceId: fixture.workspaceId,
    playbackUrlFor: PLAYBACK,
  });
  const ids = list.map((row) => row.serviceOfferingId);
  assert.ok(ids.includes("of_test_list_a"));
  assert.ok(ids.includes("of_test_list_b"));
});

// Phase 2 #85 Manual QA Round 9 — pricing unit hydration bug.
//
// The Prisma FK column `ServiceOfferingPricing.unitId` stores the
// internal `PricingUnit.id` (cuid), but the activation payload
// and the editor's <option value> both use the public
// `PricingUnit.key`. The OwnerView's `pricing.unitId` must
// surface `unit.key` (not the FK cuid) so the editor's resumed
// select hydrates to the saved unit. The DTO schema
// (`z.string().min(1).max(64)`) is unchanged — only the resolved
// value differs.
void test("OwnerView pricing.unitId surfaces the public PricingUnit.key, not the internal FK cuid (resume hydration)", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_unit_hydration";
  await seedOffering({ id, fixture });
  // Seed a sample so activation completeness can succeed.
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS[0],
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  const category = await prisma.serviceCategory.findUnique({
    where: { key: "music-production" },
  });
  const unit = await prisma.pricingUnit.findUnique({
    where: { key: "per-track" },
  });
  assert.ok(category);
  assert.ok(unit);
  const result = await repo.activate({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    sellerProfileId: fixture.sellerProfileId,
    activatedByUserId: fixture.userId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey: `unit-hydration-${id}`,
    requestId: `req-unit-hydration-${id}`,
    playbackUrlFor: PLAYBACK,
    now: new Date(),
  });
  // Sanity: the FK in the DB row is the cuid (NOT the public
  // key). This is the existing persistence shape and must NOT
  // be changed by the Round 9 fix.
  const dbRow = await prisma.serviceOfferingPricing.findUnique({
    where: { offeringId: id },
  });
  assert.ok(dbRow);
  assert.equal(dbRow.unitId, unit.id, "DB persists the cuid (internal FK) — unchanged by Round 9");
  // The OwnerView's `pricing.unitId` MUST surface the public
  // key (`per-track`), NOT the cuid. This is what makes the
  // editor's resumed <option value={u.key}> match and the
  // select render the saved unit.
  assert.ok(result.offering.pricing, "OwnerView.pricing must be present after activation");
  assert.equal(
    result.offering.pricing.unitId,
    "per-track",
    "OwnerView.pricing.unitId must surface the public PricingUnit.key so the editor's resumed select hydrates to the saved unit",
  );
  assert.notEqual(
    result.offering.pricing.unitId,
    unit.id,
    "OwnerView.pricing.unitId must NOT leak the internal FK cuid",
  );
});

void test("Draft resume via saveDraft + findForOwner preserves the public PricingUnit.key in OwnerView.pricing.unitId", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_draft_unit_hydration";
  await seedOffering({ id, fixture });
  await repo.saveDraft({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    now: new Date(),
    playbackUrlFor: PLAYBACK,
  });
  // findForOwner is the read path the editor bootstrap uses
  // on resume.
  const owner = await repo.findForOwner({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    playbackUrlFor: PLAYBACK,
  });
  assert.ok(owner, "findForOwner must return the Draft row");
  assert.ok(owner.pricing, "OwnerView.pricing must be present after Draft save");
  assert.equal(
    owner.pricing.unitId,
    "per-track",
    "Draft resume must surface the public PricingUnit.key (per-track), not the FK cuid",
  );
});

// Codex/Tenki Blocker 1 — idempotent activation retry must
// surface the SAME valid owner-view sample playback URLs as the
// successful first activation path.
//
// The previous retry branch called `toOwnerView` without the
// `playbackUrlFor` resolver; the helper's `?? ""` fallback then
// produced an empty-string `playbackUrl` per sample, which
// fails the `z.string().url()` schema on
// `serviceOfferingOwnerViewV1Schema` and surfaces as a 500
// even though activation already succeeded. This test
// reproduces that exact sequence at the real repository
// boundary so a future regression that drops the resolver on
// the retry path fails this suite.
void test("idempotent activation retry returns a valid sample playbackUrl (the retry cannot 500)", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_retry_playback";
  await seedOffering({ id, fixture });

  // Seed a CONFIRMED Live sample so the activation
  // completeness check (which requires ≥ 1 sample) passes.
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Retry Demo",
      contentType: "audio/mpeg",
      byteSize: 4096,
      displayOrder: 1,
      storageRef: "ref://retry-demo",
      cleanupStatus: "Live",
      confirmationVersion: SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS[0],
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });

  const idempotencyKey = "00000000-0000-4000-8000-000000000001";
  const requestId = `req-retry-playback-${id}`;
  const baseInput = {
    offeringId: id,
    workspaceId: fixture.workspaceId,
    sellerProfileId: fixture.sellerProfileId,
    activatedByUserId: fixture.userId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote" as const,
    serviceAreas: [],
    pricing: {
      kind: "StartingAt" as const,
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1" as const,
    idempotencyKey,
    requestId,
    playbackUrlFor: PLAYBACK,
    now: new Date(),
  };

  // First activation: creates the ServiceOfferingActivation
  // evidence row and transitions Draft → Active.
  const first = await repo.activate(baseInput);
  assert.equal(first.convergedFromExistingActivation, false);
  assert.equal(first.offering.status, "Active");
  assert.equal(first.offering.samples.length, 1, "first activation must surface the seeded sample");
  assert.notEqual(
    first.offering.samples[0]?.playbackUrl,
    "",
    "first activation must surface a non-empty playbackUrl",
  );
  // z.string().url() — round-trip through the runtime URL
  // parser proves the value satisfies the DTO schema's URL
  // invariant (not just a non-empty string).
  assert.doesNotThrow(
    () => new URL(first.offering.samples[0]!.playbackUrl),
    "first activation playbackUrl must parse as a URL",
  );

  // Idempotent retry: same offeringId + same idempotencyKey.
  // The pre-check converges on the existing activation row.
  const retry = await repo.activate(baseInput);
  assert.equal(retry.convergedFromExistingActivation, true);
  assert.equal(retry.offering.status, "Active");
  assert.deepEqual(retry.evidence, first.evidence);
  // The retry MUST surface the same non-empty, URL-valid
  // playbackUrl per sample (this is what the route response
  // validates against `z.string().url()`).
  assert.equal(retry.offering.samples.length, 1, "retry must surface the seeded sample");
  const retryPlaybackUrl = retry.offering.samples[0]?.playbackUrl;
  assert.ok(retryPlaybackUrl, "retry must surface a non-empty playbackUrl");
  assert.notEqual(retryPlaybackUrl, "", "retry playbackUrl must NOT be the empty-string fallback");
  assert.doesNotThrow(
    () => new URL(retryPlaybackUrl),
    "retry playbackUrl must parse as a URL (z.string().url() invariant)",
  );
  assert.equal(
    retryPlaybackUrl,
    first.offering.samples[0]?.playbackUrl,
    "retry must surface the SAME playbackUrl as the first activation",
  );

  // No duplicate activation evidence row — the (offeringId,
  // idempotencyKey) unique index converged on the first row.
  const evidenceCount = await prisma.serviceOfferingActivation.count({
    where: { offeringId: id },
  });
  assert.equal(
    evidenceCount,
    1,
    "idempotent retry must not insert a duplicate activation evidence row",
  );

  // Round-trip through the actual activation RESPONSE schema
  // (the route layer) after the service-layer Date→ISOString
  // conversion that `toResponseOwnerView` performs. If
  // `playbackUrl` were empty (or any other field malformed),
  // `serviceOfferingActivationResponseV1Schema.parse` would
  // throw — this is the exact failure mode that would surface
  // as a 500 in production.
  const { serviceOfferingActivationResponseV1Schema } = await import("@soundhub/types");
  const response = {
    ok: true as const,
    offering: {
      ...retry.offering,
      activatedAt: retry.offering.activatedAt ? retry.offering.activatedAt.toISOString() : null,
    },
    evidence: {
      ...retry.evidence,
      activatedAt: retry.evidence.activatedAt.toISOString(),
    },
    returnTo: null,
    safeReturnTo: null,
  };
  assert.doesNotThrow(
    () => serviceOfferingActivationResponseV1Schema.parse(response),
    "idempotent activation retry response must parse through serviceOfferingActivationResponseV1Schema (would otherwise 500)",
  );
});

// M2 (#86, slice 86B, Codex review fix): direct repository
// coverage that proves the new behaviors land at the repository
// boundary (where the application-level contract is enforced).

void test("repository: pause on an Active offering with a CONFIRMED Live sample returns a usable playbackUrl", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_pause_e2e";
  await seedOffering({ id, fixture, status: "Active" });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  const result = await repo.pause({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    pausedByUserId: fixture.userId,
    reason: "user_initiated",
    idempotencyKey: "11111111-2222-3333-4444-eeeeeeeeeeee",
    requestId: "req-e2e-pause-1",
    now: new Date(),
    playbackUrlFor: PLAYBACK,
  });
  assert.equal(result.offering.status, "Paused");
  assert.equal(result.offering.samples.length, 1);
  // M2 (#86, slice 86B, Codex review fix): the response's
  // playbackUrl must be a valid URL — the empty-string fallback would
  // fail the response Zod schema and turn a committed Pause into a 500.
  assert.match(result.offering.samples[0]?.playbackUrl ?? "", /^https:\/\/api\.test\//);
});

void test("repository: reactivate on a Paused offering where SellerProfile becomes Suspended inside the transaction throws ServiceOfferingSellerProfileNotPublishedError", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_reactivate_pub";
  await seedOffering({ id, fixture, status: "Paused" });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  // Suspend the profile BEFORE the Reactivate call — the repository
  // re-checks the publication status inside the transaction.
  await prisma.sellerProfile.update({
    where: { id: fixture.sellerProfileId },
    data: { status: "Suspended" },
  });
  await assert.rejects(
    repo.reactivate({
      offeringId: id,
      workspaceId: fixture.workspaceId,
      reactivatedByUserId: fixture.userId,
      title: "Haitian dancehall production",
      description: "Description",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: {
        kind: "StartingAt",
        amountMinor: 60000,
        currency: "USD",
        unitId: "per-track",
      },
      genreTags: [],
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "11111111-2222-3333-4444-ffffffffffff",
      requestId: "req-reactivate-pub",
      now: new Date(),
      playbackUrlFor: PLAYBACK,
    }),
    (err: unknown) => {
      return err instanceof ServiceOfferingSellerProfileNotPublishedError;
    },
  );
  // The offering must remain Paused after a rejected Reactivate.
  const after = await prisma.serviceOffering.findUnique({ where: { id } });
  assert.equal(after?.status, "Paused");
});

void test("repository: a same-key Reactivate retry converges regardless of current SellerProfile status (idempotency lookup runs before publication check)", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_reactivate_idem_pub";
  await seedOffering({ id, fixture, status: "Paused" });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  const idempotencyKey = "11111111-2222-3333-4444-aaaaaaaaaaaa";
  // First Reactivate succeeds (profile is Published by default).
  const first = await repo.reactivate({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    reactivatedByUserId: fixture.userId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey,
    requestId: "req-reactivate-idem-1",
    now: new Date(),
    playbackUrlFor: PLAYBACK,
  });
  assert.equal(first.offering.status, "Active");
  // Suspend the profile AFTER the Reactivate succeeded; a same-key
  // retry must still converge on the existing activation row.
  await prisma.sellerProfile.update({
    where: { id: fixture.sellerProfileId },
    data: { status: "Suspended" },
  });
  const second = await repo.reactivate({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    reactivatedByUserId: fixture.userId,
    title: "Haitian dancehall production",
    description: "Description",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 60000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey,
    requestId: "req-reactivate-idem-2",
    now: new Date(),
    playbackUrlFor: PLAYBACK,
  });
  assert.equal(second.offering.status, "Active");
  assert.equal(second.convergedFromExistingActivation, true);
  // The activation evidence row is the same one (no duplicate insert).
  const evidence = await prisma.serviceOfferingActivation.findMany({
    where: { offeringId: id, idempotencyKey },
  });
  assert.equal(evidence.length, 1);
});

// M2 (#86, slice 86B Codex re-review): deterministic
// interleaving test for the Reactivate publication-check race.
// The previous test (`reactivate on a Paused offering where
// SellerProfile becomes Suspended inside the transaction`) suspended
// the profile BEFORE Reactivate, which does not exercise the
// interleaving this race requires. The new test holds the
// `seller-profile:<workspaceId>` advisory lock from a separate
// transaction, suspends the profile inside that same transaction,
// and only releases the lock after a fixed delay. Reactivate MUST
// block on the same advisory lock until the suspension commits
// atomically with the lock release, then read the post-suspend
// state and throw `ServiceOfferingSellerProfileNotPublishedError`.
// If Reactivate were NOT acquiring the workspaceLock, the
// publication-status SELECT would return the pre-suspend
// `Published` state and the offering would commit Active against a
// profile that was concurrently demoted to Suspended.
void test("repository: a concurrent SellerProfile suspension that holds the same workspaceLock commits BEFORE Reactivate's publication read (deterministic interleaving)", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_reactivate_lock_race";
  await seedOffering({ id, fixture, status: "Paused" });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  // The blocker transaction holds the seller-profile
  // workspaceLock AND suspends the profile inside the SAME
  // transaction. Because the suspend and the lock release
  // happen at COMMIT time, Reactivate MUST observe the post-
  // suspend state when it acquires the lock after the blocker
  // releases.
  let blockerRelease: () => void = () => {};
  const blockerDone = new Promise<void>((resolve) => {
    blockerRelease = resolve;
  });
  const blocker = prisma.$transaction(async (tx) => {
    await tx.$executeRaw(sellerProfileWorkspaceLockSql(fixture.workspaceId));
    await tx.sellerProfile.update({
      where: { id: fixture.sellerProfileId },
      data: { status: "Suspended" },
    });
    // Wait for the test harness to signal release. While we wait
    // the workspaceLock remains held AND the suspend is staged
    // in this transaction (visible only after COMMIT).
    await blockerDone;
  });

  // Wait briefly so the blocker is guaranteed to have acquired
  // the workspaceLock. 100ms is generous; the lock acquisition
  // is a single round-trip and finishes in well under 10ms in
  // any sane environment.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  // Start Reactivate. It will block at the workspaceLock
  // acquisition. Record the start time so we can assert that
  // Reactivate blocked (elapsed >= ~200ms) rather than reading
  // the pre-suspend Published state in <50ms.
  const reactivateStart = Date.now();
  const reactivateOutcome = repo
    .reactivate({
      offeringId: id,
      workspaceId: fixture.workspaceId,
      reactivatedByUserId: fixture.userId,
      title: "Haitian dancehall production",
      description: "Description",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: {
        kind: "StartingAt",
        amountMinor: 60000,
        currency: "USD",
        unitId: "per-track",
      },
      genreTags: [],
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "11111111-2222-3333-4444-cccccccccccc",
      requestId: "req-reactivate-lock-race",
      now: new Date(),
      playbackUrlFor: PLAYBACK,
    })
    .then(
      (r) => ({ ok: true as const, result: r }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

  // Hold the blocker for a long enough interval that Reactivate
  // is GUARANTEED to be parked at the workspaceLock acquisition
  // when we release. 500ms is generous — even on slow CI the
  // workspaceLock acquisition is a single round-trip (<10ms).
  // Without the workspaceLock in Reactivate, the SELECT below
  // would return the pre-suspend `Published` state in <50ms and
  // Reactivate would commit Active in well under 100ms total —
  // far below the 450ms threshold asserted below.
  const waitForRelease = 500;
  await new Promise<void>((resolve) => setTimeout(resolve, waitForRelease));
  blockerRelease();
  await blocker.catch(() => undefined);

  const outcome = await reactivateOutcome;
  const elapsed = Date.now() - reactivateStart;
  assert.equal(
    outcome.ok,
    false,
    "Reactivate must reject with ServiceOfferingSellerProfileNotPublishedError when the workspaceLock blocker suspended the profile",
  );
  assert.ok(
    outcome.error instanceof ServiceOfferingSellerProfileNotPublishedError,
    `Expected ServiceOfferingSellerProfileNotPublishedError, got ${outcome.error instanceof Error ? outcome.error.constructor.name : typeof outcome.error}`,
  );
  // The 450ms lower bound proves Reactivate BLOCKED on the
  // workspaceLock acquisition for the full 500ms the blocker held
  // it (the elapsed timer starts AFTER the first 100ms wait so the
  // remaining block period is ~500ms). Without the workspaceLock
  // in Reactivate, the publication-status SELECT would return
  // immediately (the blocker does not affect a non-locked read in
  // READ COMMITTED until the suspend COMMITs) and Reactivate would
  // complete in well under 100ms — committing Active against a
  // profile that was concurrently demoted to Suspended.
  assert.ok(
    elapsed >= 450,
    `Reactivate must have blocked on the workspaceLock; elapsed=${elapsed}ms`,
  );
  // The offering row must still be Paused — the rejected
  // Reactivate rolled back the activation write.
  const after = await prisma.serviceOffering.findUnique({ where: { id } });
  assert.equal(after?.status, "Paused");
  // The profile row must be Suspended — the blocker's COMMIT
  // applied the suspend.
  const profile = await prisma.sellerProfile.findUnique({
    where: { id: fixture.sellerProfileId },
  });
  assert.equal(profile?.status, "Suspended");
});

// =============================================================================
// M2 (#86, slice 86C): direct repository coverage for the Active → Active
// `updateActive` command. These tests assert the durable persistence and
// atomicity invariants that the slice plan commits to: the public field
// set is replaced atomically, the activation timestamp is preserved
// verbatim (the activations table is NOT touched), the (offeringId,
// idempotencyKey) unique index converges same-key retries, and the
// SellerProfile.published precondition serializes against concurrent
// suspensions via the workspaceLock from slice 86B re-review.
// =============================================================================

void test("repository: updateActive on an Active offering with a CONFIRMED Live sample replaces the public fields and preserves the activation timestamp", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_update_active_e2e";
  await seedOffering({ id, fixture, status: "Active" });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  const result = await repo.updateActive({
    offeringId: id,
    workspaceId: fixture.workspaceId,
    updatedByUserId: fixture.userId,
    title: "Updated title after slice 86C",
    description: "Updated description.",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: {
      kind: "StartingAt",
      amountMinor: 75000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: ["dancehall"],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey: "22222222-3333-4444-5555-666666666661",
    requestId: "req-update-active-1",
    now: new Date(),
    playbackUrlFor: PLAYBACK,
  });
  assert.equal(result.convergedFromExistingUpdate, false);
  assert.equal(result.offering.status, "Active");
  // Lifecycle did NOT change (slice 86C invariant).
  assert.equal(result.offering.status, "Active");
  // Public fields were replaced atomically.
  assert.equal(result.offering.title, "Updated title after slice 86C");
  assert.equal(result.offering.description, "Updated description.");
  // Evidence shape (no `activatedAt` — that lives on the activation
  // row, which Update never touches).
  assert.equal(result.evidence.confirmationVersion, "m2-service-activation-v1");
  assert.equal(result.evidence.idempotencyKey, "22222222-3333-4444-5555-666666666661");

  // One new ServiceOfferingUpdate row was written.
  const updates = await prisma.serviceOfferingUpdate.findMany({
    where: { offeringId: id, idempotencyKey: "22222222-3333-4444-5555-666666666661" },
  });
  assert.equal(updates.length, 1);

  // Zero new ServiceOfferingActivation rows were written — the
  // activation history is preserved verbatim.
  const activations = await prisma.serviceOfferingActivation.findMany({
    where: { offeringId: id },
  });
  assert.equal(
    activations.length,
    0,
    "updateActive must NOT write to service_offering_activations",
  );
});

void test("repository: updateActive same-key retry converges on the existing update row", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_update_active_idem";
  await seedOffering({ id, fixture, status: "Active" });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  const idempotencyKey = "22222222-3333-4444-5555-666666666662";
  const baseInput = {
    offeringId: id,
    workspaceId: fixture.workspaceId,
    updatedByUserId: fixture.userId,
    title: "Updated title",
    description: "Updated description.",
    primaryCategoryKey: "music-production" as const,
    serviceMode: "Remote" as const,
    serviceAreas: [],
    pricing: {
      kind: "StartingAt" as const,
      amountMinor: 75000,
      currency: "USD",
      unitId: "per-track",
    },
    genreTags: ["dancehall"],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1" as const,
    idempotencyKey,
    requestId: "req-update-active-idem",
    playbackUrlFor: PLAYBACK,
    now: new Date(),
  };
  const first = await repo.updateActive(baseInput);
  assert.equal(first.convergedFromExistingUpdate, false);

  const retry = await repo.updateActive(baseInput);
  assert.equal(retry.convergedFromExistingUpdate, true);
  assert.deepEqual(retry.evidence, first.evidence);

  // No duplicate update row — the unique index converged on the
  // first row.
  const updateCount = await prisma.serviceOfferingUpdate.count({
    where: { offeringId: id },
  });
  assert.equal(updateCount, 1, "idempotent update retry must not insert a duplicate update row");
});

void test("repository: updateActive on a Paused offering throws ServiceOfferingUpdateNotActiveError", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_update_paused";
  await seedOffering({ id, fixture, status: "Paused" });
  await assert.rejects(
    repo.updateActive({
      offeringId: id,
      workspaceId: fixture.workspaceId,
      updatedByUserId: fixture.userId,
      title: "Updated title",
      description: "Updated description.",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: {
        kind: "StartingAt",
        amountMinor: 75000,
        currency: "USD",
        unitId: "per-track",
      },
      genreTags: [],
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "22222222-3333-4444-5555-666666666663",
      requestId: "req-update-paused",
      now: new Date(),
      playbackUrlFor: PLAYBACK,
    }),
    (err: unknown) => {
      return err instanceof ServiceOfferingUpdateNotActiveError;
    },
  );
  // The offering row is still Paused — the rejected Update rolled
  // back the status check (no activation occurred).
  const after = await prisma.serviceOffering.findUnique({ where: { id } });
  assert.equal(after?.status, "Paused");
});

void test("repository: updateActive with unpublished SellerProfile throws ServiceOfferingSellerProfileNotPublishedError", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_update_unpub";
  await seedOffering({ id, fixture, status: "Active" });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  // Suspend the SellerProfile BEFORE the Update call — the
  // repository re-checks publication inside the transaction.
  await prisma.sellerProfile.update({
    where: { id: fixture.sellerProfileId },
    data: { status: "Suspended" },
  });
  await assert.rejects(
    repo.updateActive({
      offeringId: id,
      workspaceId: fixture.workspaceId,
      updatedByUserId: fixture.userId,
      title: "Updated title",
      description: "Updated description.",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: {
        kind: "StartingAt",
        amountMinor: 75000,
        currency: "USD",
        unitId: "per-track",
      },
      genreTags: [],
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "22222222-3333-4444-5555-666666666664",
      requestId: "req-update-unpub",
      now: new Date(),
      playbackUrlFor: PLAYBACK,
    }),
    (err: unknown) => {
      return err instanceof ServiceOfferingSellerProfileNotPublishedError;
    },
  );
  // The offering remains Active (Update never wrote status; the
  // rejected Update rolled back the field-set write).
  const after = await prisma.serviceOffering.findUnique({ where: { id } });
  assert.equal(after?.status, "Active");
});

void test("repository: updateActive with no CONFIRMED Live samples throws ServiceOfferingInvalidUpdateError", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_update_no_samples";
  await seedOffering({ id, fixture, status: "Active" });
  // No sample is seeded — the offering has zero CONFIRMED Live
  // samples, so the repository's completeness recheck throws.
  await assert.rejects(
    repo.updateActive({
      offeringId: id,
      workspaceId: fixture.workspaceId,
      updatedByUserId: fixture.userId,
      title: "Updated title",
      description: "Updated description.",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: {
        kind: "StartingAt",
        amountMinor: 75000,
        currency: "USD",
        unitId: "per-track",
      },
      genreTags: [],
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "22222222-3333-4444-5555-666666666665",
      requestId: "req-update-no-samples",
      now: new Date(),
      playbackUrlFor: PLAYBACK,
    }),
    (err: unknown) => {
      if (!(err instanceof ServiceOfferingInvalidUpdateError)) return false;
      const e = err as unknown as {
        fieldErrors: Array<{ path: string; code: string }>;
      };
      return e.fieldErrors.some((f) => f.path === "samples" && f.code === "samples_required");
    },
  );
});

void test("repository: updateActive failure preserves the prior public state (no field changes committed)", async () => {
  const fixture = await loadFixture();
  await cleanTestRows();
  const id = "of_test_update_rollback";
  await seedOffering({ id, fixture, status: "Active" });
  await prisma.serviceOfferingAudioSample.create({
    data: {
      offeringId: id,
      label: "Demo",
      contentType: "audio/mpeg",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://demo",
      cleanupStatus: "Live",
      confirmationVersion: "m2-audio-confirmation-v1",
      confirmedByUserId: fixture.userId,
      confirmedAt: new Date(),
    },
  });
  // Capture the prior public state.
  const before = await prisma.serviceOffering.findUnique({ where: { id } });
  const beforeTitle = before?.title;
  const beforeDescription = before?.description;
  // Update with a missing primaryCategoryKey triggers the
  // completeness recheck and rolls back the transaction.
  await assert.rejects(
    repo.updateActive({
      offeringId: id,
      workspaceId: fixture.workspaceId,
      updatedByUserId: fixture.userId,
      title: "MUTATED title that should NOT commit",
      description: "MUTATED description that should NOT commit",
      primaryCategoryKey: "",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: {
        kind: "StartingAt",
        amountMinor: 75000,
        currency: "USD",
        unitId: "per-track",
      },
      genreTags: [],
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "22222222-3333-4444-5555-666666666666",
      requestId: "req-update-rollback",
      now: new Date(),
      playbackUrlFor: PLAYBACK,
    }),
    (err: unknown) => err instanceof ServiceOfferingInvalidUpdateError,
  );
  const after = await prisma.serviceOffering.findUnique({ where: { id } });
  assert.equal(after?.title, beforeTitle, "prior title must be preserved on rejected Update");
  assert.equal(
    after?.description,
    beforeDescription,
    "prior description must be preserved on rejected Update",
  );
  assert.equal(after?.status, "Active");
  // No update evidence row was inserted.
  const updateCount = await prisma.serviceOfferingUpdate.count({
    where: { offeringId: id },
  });
  assert.equal(updateCount, 0, "rejected Update must NOT insert an update evidence row");
});
