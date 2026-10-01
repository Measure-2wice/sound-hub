// Test-only helper (M2 #86, slice 86F): seed an Active ServiceOffering
// for the lifecycle / integrated-QA browser journeys.
//
// The 86F Playwright spec drives the slice-specific UI surfaces
// (Pause / Update / Reactivate / final-sample removal / Cancel local
// edits / grandfathered Available + Update needed). The PREREQUISITE
// for an Active offering — Published SellerProfile, complete strict
// activation payload, confirmed Live audio sample — is established
// here via direct Prisma writes so the browser walk exercises ONLY
// the slice-specific UI surfaces.
//
// The helper writes via Prisma directly (same pattern as
// `multi-workspace-user.ts`). It stages:
//   - Seller capability on the Personal Workspace
//   - Published SellerProfile with the required identity / basedIn /
//     disciplines fields the Publish endpoint requires
//   - ServiceOffering in Active (or Paused) state with the strict
//     activation payload (title / description / category / mode /
//     pricing / service areas / genre tags)
//   - activation + (optional) pause evidence rows so the OwnerView's
//     evidence shape is fully populated
//   - one (or two) Live audio sample rows with the current audio
//     confirmation version populated (the OFFERING_INCLUDE filter
//     requires confirmationVersion + confirmedAt + confirmedByUserId
//     to be non-null)
//
// The audio samples' storageRef is prefixed `det:` so the
// deterministic in-memory storage adapter accepts `removeSample`
// calls during the lifecycle tests. Playback is not exercised
// in this slice's tests (`preload="none"` on the editor's <audio>
// element + the spec doesn't trigger play), so the adapter's
// in-memory bytes for the storageRef do not need to be populated.
//
// Run as `tsx apps/api/src/test-helpers/service-offering-active.ts
// <email>` to seed an Active offering. Default options produce a
// conforming Active offering. SEED_FLAGS env var opts into the
// grandfathered remediation + Paused branch + multiple-samples
// surfaces.

import { randomUUID } from "node:crypto";
import {
  assertDisposableTestDatabase,
  buildDeterministicMp3Fixture,
  createPrismaClient,
  readTestDatabaseUrl,
} from "@soundhub/db";
import { seedMultiWorkspaceUser } from "./multi-workspace-user.js";

export interface ActiveOfferingSeedResult {
  readonly email: string;
  readonly userAccountId: string;
  readonly personalWorkspaceId: string;
  readonly sellerProfileId: string;
  readonly offeringId: string;
  readonly offeringSlug: string;
  readonly sampleId: string;
}

export interface SeedActiveOfferingOptions {
  readonly staleConfirmation?: boolean;
  readonly omitPricing?: boolean;
  readonly omitSample?: boolean;
  readonly multipleSamples?: boolean;
  readonly paused?: boolean;
}

const ACTIVATION_CONFIRMATION_VERSION = "m2-service-activation-v1";
const PROFILE_CONFIRMATION_VERSION = "m2-profile-publication-v1";
const AUDIO_CONFIRMATION_VERSION = "m2-audio-confirmation-v1";

const FLAG_VALUES = [
  "stale-confirmation",
  "omit-pricing",
  "omit-sample",
  "multiple-samples",
  "paused",
] as const;
type FlagValue = (typeof FLAG_VALUES)[number];

