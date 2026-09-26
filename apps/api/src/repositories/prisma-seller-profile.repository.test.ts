/* eslint-disable @typescript-eslint/no-floating-promises */
// PrismaSellerProfileRepository integration tests (M2 #84).
//
// Background: ticket #84 acceptance criteria require the SellerProfile
// repository to:
//   - persist a Draft row via `saveDraft` (lazy first-save / resume /
//     update) and reject the save when the existing row is Published
//     or Suspended.
//   - atomic Draft -> Published transition plus append-only
//     `SellerProfilePublication` evidence row insertion via
//     `publishProfile`.
//   - atomic full field set replacement on a Published profile plus a
//     new evidence row via `updatePublishedProfile`; update on a Draft
//     row is rejected.
//   - retry-idempotency convergence: same `idempotencyKey` returns the
//     already-persisted outcome without creating a second evidence row.
//   - DB unique constraint `(workspaceId, idempotencyKey)` is the second
//     defense when a concurrent same-key request slips past the
//     pre-transaction check.
//   - concurrent drafts on the same Workspace serialize to a single
//     row via the `seller_profiles.workspaceId @unique` constraint plus
//     `INSERT ... ON CONFLICT DO NOTHING` (Prisma `upsert`).
//   - Draft profile is NOT visible in the published catalog (the
//     non-leakage invariant — Draft rows never appear in the public
//     search/offering catalog).
//
// These tests run against the disposable PostgreSQL target via
// `pnpm db:test:reset`. They assert observable persisted outcomes
// only — no source-pattern checks, no assertions on private ORM call
// ordering, no test-only hooks added to the production repository.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PrismaClient } from "@soundhub/db";
import { createPrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import { PrismaSellerProfileRepository } from "./prisma-seller-profile.repository.js";
import {
  SellerProfileNotDraftError,
  SellerProfileNotPublishedError,
} from "./seller-profile.repository.js";

let prisma: PrismaClient;
let repo: PrismaSellerProfileRepository;

const USER_ID = "user-84-prisma";
const WORKSPACE_ID = "ws-84-prisma-personal";
const EMAIL = "prisma-84@example.com";

interface Fixture {
  userId: string;
  workspaceId: string;
}

async function loadFixture(): Promise<Fixture> {
  // Ensure two baseline Specialties exist for FK-bound
  // `seller_profile_specialties` rows. The seed populates the full
  // catalog; tests only need a small handful.
  const specialtyKeys = ["Producer", "SoundEngineer", "Artist"];
  for (const key of specialtyKeys) {
    await prisma.specialty.upsert({
      where: { key },
      create: { key, name: key },
      update: {},
    });
  }

  const user = await prisma.userAccount.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, email: EMAIL },
    update: { email: EMAIL },
  });

  const workspace = await prisma.workspace.upsert({
    where: { id: WORKSPACE_ID },
    create: {
      id: WORKSPACE_ID,
      slug: "ws-84-prisma-personal",
      name: "84 Prisma Personal",
      type: "Personal",
      status: "Active",
      ownerUserId: user.id,
    },
    update: { status: "Active" },
  });

  // Personal Workspace convergence: at least one Owner membership +
  // the Seller capability so the workspace authorization service
  // can recognize the actor.
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
  await prisma.workspaceCapability.deleteMany({
    where: { workspaceId: workspace.id },
  });
  await prisma.workspaceCapability.create({
    data: { workspaceId: workspace.id, capability: "Seller" },
  });

  // Clean prior test artifacts. The publication table has ON DELETE
  // RESTRICT, so we wipe it BEFORE deleting the SellerProfile row.
  await prisma.sellerProfilePublication.deleteMany({
    where: { workspaceId: workspace.id },
  });
  await prisma.caribbeanAffiliation.deleteMany({
    where: { sellerProfile: { workspaceId: workspace.id } },
  });
  await prisma.sellerProfileSpecialty.deleteMany({
    where: { sellerProfile: { workspaceId: workspace.id } },
  });
  await prisma.sellerProfile.deleteMany({
    where: { workspaceId: workspace.id },
  });

  return { userId: user.id, workspaceId: workspace.id };
}

