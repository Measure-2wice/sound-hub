// M2 (#86, slice 86E): pre-rollout grandfathering + inventory script.
//
// This script lists the currently-Active ServiceOfferings that
// fail the activation-readiness predicate. It is read-only: it
// performs SELECT queries via Prisma and never writes, never
// updates, never issues any data-rewriting command. The slice
// plan requires:
//
//   - accepts a DB URL;
//   - performs reads only;
//   - emits structured JSON;
//   - reports currently Active nonconforming offerings and
//     reason categories;
//   - never authorizes or performs data rewrites.
//
// The script consumes the SAME pure readiness predicate that the
// runtime `ServiceOfferingService` composition will use
// (`packages/db/src/grandfathering/service-offering-readiness.ts`,
// re-exported from `@soundhub/db`) so the operator output and
// the runtime UI's Update-needed view are derived from one
// shared source of truth. The shared location in `packages/db/`
// is what the slice plan's "Dependency boundary" section
// requires — the inventory MUST NOT import upward from
// `apps/api/`.
//
// Effective confirmation derivation (86E Codex re-review blockers
// #2 and the chronological-selection follow-up): the script
// reads BOTH `ServiceOfferingActivation` AND `ServiceOfferingUpdate`
// evidence and feeds them through
// `deriveEffectiveConfirmationVersion`. A successful
// `updateActive` writes the current `confirmationVersion` into
// `ServiceOfferingUpdate` WITHOUT rewriting the historical
// activation row (per the slice plan and the
// `ServiceOfferingUpdate` schema comment). Reading activation
// alone would misclassify a successfully repaired legacy
// Active offering as `activation-confirmation-stale`.
//
// Chronological selection: the lifecycle permits
// `Activate → Update → Pause → Reactivate`, and a Reactivate
// issued AFTER a confirmation-version rotation writes a NEW
// activation row at the current version while the older update
// row from before the rotation still carries the previous
// version. The helper picks the chronologically newest
// evidence event (compare `activatedAt` vs `updatedAt`), not
// the most-recently-inserted row type. The script carries
// `activatedAt`/`updatedAt` alongside `confirmationVersion`
// in the Prisma select so the helper has the timestamps it
// needs.
//
// Usage:
//
//   DATABASE_URL=postgresql://... pnpm --filter @soundhub/db db:inventory
//   pnpm --filter @soundhub/db db:inventory -- --database-url=postgresql://...
//
// (the script is run via the package's `tsx` toolchain from
// `packages/db/prisma/`, so the well-known DATABASE_URL env var
// follows the existing seed pattern.)
//
// The script exits 0 on success regardless of whether nonconforming
// offerings are reported — the operator output IS the report.
// The script exits non-zero only on infrastructure failures (bad
// URL, connection failure, query failure).

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";
import { SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS } from "@soundhub/types";
import type { PrismaClient as PrismaClientType } from "../src/generated/client.js";
import {
  deriveEffectiveConfirmationVersion,
  deriveServiceOfferingReadiness,
  SERVICE_OFFERING_MAX_CONFIRMED_LIVE_SAMPLES,
  SERVICE_OFFERING_MIN_CONFIRMED_LIVE_SAMPLES,
} from "../src/grandfathering/service-offering-readiness.js";

const argv = process.argv.slice(2);
function readFlag(name) {
  const flag = `--${name}=`;
  const arg = argv.find((a) => a.startsWith(flag));
  if (arg) return arg.slice(flag.length);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return undefined;
}

const databaseUrl =
  readFlag("database-url") ?? process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "";
if (!databaseUrl) {
  console.error(
    "❌ inventory-grandfathered-offerings: missing database URL. " +
      "Pass --database-url=<url> or set DATABASE_URL.",
  );
  process.exit(2);
}

const currentConfirmationVersion =
  // The slice 86E inventory reports against the latest closed
  // version constant exported from the shared types package so
  // the operator output stays in sync with the runtime. The
  // runtime's `SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS`
  // tuple is currently a single element; the inventory reads the
  // LAST element as "current" — matching the runtime convention.
  SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS[
    SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS.length - 1
  ];

// The `databaseUrl` was validated above. Construct Prisma with
// the explicit `PrismaPg` driver adapter (Prisma 7 requires a
// driver adapter; the same pattern is used by
// `packages/db/prisma/seed.ts`).
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

/**
 * Pure (side-effect-free with respect to the database) inventory
 * computation. Given a Prisma client and the current closed-set
 * confirmation version, returns the structured JSON payload the
 * script emits to stdout. The function performs SELECT queries
 * only — no INSERT, UPDATE, or DELETE — and never disconnects
 * the provided client.
 *
 * The function is exported so the integration test
 * (`packages/db/prisma/inventory-grandfathered-offerings.test.ts`)
 * can exercise the same code path without spawning a subprocess
 * or coupling to stdout parsing.
 */