function readFlags(envValue: string | undefined): SeedActiveOfferingOptions {
  const flags = (envValue ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const known = new Set<FlagValue>(FLAG_VALUES);
  let staleConfirmation = false;
  let omitPricing = false;
  let omitSample = false;
  let multipleSamples = false;
  let paused = false;
  for (const flag of flags) {
    if (!known.has(flag as FlagValue)) continue;
    switch (flag as FlagValue) {
      case "stale-confirmation":
        staleConfirmation = true;
        break;
      case "omit-pricing":
        omitPricing = true;
        break;
      case "omit-sample":
        omitSample = true;
        break;
      case "multiple-samples":
        multipleSamples = true;
        break;
      case "paused":
        paused = true;
        break;
    }
  }
  return { staleConfirmation, omitPricing, omitSample, multipleSamples, paused };
}

/**
 * Seed an Active ServiceOffering for the slice 86F lifecycle /
 * integrated-QA browser journeys against the approved disposable
 * test database.
 */
export async function seedActiveServiceOffering(
  email: string,
  options: SeedActiveOfferingOptions = {},
): Promise<ActiveOfferingSeedResult> {
  if (!email) {
    throw new Error("seedActiveServiceOffering: email argument is required");
  }
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);

  // Step 1 — provision the user. The multi-workspace-user helper
  // is idempotent (it clears prior state for this email before
  // re-creating the rows) so re-running the helper in the same
  // disposable DB converges on the same IDs.
  const seeded = await seedMultiWorkspaceUser(email);

  const prisma = createPrismaClient(url);
  try {
    const userId = seeded.userAccountId;
    const personalWorkspaceId = seeded.personalWorkspaceId;

    // Step 2 — provision Seller capability on the Personal
    // Workspace. The slice plan asserts the editor's Acting-
    // Workspace gate requires the Seller capability on the SAME
    // Workspace that owns the offering.
    await prisma.workspaceCapability.upsert({
      where: {
        workspaceId_capability: {
          workspaceId: personalWorkspaceId,
          capability: "Seller",
        },
      },
      update: {},
      create: { workspaceId: personalWorkspaceId, capability: "Seller" },
    });

    // Step 3 — look up the canonical Specialty + PricingUnit +
    // ServiceCategory keys the seed publishes. The seed runs
    // ahead of any e2e fixture; if the taxonomies are missing the
    // helper throws so a missing seed step is loud.
    // The Specialty keys are the controlled seller capability
    // tags ("Artist" / "Producer" / "Musician" / "Songwriter" /
    // "SoundEngineer"), NOT the ServiceCategory keys. The slice
    // 86F seller's discipline selection populates the
    // SellerProfileSpecialty join row with one Specialty id.
    const specialty = await prisma.specialty.findUnique({ where: { key: "Producer" } });
    if (!specialty) {
      throw new Error(
        "seedActiveServiceOffering: Specialty 'Producer' is missing. Run `pnpm --filter @soundhub/db db:seed` first.",
      );
    }
    const pricingUnit = await prisma.pricingUnit.findUnique({ where: { key: "track" } });
    if (!pricingUnit) {
      throw new Error(
        "seedActiveServiceOffering: PricingUnit 'track' is missing. Run `pnpm --filter @soundhub/db db:seed` first.",
      );
    }
    const primaryCategory = await prisma.serviceCategory.findUnique({
      where: { key: "music-production" },
    });
    if (!primaryCategory) {
      throw new Error(
        "seedActiveServiceOffering: ServiceCategory 'music-production' is missing. Run `pnpm --filter @soundhub/db db:seed` first.",
      );
    }

    // Step 4 — Published SellerProfile + evidence. The route's
    // Publish code path writes the SellerProfilePublication row
    // on success; bypassing the route means we MUST write it
    // here so the OwnerView's publication shape is populated.
    const sellerProfile = await prisma.sellerProfile.upsert({
      where: { workspaceId: personalWorkspaceId },
      update: {
        status: "Published",
        professionalName: "Lifecycle demo",
        bio: "Slice 86F coverage profile.",
        basedInCountryCode: "JM",
        publishedAt: new Date(),
        publishedByUserId: userId,
      },
      create: {
        workspaceId: personalWorkspaceId,
        professionalName: "Lifecycle demo",
        bio: "Slice 86F coverage profile.",
        basedInCountryCode: "JM",
        status: "Published",
        publishedAt: new Date(),
        publishedByUserId: userId,
      },
    });
    await prisma.sellerProfileSpecialty.upsert({
      where: {
        sellerProfileId_specialtyId: {
          sellerProfileId: sellerProfile.id,
          specialtyId: specialty.id,
        },
      },
      update: {},
      create: { sellerProfileId: sellerProfile.id, specialtyId: specialty.id },
    });
    await prisma.caribbeanAffiliation.upsert({
      where: {
        sellerProfileId_countryCode: {
          sellerProfileId: sellerProfile.id,
          countryCode: "JM",
        },
      },
      update: {},
      create: { sellerProfileId: sellerProfile.id, countryCode: "JM" },
    });
    const publicationIdempotencyKey = randomUUID();
    await prisma.sellerProfilePublication.create({
      data: {
        sellerProfileId: sellerProfile.id,
        workspaceId: personalWorkspaceId,
        publishedByUserId: userId,
        confirmationVersion: PROFILE_CONFIRMATION_VERSION,
        idempotencyKey: publicationIdempotencyKey,
        requestId: `seed-${publicationIdempotencyKey}`,
      },
    });

    // Step 5 — ServiceOffering in Active (or Paused) state.
    const slug = `lifecycle-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const offering = await prisma.serviceOffering.create({
      data: {
        slug,
        sellerProfileId: sellerProfile.id,
        title: "Lifecycle demo offering",
        description: "Slice 86F coverage description.",
        status: options.paused ? "Paused" : "Active",
        serviceMode: "Remote",
        primaryCategoryId: primaryCategory.id,
        genreTags: ["dancehall"],
      },
    });

    // Step 6 — service area. Activation recheck requires ≥ 1.
    await prisma.serviceOfferingServiceArea.create({
      data: { offeringId: offering.id, countryCode: "JM" },
    });

    // Step 7 — pricing (optional for grandfathered `pricing_missing`).
    if (!options.omitPricing) {
      await prisma.serviceOfferingPricing.create({
        data: {
          offeringId: offering.id,
          kind: "Fixed",
          amountMinor: 15000,
          currency: "USD",
          unitId: pricingUnit.id,
        },
      });
    }

    // Step 8 — Live audio sample(s). The storageRef is `det:`-prefixed
    // so the deterministic in-memory storage adapter's
    // `removeSample` accepts it during the lifecycle tests. Playback
    // is not exercised (`preload="none"` + the tests don't trigger
    // play), so the adapter's bytes Map for these refs do not need
    // to be populated.
    let firstSampleId = "";
    if (!options.omitSample) {
      const sampleCount = options.multipleSamples ? 2 : 1;
      for (let i = 0; i < sampleCount; i++) {
        const storageRef = `det:seed-lifecycle-${randomUUID()}`;
        const sample = await prisma.serviceOfferingAudioSample.create({
          data: {
            offeringId: offering.id,
            label: `Lifecycle sample ${i + 1}`,
            contentType: "audio/mpeg",
            byteSize: 1024,
            displayOrder: i + 1,
            storageRef,
            cleanupStatus: "Live",
            confirmationVersion: AUDIO_CONFIRMATION_VERSION,
            confirmedByUserId: userId,
            confirmedAt: new Date(),
          },
        });
        if (i === 0) firstSampleId = sample.id;
      }
    }

    // Step 9 — activation evidence row. The slice plan's
    // "grandfathered Available + Update needed" surface requires
    // a stale confirmationVersion on this row so the readiness
    // predicate returns `updateNeeded: true` with reason
    // `confirmation_version_stale`.
    const confirmationVersion = options.staleConfirmation
      ? `${ACTIVATION_CONFIRMATION_VERSION}-legacy`
      : ACTIVATION_CONFIRMATION_VERSION;
    const activationIdempotencyKey = randomUUID();
    await prisma.serviceOfferingActivation.create({
      data: {
        offeringId: offering.id,
        workspaceId: personalWorkspaceId,
        sellerProfileId: sellerProfile.id,
        activatedByUserId: userId,
        confirmationVersion,
        idempotencyKey: activationIdempotencyKey,
        requestId: `seed-${activationIdempotencyKey}`,
      },
    });

    // Step 10 — (optional) pause evidence row when the Paused
    // branch is requested.
    if (options.paused) {
      const pauseIdempotencyKey = randomUUID();
      await prisma.serviceOfferingPause.create({
        data: {
          offeringId: offering.id,
          workspaceId: personalWorkspaceId,
          sellerProfileId: sellerProfile.id,
          pausedByUserId: userId,
          reason: "user_initiated",
          idempotencyKey: pauseIdempotencyKey,
          requestId: `seed-${pauseIdempotencyKey}`,
        },
      });
    }

    return {
      email,
      userAccountId: userId,
      personalWorkspaceId,
      sellerProfileId: sellerProfile.id,
      offeringId: offering.id,
      offeringSlug: slug,
      sampleId: firstSampleId,
    };
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("service-offering-active.ts");

if (isMainModule) {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: service-offering-active.ts <email> (requires TEST_DATABASE_URL)");
    process.exit(1);
  }
  const options = readFlags(process.env.SEED_FLAGS);
  seedActiveServiceOffering(email, options)
    .then(async (result) => {
      console.log(
        `✓ seeded Active offering: ${result.offeringId} slug=${result.offeringSlug} sample=${result.sampleId}`,
      );
      const sidecar = process.env.SEED_OFFERING_SIDECAR;
      if (sidecar) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(sidecar, JSON.stringify(result, null, 2));
      }
      // Optional: write the canonical deterministic MP3 fixture
      // bytes to `SEED_MP3_FIXTURE_PATH`. The Playwright Paused-
      // upload journey reads this file when driving a real upload
      // via the editor's file chooser; using the canonical bytes
      // (rather than a hand-rolled truncated frame) is required by
      // the trusted-boundary MP3 validator. The file is written
      // via a Node Buffer (the canonical bytes are bytes, not a
      // text stream).
      const mp3FixturePath = process.env.SEED_MP3_FIXTURE_PATH;
      if (mp3FixturePath) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(mp3FixturePath, Buffer.from(buildDeterministicMp3Fixture()));
      }
    })
    .catch((err: unknown) => {
      console.error("✗ seed-service-offering-active failed:", err);
      process.exit(1);
    });
}