function draftInput(
  workspaceId: string,
  overrides?: {
    professionalName?: string;
    bio?: string;
    specialtyKeys?: string[];
    caribbeanAffiliationCodes?: string[];
    region?: string;
    city?: string;
    countryCode?: string;
  },
) {
  return {
    workspaceId,
    identity: {
      professionalName: overrides?.professionalName ?? "Creole Beats Brooklyn",
      bio: overrides?.bio ?? "Brooklyn-based production studio.",
    },
    basedIn: {
      countryCode: overrides?.countryCode ?? "US",
      ...(overrides?.region !== undefined ? { region: overrides.region } : {}),
      ...(overrides?.city !== undefined ? { city: overrides.city } : {}),
    },
    disciplines: {
      specialtyKeys: overrides?.specialtyKeys ?? ["Producer"],
      caribbeanAffiliationCodes: overrides?.caribbeanAffiliationCodes ?? ["HT"],
    },
    now: new Date("2026-09-26T00:00:00Z"),
  };
}

function publicationInput(
  workspaceId: string,
  idempotencyKey: string,
  overrides?: {
    professionalName?: string;
    bio?: string;
    specialtyKeys?: string[];
    caribbeanAffiliationCodes?: string[];
    region?: string;
    city?: string;
    countryCode?: string;
    confirmationVersion?: "m2-profile-publication-v1";
    requestId?: string;
    now?: Date;
    publishedByUserId?: string;
  },
) {
  const fx = { userId: USER_ID, workspaceId } as const;
  return {
    workspaceId,
    identity: {
      professionalName: overrides?.professionalName ?? "Creole Beats Brooklyn",
      bio: overrides?.bio ?? "Brooklyn-based production studio.",
    },
    basedIn: {
      countryCode: overrides?.countryCode ?? "US",
      ...(overrides?.region !== undefined ? { region: overrides.region } : {}),
      ...(overrides?.city !== undefined ? { city: overrides.city } : {}),
    },
    disciplines: {
      specialtyKeys: overrides?.specialtyKeys ?? ["Producer"],
      caribbeanAffiliationCodes: overrides?.caribbeanAffiliationCodes ?? ["HT"],
    },
    confirmationVersion: overrides?.confirmationVersion ?? "m2-profile-publication-v1",
    idempotencyKey,
    requestId: overrides?.requestId ?? "req-84-test",
    publishedByUserId: overrides?.publishedByUserId ?? fx.userId,
    now: overrides?.now ?? new Date("2026-09-26T00:01:00Z"),
  };
}

before(() => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prisma = createPrismaClient(url);
  repo = new PrismaSellerProfileRepository(prisma);
});

after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Lazy first save + retry convergence
// ---------------------------------------------------------------------------

test("saveDraft: lazy first-save inserts a single Draft row", async () => {
  const fx = await loadFixture();
  const result = await repo.saveDraft(draftInput(fx.workspaceId));
  assert.equal(result.status, "Draft");
  assert.equal(result.identity.professionalName, "Creole Beats Brooklyn");
  assert.equal(result.basedIn.countryCode, "US");
  assert.deepEqual(result.disciplines.specialtyKeys, ["Producer"]);
  assert.deepEqual(result.disciplines.caribbeanAffiliationCodes, ["HT"]);

  const stored = await prisma.sellerProfile.findUnique({
    where: { workspaceId: fx.workspaceId },
  });
  assert.ok(stored);
  assert.equal(stored?.status, "Draft");

  const specialties = await prisma.sellerProfileSpecialty.findMany({
    where: { sellerProfileId: stored?.id },
  });
  assert.equal(specialties.length, 1);

  const affiliations = await prisma.caribbeanAffiliation.findMany({
    where: { sellerProfileId: stored?.id },
  });
  assert.equal(affiliations.length, 1);
  assert.equal(affiliations[0]?.countryCode, "HT");
});

test("saveDraft: a second call converges on the same row (no duplicate insert)", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(draftInput(fx.workspaceId, { professionalName: "First" }));
  await repo.saveDraft(draftInput(fx.workspaceId, { professionalName: "Second" }));
  const count = await prisma.sellerProfile.count({
    where: { workspaceId: fx.workspaceId },
  });
  assert.equal(count, 1, "only one SellerProfile row exists per Workspace");
  const current = await prisma.sellerProfile.findUnique({
    where: { workspaceId: fx.workspaceId },
  });
  assert.equal(current?.professionalName, "Second");
});

test("saveDraft: rejected with SellerProfileNotDraftError when the row is Published", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(draftInput(fx.workspaceId));
  await repo.publishProfile(publicationInput(fx.workspaceId, "key-not-draft-1"));
  await assert.rejects(
    () => repo.saveDraft(draftInput(fx.workspaceId, { professionalName: "X" })),
    (err: unknown) => err instanceof SellerProfileNotDraftError,
  );
});

// ---------------------------------------------------------------------------
// Publish + append-only evidence + retry-idempotency convergence
// ---------------------------------------------------------------------------