export async function computeInventorySnapshot(
  prisma: PrismaClientType,
  currentConfirmationVersion: string,
): Promise<InventorySnapshot> {
  // Fetch all Active offerings with the persistence predicates the
  // readiness view needs. We select exactly the persisted columns
  // the predicate consumes (no fabricated data) and use Prisma's
  // count helper for the CONFIRMED Live sample count.
  //
  // `activations` and `updates` each return their latest row only;
  // the predicate merges the two pieces of evidence via
  // `deriveEffectiveConfirmationVersion`. See the file header
  // for the rationale (86E blocker #2).
  const offerings = await prisma.serviceOffering.findMany({
    where: { status: "Active" },
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      status: true,
      serviceMode: true,
      primaryCategoryId: true,
      sellerProfileId: true,
      sellerProfile: {
        select: { status: true },
      },
      activations: {
        orderBy: { activatedAt: "desc" },
        take: 1,
        select: { confirmationVersion: true, activatedAt: true },
      },
      updates: {
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: { confirmationVersion: true, updatedAt: true },
      },
      _count: {
        select: {
          serviceAreas: true,
        },
      },
      pricing: {
        select: { id: true },
      },
      audioSamples: {
        where: {
          cleanupStatus: "Live",
          confirmationVersion: { not: null },
          confirmedByUserId: { not: null },
          confirmedAt: { not: null },
        },
        select: { id: true },
      },
    },
  });

  const reports = offerings.map((row) => {
    // The helper requires timestamps so it can pick the
    // chronologically newest evidence event. See the file header
    // for the Activate → Update → Pause → Reactivate scenario.
    const effectiveConfirmationVersion = deriveEffectiveConfirmationVersion({
      latestActivation:
        row.activations.length > 0
          ? {
              confirmationVersion: row.activations[0].confirmationVersion,
              occurredAt: row.activations[0].activatedAt,
            }
          : null,
      latestUpdate:
        row.updates.length > 0
          ? {
              confirmationVersion: row.updates[0].confirmationVersion,
              occurredAt: row.updates[0].updatedAt,
            }
          : null,
    });
    const input = {
      status: row.status,
      title: row.title,
      description: row.description,
      hasPrimaryCategory: row.primaryCategoryId !== null,
      serviceMode: row.serviceMode ?? "Remote",
      serviceAreaCount: row._count.serviceAreas,
      hasPricing: row.pricing !== null,
      confirmedLiveSampleCount: row.audioSamples.length,
      sellerProfileStatus: row.sellerProfile.status,
      confirmationVersion: effectiveConfirmationVersion,
      currentConfirmationVersion,
    };
    const readiness = deriveServiceOfferingReadiness(input);
    return {
      offeringId: row.id,
      slug: row.slug,
      sellerProfileId: row.sellerProfileId,
      sellerProfileStatus: row.sellerProfile.status,
      readiness,
    };
  });

  const nonconforming = reports.filter((r) => r.readiness.reasonCategories.length > 0);
  const conforming = reports.filter((r) => r.readiness.reasonCategories.length === 0);

  // Aggregate the per-category counts so the operator can see
  // the readiness distribution at a glance.
  const reasonCategoryCounts: Record<string, number> = {};
  for (const r of nonconforming) {
    for (const cat of r.readiness.reasonCategories) {
      reasonCategoryCounts[cat] = (reasonCategoryCounts[cat] ?? 0) + 1;
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    currentConfirmationVersion,
    sampleCountBounds: {
      min: SERVICE_OFFERING_MIN_CONFIRMED_LIVE_SAMPLES,
      max: SERVICE_OFFERING_MAX_CONFIRMED_LIVE_SAMPLES,
    },
    totals: {
      activeOfferingsScanned: reports.length,
      conforming: conforming.length,
      nonconforming: nonconforming.length,
    },
    reasonCategoryCounts,
    nonconformingOfferings: nonconforming.map((r) => ({
      offeringId: r.offeringId,
      slug: r.slug,
      sellerProfileId: r.sellerProfileId,
      sellerProfileStatus: r.sellerProfileStatus,
      reasonCategories: r.readiness.reasonCategories,
      // The slice 86E invariant: a grandfathered Active offering
      // is simultaneously `isAvailable=true` (preserved by the
      // lifecycle status — the slice plan's Lifecycle section
      // names "Available" as the customer-facing alias for
      // durable Active) AND `updateNeeded=true` (the operator
      // must surface the actionable reasons). The readiness
      // predicate returns `isAvailable=true` for every Active
      // row; the `updateNeeded` flag is what distinguishes
      // "Available + conformant" from "Available + Update needed".
      isAvailable: r.readiness.isAvailable,
      updateNeeded: r.readiness.updateNeeded,
    })),
  };
}

/**
 * Structured shape of the JSON the script emits to stdout.
 * Re-exported for the integration test.
 */
export interface InventorySnapshot {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly currentConfirmationVersion: string;
  readonly sampleCountBounds: {
    readonly min: number;
    readonly max: number;
  };
  readonly totals: {
    readonly activeOfferingsScanned: number;
    readonly conforming: number;
    readonly nonconforming: number;
  };
  readonly reasonCategoryCounts: Readonly<Record<string, number>>;
  readonly nonconformingOfferings: ReadonlyArray<{
    readonly offeringId: string;
    readonly slug: string;
    readonly sellerProfileId: string;
    readonly sellerProfileStatus: string;
    readonly reasonCategories: readonly string[];
    readonly isAvailable: boolean;
    readonly updateNeeded: boolean;
  }>;
}

async function main() {
  try {
    const payload = await computeInventorySnapshot(prisma, currentConfirmationVersion);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run `main()` when this file is invoked as a script.
// When the file is imported (e.g., by the integration test), the
// `process.argv[1]` path does not end with the script's basename
// and the guard short-circuits before any CLI-specific work runs.
// This pattern mirrors the one used in
// `scripts/check-forbidden-deps.mjs`.
const isDirectInvocation = (() => {
  if (typeof process === "undefined") return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return (
    entry.endsWith("/inventory-grandfathered-offerings.ts") ||
    entry.endsWith("/inventory-grandfathered-offerings.js")
  );
})();

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("❌ inventory-grandfathered-offerings failed:");
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
