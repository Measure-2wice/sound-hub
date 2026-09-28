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
  ServiceOfferingNotDraftError,
  ServiceOfferingNotFoundError,
  ServiceOfferingNotOwnedError,
} from "./service-offering.repository.js";
import { SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS } from "@soundhub/types";

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
  await prisma.serviceOfferingActivation.deleteMany({
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