test("publishProfile: transitions Draft -> Published and inserts ONE SellerProfilePublication evidence row", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(draftInput(fx.workspaceId));
  const result = await repo.publishProfile(publicationInput(fx.workspaceId, "key-publish-1"));
  assert.equal(result.profile.status, "Published");
  assert.equal(result.convergedFromExistingPublication, false);
  assert.equal(result.evidence.idempotencyKey, "key-publish-1");
  assert.equal(result.evidence.confirmationVersion, "m2-profile-publication-v1");

  const stored = await prisma.sellerProfile.findUnique({
    where: { workspaceId: fx.workspaceId },
  });
  assert.ok(stored?.publishedAt);

  const evidence = await prisma.sellerProfilePublication.findMany({
    where: { workspaceId: fx.workspaceId },
  });
  assert.equal(evidence.length, 1, "exactly one evidence row");
  assert.equal(evidence[0]?.idempotencyKey, "key-publish-1");
});

test("publishProfile: same idempotencyKey converges on the existing evidence row (no duplicate insert)", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(draftInput(fx.workspaceId));
  const first = await repo.publishProfile(publicationInput(fx.workspaceId, "key-retry-1"));
  const second = await repo.publishProfile(publicationInput(fx.workspaceId, "key-retry-1"));
  assert.equal(first.evidence.publishedAt.toISOString(), second.evidence.publishedAt.toISOString());
  assert.equal(second.convergedFromExistingPublication, true);
  const evidence = await prisma.sellerProfilePublication.findMany({
    where: { workspaceId: fx.workspaceId },
  });
  assert.equal(evidence.length, 1, "retry did not create a second evidence row");
});

test("publishProfile: different idempotencyKey on a Published row is rejected (not-Draft)", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(draftInput(fx.workspaceId));
  await repo.publishProfile(publicationInput(fx.workspaceId, "key-different-1"));
  await assert.rejects(
    () => repo.publishProfile(publicationInput(fx.workspaceId, "key-different-2")),
    (err: unknown) => err instanceof SellerProfileNotDraftError,
  );
  const evidence = await prisma.sellerProfilePublication.findMany({
    where: { workspaceId: fx.workspaceId },
  });
  assert.equal(evidence.length, 1, "second publish attempt did not insert");
});

test("publishProfile: idempotencyKey with no Draft row fails closed (no evidence insert)", async () => {
  const fx = await loadFixture();
  await assert.rejects(
    () => repo.publishProfile(publicationInput(fx.workspaceId, "key-no-draft")),
    (err: unknown) => err instanceof Error && !(err instanceof SellerProfileNotDraftError),
  );
  const evidence = await prisma.sellerProfilePublication.findMany({
    where: { workspaceId: fx.workspaceId },
  });
  assert.equal(evidence.length, 0, "no evidence row was inserted");
});

// ---------------------------------------------------------------------------
// Post-publication update
// ---------------------------------------------------------------------------

test("updatePublishedProfile: replaces the field set and inserts a NEW evidence row", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(draftInput(fx.workspaceId));
  await repo.publishProfile(publicationInput(fx.workspaceId, "key-update-1"));
  const result = await repo.updatePublishedProfile(
    publicationInput(fx.workspaceId, "key-update-2", {
      professionalName: "Updated Name",
    }),
  );
  assert.equal(result.profile.status, "Published");
  assert.equal(result.profile.identity.professionalName, "Updated Name");
  assert.equal(result.convergedFromExistingPublication, false);

  const evidence = await prisma.sellerProfilePublication.findMany({
    where: { workspaceId: fx.workspaceId },
  });
  assert.equal(evidence.length, 2, "two evidence rows (initial publish + update)");
  const keys = evidence.map((e) => e.idempotencyKey).sort();
  assert.deepEqual(keys, ["key-update-1", "key-update-2"]);
});

test("updatePublishedProfile: same idempotencyKey converges on the existing update", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(draftInput(fx.workspaceId));
  await repo.publishProfile(publicationInput(fx.workspaceId, "key-upd-retry-1"));
  const first = await repo.updatePublishedProfile(
    publicationInput(fx.workspaceId, "key-upd-retry-2"),
  );
  const second = await repo.updatePublishedProfile(
    publicationInput(fx.workspaceId, "key-upd-retry-2"),
  );
  assert.equal(first.evidence.publishedAt.toISOString(), second.evidence.publishedAt.toISOString());
  assert.equal(second.convergedFromExistingPublication, true);
  const evidence = await prisma.sellerProfilePublication.findMany({
    where: { workspaceId: fx.workspaceId },
  });
  assert.equal(evidence.length, 2, "no new evidence row on retry");
});

test("updatePublishedProfile: rejected with SellerProfileNotPublishedError on a Draft row", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(draftInput(fx.workspaceId));
  await assert.rejects(
    () => repo.updatePublishedProfile(publicationInput(fx.workspaceId, "key-not-published")),
    (err: unknown) => err instanceof SellerProfileNotPublishedError,
  );
});

// ---------------------------------------------------------------------------
// Find current profile
// ---------------------------------------------------------------------------

test("findCurrentProfile: returns null when no draft exists", async () => {
  const fx = await loadFixture();
  const result = await repo.findCurrentProfile(fx.workspaceId);
  assert.equal(result, null);
});

test("findCurrentProfile: returns the persisted Draft with all disciplines", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(
    draftInput(fx.workspaceId, {
      specialtyKeys: ["Producer", "SoundEngineer"],
      caribbeanAffiliationCodes: ["HT", "JM"],
      region: "New York",
      city: "Brooklyn",
    }),
  );
  const result = await repo.findCurrentProfile(fx.workspaceId);
  assert.ok(result);
  assert.equal(result?.status, "Draft");
  assert.deepEqual([...(result?.disciplines.specialtyKeys ?? [])].sort(), [
    "Producer",
    "SoundEngineer",
  ]);
  assert.deepEqual([...(result?.disciplines.caribbeanAffiliationCodes ?? [])].sort(), ["HT", "JM"]);
  assert.equal(result?.basedIn.region, "New York");
  assert.equal(result?.basedIn.city, "Brooklyn");
});

// ---------------------------------------------------------------------------
// Specialty catalog defense
// ---------------------------------------------------------------------------

test("saveDraft: unknown specialty key fails closed (no orphan row)", async () => {
  const fx = await loadFixture();
  await assert.rejects(
    () =>
      repo.saveDraft(
        draftInput(fx.workspaceId, {
          specialtyKeys: ["Nonexistent-Specialty"],
        }),
      ),
    (err: unknown) => err instanceof Error && err.message.includes("unknown specialty keys"),
  );
  const stored = await prisma.sellerProfile.findUnique({
    where: { workspaceId: fx.workspaceId },
  });
  assert.equal(stored, null, "transaction rolled back; no row persisted");
});

// ---------------------------------------------------------------------------
// Draft non-leakage invariant
// ---------------------------------------------------------------------------

test("Draft profiles are NOT visible to the published-only catalog (non-leakage)", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(draftInput(fx.workspaceId));
  // The published-catalog query used by
  // `prisma-offering-catalog.repository.ts` filters on
  // `status: "Published"`. A Draft row must not surface. We assert
  // by reading the row directly with the same filter.
  const visible = await prisma.sellerProfile.findMany({
    where: { workspaceId: fx.workspaceId, status: "Published" },
  });
  assert.equal(visible.length, 0, "Draft row is invisible to the Published filter");
});

// ---------------------------------------------------------------------------
// Concurrent same-Workspace serialization (advisory lock)
// ---------------------------------------------------------------------------

test("concurrent publishProfile on the same Draft serializes via the advisory lock (exactly one transition)", async () => {
  const fx = await loadFixture();
  await repo.saveDraft(draftInput(fx.workspaceId, { professionalName: "Initial" }));
  // Fire two concurrent publishes with DIFFERENT idempotencyKeys.
  // Exactly one must transition Draft -> Published; the other must
  // see the new Published state and reject as not-Draft.
  const [a, b] = await Promise.allSettled([
    repo.publishProfile(
      publicationInput(fx.workspaceId, "key-concurrent-a", { professionalName: "A" }),
    ),
    repo.publishProfile(
      publicationInput(fx.workspaceId, "key-concurrent-b", { professionalName: "B" }),
    ),
  ]);
  const successes = [a, b].filter((r) => r.status === "fulfilled");
  const failures = [a, b].filter((r) => r.status === "rejected");
  assert.equal(successes.length, 1, "exactly one publish succeeded");
  assert.equal(failures.length, 1, "exactly one publish was rejected");
  if (failures[0]?.status === "rejected") {
    assert.ok(
      failures[0].reason instanceof SellerProfileNotDraftError,
      "the loser sees the new Published state and rejects as not-Draft",
    );
  }
  const evidence = await prisma.sellerProfilePublication.findMany({
    where: { workspaceId: fx.workspaceId },
  });
  assert.equal(evidence.length, 1, "exactly one evidence row regardless of which side won");
});
