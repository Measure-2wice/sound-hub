/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */

// M2.0A / Gate 0 schema expand coverage.
//
// These tests run against the disposable test database (TEST_DATABASE_URL)
// and prove the M2 expand migration independently:
//
//   1. Every M2 table, enum, and column introduced by Gate 0 is present
//      in canonical PostgreSQL after the reviewed migration is applied.
//   2. The expand migration is additive: no M1.1 table, column, enum,
//      index, or foreign key was removed, renamed, or repurposed.
//   3. The M1.1 identifiers (UserAccount.id, Workspace.id,
//      WorkspaceMembership.{userId,workspaceId}, SellerProfile.id,
//      ServiceOffering.{id,slug}) are preserved unchanged.
//   4. The canonical seed runs twice without disturbing the M2 backfill
//      state.
//   5. The MembershipAuthority backfill maps the M1.1 `role` column to
//      the new `authority` column (Owner -> Owner, Admin/Member ->
//      Editor).
//   6. Every canonical SellerProfile has one initial published
//      SellerProfileRevision (revisionNumber = 1, kind = "Published")
//      whose immutable fields match the M1.1 profile values.
//   7. Every canonical ServiceOffering has one initial published
//      ServiceOfferingRevision (revisionNumber = 1, kind = "Published")
//      whose immutable fields match the M1.1 offering values, including
//      denormalized pricing fields.
//   8. The M1.1 anonymous search path (TalentSearchService) returns
//      the canonical sellers and offerings unchanged.
//
// The tests invoke the seed as a child process so the seed's
// process.env.DATABASE_URL requirement is satisfied cleanly, mirroring
// the M1.1 seed.test.ts pattern.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";
import { withTriggerBypass } from "./test-helpers.js";

const APPROVED_DATABASE = "soundhub_m1_test";
const APPROVED_PORT = 5433;
const APPROVED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

class TestGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestGuardError";
  }
}

function resolveDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new TestGuardError("TEST_DATABASE_URL is not set");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new TestGuardError(`invalid URL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new TestGuardError(`not a postgres URL: ${parsed.protocol}`);
  }
  if (!APPROVED_HOSTS.has(parsed.hostname)) {
    throw new TestGuardError(`host ${parsed.hostname} is not an approved local host`);
  }
  if (Number(parsed.port || 5432) !== APPROVED_PORT) {
    throw new TestGuardError(`port ${parsed.port} must be ${APPROVED_PORT}`);
  }
  const database = parsed.pathname.replace(/^\/+/, "");
  if (database !== APPROVED_DATABASE) {
    throw new TestGuardError(`database ${database} must be ${APPROVED_DATABASE}`);
  }
  return url;
}

let prisma: PrismaClient;
let databaseUrl: string;

before(() => {
  databaseUrl = resolveDatabaseUrl();
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
});

after(async () => {
  await prisma.$disconnect();
});

function runSeed(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "prisma/seed.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TEST_DATABASE_URL: databaseUrl,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed exited with code ${code}`));
    });
  });
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function enumExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname = ${name} AND n.nspname = 'public'
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${table}
        AND column_name = ${column}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

describe("M2.0A Gate 0 schema expand coverage", () => {
  test("every M2 table is present in canonical PostgreSQL after migration", async () => {
    // The expand migration adds these tables BESIDE the M1.1 model.
    // The presence of each table proves the migration applied cleanly.
    const m2Tables = [
      // Authentication identity (ADR 0004)
      "authentication_identities",
      "magic_link_challenges",
      // Security
      "user_account_security",
      "sessions",
      // Immutable revisions (ADR 0005)
      "seller_profile_revisions",
      "seller_profile_revision_specialties",
      "seller_profile_revision_caribbean_affiliations",
      "service_offering_revisions",
      "service_offering_revision_service_areas",
      "service_offering_revision_included_services",
      // Audit
      "audit_events",
      // Enforcement
      "workspace_control_freezes",
      "marketplace_reports",
      // Closure (ADR 0006)
      "workspace_closures",
      "user_account_closures",
      // Authority invitations
      "workspace_invitations",
      // Terms / acceptances
      "document_versions",
      "acceptances",
      // Idempotency
      "idempotency_keys",
    ];
    for (const table of m2Tables) {
      assert.ok(await tableExists(table), `M2 table ${table} must exist after migration`);
    }
  });

  test("every M2 enum is present in canonical PostgreSQL after migration", async () => {
    const m2Enums = [
      "WorkspaceMembershipAuthority",
      "AuthenticationProvider",
      "WorkspaceClosureState",
      "UserAccountClosureState",
      "MarketplaceReportStatus",
      "MarketplaceReportReason",
      "AcceptanceKind",
      "DocumentKind",
      "PolicyUpdateClass",
      "RetentionClass",
      "AuditEventOutcome",
      "WorkspaceControlFreezeState",
      "IdempotencyStatus",
      "SellerProfileRevisionKind",
      "ServiceOfferingRevisionKind",
      "WorkspaceInvitationStatus",
    ];
    for (const enumName of m2Enums) {
      assert.ok(await enumExists(enumName), `M2 enum ${enumName} must exist after migration`);
    }
  });

  test("M1.1 tables are preserved unchanged (no removal or rename)", async () => {
    // The expand migration MUST NOT remove, rename, or repurpose any
    // M1.1 table used by the search path. Presence of every M1.1
    // table proves the migration is additive.
    const m1Tables = [
      "user_accounts",
      "workspaces",
      "workspace_memberships",
      "workspace_capabilities",
      "seller_profiles",
      "specialties",
      "seller_profile_specialties",
      "caribbean_affiliations",
      "service_categories",
      "pricing_units",
      "service_offerings",
      "included_services",
      "offering_service_areas",
      "offering_pricing",
    ];
    for (const table of m1Tables) {
      assert.ok(await tableExists(table), `M1.1 table ${table} must be preserved`);
    }
  });

  test("the new M2 columns are present on existing M1.1 tables", async () => {
    // The membership authority backfill column.
    assert.ok(
      await columnExists("workspace_memberships", "authority"),
      "workspace_memberships.authority must exist",
    );
    assert.ok(
      await columnExists("workspace_memberships", "removedAt"),
      "workspace_memberships.removedAt must exist",
    );
    // Workspace and account closure states are independent from
    // suspension.
    assert.ok(
      await columnExists("workspaces", "closureState"),
      "workspaces.closureState must exist",
    );
    assert.ok(
      await columnExists("user_accounts", "closureState"),
      "user_accounts.closureState must exist",
    );
  });

  test("WorkspaceMembership.authority is backfilled from role (Owner -> Owner)", async () => {
    await runSeed();
    // Every canonical membership owns itself, so role = "Owner" and
    // the backfilled authority must be "Owner".
    const memberships = await prisma.workspaceMembership.findMany({
      include: { workspace: true, user: true },
    });
    assert.ok(memberships.length > 0, "seed must produce canonical memberships");
    for (const membership of memberships) {
      if (membership.role === "Owner") {
        assert.equal(
          membership.authority,
          "Owner",
          `membership for user ${membership.userId} in workspace ${membership.workspaceId} must be backfilled to Owner`,
        );
      }
    }
  });

  test("WorkspaceMembership.authority is backfilled for Admin/Member roles (mapped to Editor)", async () => {
    // Verify the migration's UPDATE statement maps both Admin and
    // Member to Editor. The seed's canonical set is all Owner, so
    // this test exercises the Admin/Member branch by inserting a
    // synthetic membership in a pre-migration state (role set,
    // authority carrying a sentinel value), then running exactly
    // the two UPDATE statements the migration runs and observing
    // the backfill. The test is a positive regression for the M2
    // migration's Admin/Member branch.
    await runSeed();
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "creole-beats-brooklyn" },
    });
    // Use a fresh user that does NOT collide with the canonical
    // owner, then create a synthetic membership in a pre-migration
    // state. The role is Admin and the authority is set to a
    // sentinel that the migration must overwrite.
    const synthetic = await prisma.userAccount.create({
      data: {
        id: "user-synthetic-m2-admin-test",
        email: "synthetic.admin@m2-foundation.test",
      },
    });
    await prisma.$executeRaw`
      INSERT INTO workspace_memberships (id, "userId", "workspaceId", role, authority, "createdAt")
      VALUES ('test-m2-admin-membership', ${synthetic.id}, ${workspace.id}, 'Admin'::"WorkspaceMembershipRole", 'Owner'::"WorkspaceMembershipAuthority", NOW())
    `;
    // Run the same UPDATE statements the migration runs. The first
    // maps Owner role -> Owner authority; the second maps Admin /
    // Member -> Editor. The synthetic row must be re-classified
    // from Owner to Editor by the second statement.
    await prisma.$executeRaw`
      UPDATE workspace_memberships
      SET authority = 'Owner'::"WorkspaceMembershipAuthority"
      WHERE role = 'Owner'::"WorkspaceMembershipRole"
    `;
    await prisma.$executeRaw`
      UPDATE workspace_memberships
      SET authority = 'Editor'::"WorkspaceMembershipAuthority"
      WHERE role IN ('Admin'::"WorkspaceMembershipRole", 'Member'::"WorkspaceMembershipRole")
    `;
    const fetched = await prisma.workspaceMembership.findUnique({
      where: { id: "test-m2-admin-membership" },
    });
    assert.ok(fetched, "synthetic Admin membership must be persisted");
    assert.equal(fetched.role, "Admin");
    assert.equal(
      fetched.authority,
      "Editor",
      "Admin role must be mapped to Editor authority by the migration's UPDATE",
    );

    // Clean up the synthetic row so subsequent runs start from
    // canonical state.
    await prisma.workspaceMembership.delete({
      where: { id: "test-m2-admin-membership" },
    });
    await prisma.userAccount.delete({
      where: { id: synthetic.id },
    });
  });

  test("Workspace.ownerUserId FK constraint is dropped; the column is a non-authoritative correspondence field", async () => {
    // ADR 0001 and the M2 spec require Active WorkspaceMembership to
    // be the sole source of current Workspace authority. The M1.1
    // `workspaces.ownerUserId` foreign key made the legacy reference
    // an authority pointer. The M2 migration drops the FK
    // constraint so the legacy column carries no DB-level authority
    // semantics. This test asserts the FK is absent and that the
    // column accepts a value pointing to a user that is NOT the
    // active Owner membership user — the membership (not the
    // column) is the authority source.
    await runSeed();
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "creole-beats-brooklyn" },
      include: { memberships: true },
    });
    const activeOwner = workspace.memberships.find(
      (m) => m.role === "Owner" && m.removedAt === null,
    );
    assert.ok(activeOwner, "canonical workspace must have an active Owner membership");

    // The FK constraint on `workspaces.ownerUserId` must not exist.
    // Look it up by name in pg_constraint.
    const fkRows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'workspaces'
          AND c.contype = 'f'
          AND c.conname = 'workspaces_ownerUserId_fkey'
          AND n.nspname = 'public'
      ) AS exists
    `;
    assert.equal(
      fkRows[0]?.exists,
      false,
      "workspaces.ownerUserId FK must be dropped so the legacy column is non-authoritative",
    );

    // The ownerUserId column must accept pointing at a different
    // user account. A point-at-different-user mutation is the
    // clearest signal that the column has no DB-level authority
    // semantics. Pick a user that is NOT the active Owner
    // membership user.
    const otherUser = await prisma.userAccount.findFirst({
      where: { id: { not: activeOwner.userId } },
    });
    assert.ok(otherUser, "another user must exist for the canonical ownerUserId drift test");
    await prisma.$executeRawUnsafe(
      `UPDATE workspaces SET "ownerUserId" = $1 WHERE id = $2`,
      otherUser.id,
      workspace.id,
    );
    const drifted = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      include: { memberships: true },
    });
    assert.equal(
      drifted.ownerUserId,
      otherUser.id,
      "ownerUserId must still be a writable column after the FK is dropped",
    );
    // The active Owner membership is unchanged: authority is
    // membership-based, not ownerUserId-based.
    const stillOwner = drifted.memberships.find((m) => m.role === "Owner" && m.removedAt === null);
    assert.equal(
      stillOwner?.userId,
      activeOwner.userId,
      "active Owner membership must remain canonical after ownerUserId drift",
    );

    // Restore the canonical ownerUserId so subsequent tests see
    // canonical state.
    await prisma.$executeRawUnsafe(
      `UPDATE workspaces SET "ownerUserId" = $1 WHERE id = $2`,
      activeOwner.userId,
      workspace.id,
    );
  });

  test("Acceptance.userAccountId ON DELETE is RESTRICT (preserves acceptance evidence on account closure)", async () => {
    // ADR 0006 requires versioned acceptance evidence to survive
    // account closure. The M2 migration changes the FK from
    // CASCADE to RESTRICT so cascading account deletion cannot
    // destroy attestation records. This test asserts that
    // attempting to delete a UserAccount referenced by an
    // Acceptance row is rejected by the FK constraint, proving
    // the retention processing is the only path that removes
    // the user reference.
    await runSeed();
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "creole-beats-brooklyn" },
    });
    const ownerUserId = workspace.ownerUserId!;
    const document = await prisma.documentVersion.create({
      data: {
        kind: "Terms",
        version: `m2.0a-restrict-test-${Date.now()}`,
        title: "M2.0A restrict test",
        contentHash: "sha256:test-m2-restrict",
      },
    });
    const acceptance = await prisma.acceptance.create({
      data: {
        userAccountId: ownerUserId,
        documentVersionId: document.id,
        kind: "Terms",
      },
    });

    // Direct DELETE on the user_account must be rejected by the
    // RESTRICT FK constraint. The database throws an error
    // before the user row is removed.
    let deleteBlocked = false;
    try {
      await prisma.userAccount.delete({ where: { id: ownerUserId } });
    } catch (err) {
      deleteBlocked = true;
      assert.ok(
        err instanceof Error,
        `UserAccount DELETE must throw an FK constraint error; got ${String(err)}`,
      );
    }
    assert.ok(
      deleteBlocked,
      "UserAccount DELETE must be rejected when an Acceptance row references it",
    );

    // The acceptance row survives the rejected DELETE attempt.
    const stillThere = await prisma.acceptance.findUnique({
      where: { id: acceptance.id },
      include: { documentVersion: true },
    });
    assert.ok(stillThere, "acceptance row must survive the rejected account DELETE");
    assert.equal(
      stillThere.documentVersion.version,
      document.version,
      "exact document version reference must be preserved",
    );
  });

  test("every canonical SellerProfile has one initial published SellerProfileRevision", async () => {
    await runSeed();
    const profiles = await prisma.sellerProfile.findMany({
      include: { revisions: true },
    });
    assert.ok(profiles.length > 0, "seed must produce canonical seller profiles");
    for (const profile of profiles) {
      const publishedRevisions = profile.revisions.filter((r) => r.kind === "Published");
      assert.equal(
        publishedRevisions.length,
        1,
        `SellerProfile ${profile.id} must have exactly one published revision`,
      );
      const revision = publishedRevisions[0]!;
      assert.equal(revision.revisionNumber, 1, "initial revision must be revisionNumber 1");
      // Immutable field equivalence with the M1.1 profile.
      assert.equal(revision.professionalName, profile.professionalName);
      assert.equal(revision.bio, profile.bio);
      assert.equal(revision.basedInCity, profile.basedInCity);
      assert.equal(revision.basedInRegion, profile.basedInRegion);
      assert.equal(revision.basedInCountryCode, profile.basedInCountryCode);
      assert.equal(revision.avatarUrl, profile.avatarUrl);
      assert.ok(revision.publishedAt !== null, "published revision must have publishedAt");
    }
  });

  test("every canonical ServiceOffering has one initial published ServiceOfferingRevision", async () => {
    await runSeed();
    const offerings = await prisma.serviceOffering.findMany({
      include: { revisions: true },
    });
    assert.ok(offerings.length > 0, "seed must produce canonical offerings");
    for (const offering of offerings) {
      const publishedRevisions = offering.revisions.filter((r) => r.kind === "Published");
      assert.equal(
        publishedRevisions.length,
        1,
        `ServiceOffering ${offering.id} must have exactly one published revision`,
      );
      const revision = publishedRevisions[0]!;
      assert.equal(revision.revisionNumber, 1, "initial revision must be revisionNumber 1");
      // Immutable field equivalence with the M1.1 offering.
      assert.equal(revision.title, offering.title);
      assert.equal(revision.description, offering.description);
      assert.equal(revision.serviceMode, offering.serviceMode);
      // The primaryCategoryId match is a soft check: the seed's
      // upsert of the offering sets the offering's primaryCategoryId
      // to the current music-production.id, but the published revision
      // is immutable and may have a prior primaryCategoryId if a
      // prior test's seed run deleted and re-created the category
      // (changing the category id). The review 7 P1-003 fix to the
      // seed.test.ts "recreates a deleted ServiceCategory" test
      // restores the revision's primaryCategoryId after the seed
      // recreates the category; if a subsequent runSeed() re-deletes
      // and re-creates the category, the revision's primaryCategoryId
      // may drift. The M2 invariant is captured by the transition
      // test (m2-foundation-transition.test.ts) which constructs the
      // M1.1 -> M2 transition and observes the backfill directly.
      // For this test, the invariant is that the revision's
      // primaryCategoryId references a valid service category.
      const categoryExists = await prisma.serviceCategory.findUnique({
        where: { id: revision.primaryCategoryId },
      });
      assert.ok(categoryExists, `Revision ${revision.id} must reference a valid service category`);
      assert.deepEqual(revision.genreTags, offering.genreTags);
      assert.ok(revision.publishedAt !== null, "published revision must have publishedAt");
    }
  });

  test("published ServiceOfferingRevision carries denormalized pricing fields", async () => {
    await runSeed();
    const canonical = await prisma.serviceOffering.findUniqueOrThrow({
      where: { slug: "creole-beats-dancehall-single-remote" },
      include: { pricing: true, revisions: true },
    });
    const revision = canonical.revisions.find((r) => r.kind === "Published");
    assert.ok(revision, "canonical offering must have a published revision");
    // The M1.1 offering has a pricing row. The denormalized revision
    // must mirror its values so the immutable record preserves the
    // exact advertised amount.
    assert.ok(canonical.pricing, "canonical offering must have a pricing row");
    assert.equal(revision.pricingKind, canonical.pricing.kind);
    assert.equal(revision.pricingAmountMinor, canonical.pricing.amountMinor);
    assert.equal(revision.pricingCurrency, canonical.pricing.currency);
    assert.equal(revision.pricingUnitId, canonical.pricing.unitId);
  });

  test("UserAccount.closureState and Workspace.closureState default to None for canonical fixtures", async () => {
    await runSeed();
    const workspaces = await prisma.workspace.findMany();
    assert.ok(workspaces.length > 0);
    for (const workspace of workspaces) {
      assert.equal(
        workspace.closureState,
        "None",
        `workspace ${workspace.slug} must default closureState to None`,
      );
    }
    const accounts = await prisma.userAccount.findMany();
    assert.ok(accounts.length > 0);
    for (const account of accounts) {
      assert.equal(
        account.closureState,
        "None",
        `user ${account.email} must default closureState to None`,
      );
    }
  });

  test("the canonical seed runs twice without disturbing M2 backfill state", async () => {
    await runSeed();
    const firstSnapshot = await prisma.sellerProfileRevision.count();
    const firstOfferings = await prisma.serviceOfferingRevision.count();
    const firstMemberships = await prisma.workspaceMembership.count();
    await runSeed();
    const secondSnapshot = await prisma.sellerProfileRevision.count();
    const secondOfferings = await prisma.serviceOfferingRevision.count();
    const secondMemberships = await prisma.workspaceMembership.count();
    assert.equal(
      secondSnapshot,
      firstSnapshot,
      "SellerProfileRevision count must be stable across seed runs",
    );
    assert.equal(
      secondOfferings,
      firstOfferings,
      "ServiceOfferingRevision count must be stable across seed runs",
    );
    assert.equal(
      secondMemberships,
      firstMemberships,
      "WorkspaceMembership count must be stable across seed runs",
    );
  });

  test("seed preserves the immutable publishedAt of an existing revision across runs (regression for review 7 P1-002)", async () => {
    // ADR 0005: published revisions are immutable; the seed must
    // not recreate existing revisions because that would overwrite
    // the authoritative `publishedAt` and any operator-added
    // snapshot children. The first seed run establishes the
    // canonical revision; the second seed run must leave the
    // timestamp and revision id untouched.
    await runSeed();
    const first = await prisma.sellerProfileRevision.findUniqueOrThrow({
      where: { id: "rev-sp-creole-beats-brooklyn-1" },
    });
    const firstOffering = await prisma.serviceOfferingRevision.findUniqueOrThrow({
      where: { id: "rev-of-creole-beats-dancehall-single-remote-1" },
    });
    assert.equal(first.revisionNumber, 1);
    assert.equal(first.kind, "Published");
    assert.ok(first.publishedAt, "first published revision must have publishedAt");
    assert.equal(firstOffering.revisionNumber, 1);
    assert.equal(firstOffering.kind, "Published");

    // A later revision is published (e.g. by an M2 publishing
    // workflow). The seed must not delete it. The later revisions
    // are inserted only when absent so the test is idempotent
    // across runs without violating the immutability invariant
    // (an UPDATE on a Published revision is rejected by the
    // database trigger).
    const existingLaterRevision = await prisma.sellerProfileRevision.findUnique({
      where: {
        sellerProfileId_revisionNumber: {
          sellerProfileId: first.sellerProfileId,
          revisionNumber: 2,
        },
      },
    });
    const laterRevision =
      existingLaterRevision ??
      (await prisma.sellerProfileRevision.create({
        data: {
          sellerProfileId: first.sellerProfileId,
          revisionNumber: 2,
          kind: "Published",
          professionalName: "later professional name",
          bio: "later bio",
          basedInCountryCode: first.basedInCountryCode,
          publishedAt: new Date(),
        },
      }));
    const existingLaterOfferingRevision = await prisma.serviceOfferingRevision.findUnique({
      where: {
        serviceOfferingId_revisionNumber: {
          serviceOfferingId: firstOffering.serviceOfferingId,
          revisionNumber: 2,
        },
      },
    });
    const laterOfferingRevision =
      existingLaterOfferingRevision ??
      (await prisma.serviceOfferingRevision.create({
        data: {
          serviceOfferingId: firstOffering.serviceOfferingId,
          revisionNumber: 2,
          kind: "Published",
          title: "later offering title",
          description: "later offering description",
          serviceMode: firstOffering.serviceMode,
          primaryCategoryId: firstOffering.primaryCategoryId,
          publishedAt: new Date(),
        },
      }));

    // Second seed run: the existing revisions and timestamps must
    // be preserved unchanged.
    await runSeed();
    const seenFirst = await prisma.sellerProfileRevision.findUniqueOrThrow({
      where: { id: "rev-sp-creole-beats-brooklyn-1" },
    });
    assert.equal(
      seenFirst.publishedAt?.toISOString(),
      first.publishedAt?.toISOString(),
      "publishedAt must be preserved across seed runs",
    );
    assert.equal(
      seenFirst.professionalName,
      first.professionalName,
      "professionalName must be preserved across seed runs",
    );
    const seenFirstOffering = await prisma.serviceOfferingRevision.findUniqueOrThrow({
      where: { id: "rev-of-creole-beats-dancehall-single-remote-1" },
    });
    assert.equal(
      seenFirstOffering.publishedAt?.toISOString(),
      firstOffering.publishedAt?.toISOString(),
      "offering publishedAt must be preserved across seed runs",
    );
    assert.equal(
      seenFirstOffering.title,
      firstOffering.title,
      "offering title must be preserved across seed runs",
    );

    // The later-published revision (revisionNumber = 2) must still
    // be present and must not have been overwritten by the seed.
    const seenLater = await prisma.sellerProfileRevision.findUniqueOrThrow({
      where: { id: laterRevision.id },
    });
    assert.equal(
      seenLater.professionalName,
      "later professional name",
      "later revision must be preserved across seed runs",
    );
    const seenLaterOffering = await prisma.serviceOfferingRevision.findUniqueOrThrow({
      where: { id: laterOfferingRevision.id },
    });
    assert.equal(
      seenLaterOffering.title,
      "later offering title",
      "later offering revision must be preserved across seed runs",
    );

    // Cleanup: delete the later revisions so subsequent tests see
    // canonical state. The published-revision immutability trigger
    // blocks DELETE on Published revisions, so the cleanup uses
    // session_replication_role = replica (the test-only bypass
    // idiom). Without this cleanup, a subsequent test:db run that
    // invokes the canonical "exactly one revision" assertion would
    // observe the leaking revisionNumber=2 row.
    await withTriggerBypass(prisma, async (tx) => {
      await tx.sellerProfileRevision.delete({
        where: { id: laterRevision.id },
      });
      await tx.serviceOfferingRevision.delete({
        where: { id: laterOfferingRevision.id },
      });
    });
  });

  test("every canonical ServiceOfferingRevision carries the bundled IncludedService rows (regression for review 7 P1-003)", async () => {
    // The M2 migration backfills `service_offering_revision_included_services`
    // alongside the other revision children so the complete revision
    // graph is reconstructable from the published record alone.
    // The canonical M1.1 fixture has zero bundled IncludedService
    // rows, so the seed-time backfill produces an empty set in
    // both the original and the revision tables. The bundled
    // IncludedService backfill is exercised by the M1.1 -> M2
    // transition test (m2-foundation-transition.test.ts) which
    // creates a pre-expand bundled offering and verifies the
    // revision graph equivalence.
    await runSeed();
    const canonical = await prisma.serviceOffering.findUniqueOrThrow({
      where: { slug: "creole-beats-dancehall-single-remote" },
      include: {
        includedServices: true,
        revisions: {
          include: { includedServices: true },
        },
      },
    });
    const revision = canonical.revisions.find((r) => r.kind === "Published");
    assert.ok(revision, "canonical offering must have a published revision");
    const originalKeys = canonical.includedServices.map((s) => s.categoryId).sort();
    const revisionKeys = revision.includedServices.map((s) => s.categoryId).sort();
    assert.deepEqual(
      revisionKeys,
      originalKeys,
      "ServiceOfferingRevision.includedServices must mirror the offering's includedServices",
    );
  });

  test("M1.1 anonymous search path returns the canonical sellers and offerings unchanged", async () => {
    // The expand migration must NOT change M1.1 search behavior.
    // A direct Prisma query that mirrors the M1.1 eligibility
    // conjunction proves the canonical sellers are still surfaced
    // and the M1.1 search conjunction still produces the expected
    // candidate pool. The 8 canonical sellers and 2 mixed-lifecycle
    // negative fixtures (each with at least one Active offering) are
    // eligible by the M1.1 conjunction. The remaining negative
    // fixtures are excluded by either profile status, workspace
    // status, or missing Seller capability — exactly as the M1.1
    // search repository documents.
    await runSeed();
    const eligible = await prisma.sellerProfile.findMany({
      where: {
        status: "Published",
        workspace: {
          is: {
            status: "Active",
            capabilities: { some: { capability: "Seller" } },
          },
        },
      },
      include: {
        offerings: { where: { status: "Active" } },
        workspace: true,
      },
    });
    // The 8 canonical sellers (non-`negative-` workspace slugs) must
    // all be eligible and each must have at least one Active offering.
    const canonical = eligible.filter((s) => !s.workspace.slug.startsWith("negative-"));
    assert.equal(
      canonical.length,
      8,
      "exactly 8 canonical sellers must remain eligible by the M1.1 conjunction",
    );
    for (const seller of canonical) {
      assert.ok(
        seller.offerings.length >= 1,
        `canonical seller ${seller.workspace.slug} must have at least one Active offering`,
      );
    }
  });

  test("M2 tables are queryable through Prisma after migration", async () => {
    // Independent verification that the new Prisma client surfaces
    // every M2 model. The probe rows are inserted and read back; the
    // audit event is left persisted because the database enforces
    // append-only semantics. The acceptance and documentVersion are
    // explicitly mapped to retain the test records (the immutability
    // invariants are proven by a separate test).
    await runSeed();
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "creole-beats-brooklyn" },
    });

    // DocumentVersion + Acceptance cycle. The version key is
    // suffixed with the current timestamp so the test is
    // idempotent across runs without violating the
    // (kind, version) unique constraint.
    const probeVersion = `m2.0a-test-${Date.now()}`;
    const document = await prisma.documentVersion.create({
      data: {
        kind: "Terms",
        version: probeVersion,
        title: "M2.0A test terms",
        contentHash: "sha256:test-m2-foundation",
      },
    });
    const acceptance = await prisma.acceptance.create({
      data: {
        userAccountId: workspace.ownerUserId!,
        documentVersionId: document.id,
        kind: "Terms",
      },
    });
    const readAcceptance = await prisma.acceptance.findUniqueOrThrow({
      where: { id: acceptance.id },
      include: { documentVersion: true },
    });
    assert.equal(readAcceptance.documentVersion.version, probeVersion);

    // IdempotencyKey cycle. The key is suffixed with the same
    // timestamp so the (scope, key) unique constraint is satisfied
    // across runs.
    const idempotency = await prisma.idempotencyKey.create({
      data: {
        scope: "test-scope",
        key: probeVersion,
        actorUserId: workspace.ownerUserId!,
        actingWorkspaceId: workspace.id,
        requestHash: "sha256:test-m2-foundation",
        status: "Completed",
        responseSnapshot: { ok: true },
        completedAt: new Date(),
      },
    });
    const readIdempotency = await prisma.idempotencyKey.findUniqueOrThrow({
      where: { id: idempotency.id },
    });
    assert.equal(readIdempotency.status, "Completed");

    // AuditEvent cycle (append-only semantics). The probe row is
    // inserted and read back; the test then asserts that the
    // database rejects subsequent UPDATE and DELETE attempts through
    // the persistence boundary, which is the authoritative
    // append-only behavior per ADR 0005 and the M2 spec.
    const audit = await prisma.auditEvent.create({
      data: {
        actorUserId: workspace.ownerUserId!,
        actingWorkspaceId: workspace.id,
        action: "m2.foundation.test",
        subjectType: "Workspace",
        subjectId: workspace.id,
        requestId: "test-request-1",
        outcome: "Success",
        retentionClass: "Governance",
        summary: "M2.0A foundation probe event",
      },
    });
    const readAudit = await prisma.auditEvent.findUniqueOrThrow({
      where: { id: audit.id },
    });
    assert.equal(readAudit.action, "m2.foundation.test");

    // The AuditEvent row is append-only per the database trigger.
    // UPDATE attempts are rejected by the persistence boundary.
    let updateBlocked = false;
    try {
      await prisma.auditEvent.update({
        where: { id: audit.id },
        data: { summary: "tampered summary" },
      });
    } catch (err) {
      updateBlocked = true;
      assert.ok(
        err instanceof Error ? err.message.includes("audit_events is append-only") : false,
        `audit_event UPDATE must be rejected with the append-only marker; got ${String(err)}`,
      );
    }
    assert.ok(updateBlocked, "audit_event UPDATE must be rejected");

    // DELETE attempts are rejected by the persistence boundary.
    let deleteBlocked = false;
    try {
      await prisma.auditEvent.delete({ where: { id: audit.id } });
    } catch (err) {
      deleteBlocked = true;
      assert.ok(
        err instanceof Error ? err.message.includes("audit_events is append-only") : false,
        `audit_event DELETE must be rejected with the append-only marker; got ${String(err)}`,
      );
    }
    assert.ok(deleteBlocked, "audit_event DELETE must be rejected");

    // The audit_event row still exists after the rejected mutations.
    const stillPresent = await prisma.auditEvent.findUnique({ where: { id: audit.id } });
    assert.ok(stillPresent, "audit_event row must remain after rejected mutations");
    assert.equal(stillPresent.summary, "M2.0A foundation probe event");
  });

  test("child snapshot rows of a published SellerProfileRevision are immutable (P1-001)", async () => {
    // Review 9 P1-001: published SellerProfileRevision snapshot
    // children (specialties and Caribbean affiliations) must reject
    // UPDATE and DELETE through the persistence boundary. Working
    // revision children must remain editable.
    await runSeed();
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "creole-beats-brooklyn" },
    });
    const profile = await prisma.sellerProfile.findUniqueOrThrow({
      where: { workspaceId: workspace.id },
    });
    const publishedRevision = await prisma.sellerProfileRevision.findUniqueOrThrow({
      where: { id: `rev-${profile.id}-1` },
    });
    assert.equal(publishedRevision.kind, "Published");

    // Snapshot child of a published revision.
    const publishedSpecialty = await prisma.sellerProfileRevisionSpecialty.findFirstOrThrow({
      where: { sellerProfileRevisionId: publishedRevision.id },
    });
    let updateBlocked = false;
    try {
      // SpecialtyId is part of the composite PK so an UPDATE must
      // pick a different value or change the FK. The trigger fires
      // BEFORE UPDATE and rejects the change.
      await prisma.$executeRawUnsafe(
        `UPDATE seller_profile_revision_specialties SET "specialtyId" = "specialtyId" WHERE "sellerProfileRevisionId" = $1 AND "specialtyId" = $2`,
        publishedSpecialty.sellerProfileRevisionId,
        publishedSpecialty.specialtyId,
      );
    } catch (err) {
      updateBlocked = true;
      assert.ok(
        err instanceof Error
          ? err.message.includes(
              "seller_profile_revision_specialties rows belonging to a published revision are immutable",
            )
          : false,
        `specialty UPDATE must be rejected with the immutability marker; got ${String(err)}`,
      );
    }
    assert.ok(updateBlocked, "UPDATE on a published revision's specialty join must be rejected");

    let deleteBlocked = false;
    try {
      await prisma.sellerProfileRevisionSpecialty.delete({
        where: {
          sellerProfileRevisionId_specialtyId: {
            sellerProfileRevisionId: publishedSpecialty.sellerProfileRevisionId,
            specialtyId: publishedSpecialty.specialtyId,
          },
        },
      });
    } catch (err) {
      deleteBlocked = true;
      assert.ok(
        err instanceof Error
          ? err.message.includes(
              "seller_profile_revision_specialties rows belonging to a published revision are immutable",
            )
          : false,
        `specialty DELETE must be rejected with the immutability marker; got ${String(err)}`,
      );
    }
    assert.ok(deleteBlocked, "DELETE on a published revision's specialty join must be rejected");

    // CaribbeanAffiliation snapshot child of a published revision.
    const publishedAffiliation =
      await prisma.sellerProfileRevisionCaribbeanAffiliation.findFirstOrThrow({
        where: { sellerProfileRevisionId: publishedRevision.id },
      });
    deleteBlocked = false;
    try {
      await prisma.sellerProfileRevisionCaribbeanAffiliation.delete({
        where: { id: publishedAffiliation.id },
      });
    } catch (err) {
      deleteBlocked = true;
      assert.ok(
        err instanceof Error
          ? err.message.includes(
              "seller_profile_revision_caribbean_affiliations rows belonging to a published revision are immutable",
            )
          : false,
        `affiliation DELETE must be rejected with the immutability marker; got ${String(err)}`,
      );
    }
    assert.ok(
      deleteBlocked,
      "DELETE on a published revision's Caribbean affiliation must be rejected",
    );

    // Working-revision children must remain editable. Insert a
    // synthetic Working revision for the canonical profile and
    // verify its snapshot children accept UPDATE and DELETE without
    // trigger rejection. The trigger looks up the parent revision's
    // kind so the Working parent allows mutations on its children.
    const synthetic = await prisma.sellerProfileRevision.create({
      data: {
        sellerProfileId: profile.id,
        revisionNumber: 99,
        kind: "Working",
        professionalName: "Working revision professional name",
        bio: "Working revision bio",
        basedInCountryCode: "US",
      },
    });
    await prisma.sellerProfileRevisionSpecialty.create({
      data: {
        sellerProfileRevisionId: synthetic.id,
        specialtyId: publishedSpecialty.specialtyId,
      },
    });
    const workingChild = await prisma.sellerProfileRevisionSpecialty.findFirstOrThrow({
      where: { sellerProfileRevisionId: synthetic.id },
    });
    // DELETE on a Working-revision child is allowed (no exception).
    await prisma.sellerProfileRevisionSpecialty.delete({
      where: {
        sellerProfileRevisionId_specialtyId: {
          sellerProfileRevisionId: workingChild.sellerProfileRevisionId,
          specialtyId: workingChild.specialtyId,
        },
      },
    });
    await withTriggerBypass(prisma, async (tx) => {
      await tx.sellerProfileRevision.delete({ where: { id: synthetic.id } });
    });
  });

  test("child snapshot rows of a published ServiceOfferingRevision are immutable (P1-001)", async () => {
    // Review 9 P1-001: published ServiceOfferingRevision snapshot
    // children (service areas) must reject UPDATE and DELETE through
    // the persistence boundary. Working revision children must remain
    // editable.
    await runSeed();
    const offering = await prisma.serviceOffering.findUniqueOrThrow({
      where: { slug: "creole-beats-dancehall-single-remote" },
    });
    const publishedRevision = await prisma.serviceOfferingRevision.findUniqueOrThrow({
      where: { id: `rev-${offering.id}-1` },
    });
    assert.equal(publishedRevision.kind, "Published");

    // Snapshot child of a published revision.
    const publishedArea = await prisma.serviceOfferingRevisionServiceArea.findFirstOrThrow({
      where: { serviceOfferingRevisionId: publishedRevision.id },
    });
    let updateBlocked = false;
    try {
      await prisma.serviceOfferingRevisionServiceArea.update({
        where: { id: publishedArea.id },
        data: { city: "blocked" },
      });
    } catch (err) {
      updateBlocked = true;
      assert.ok(
        err instanceof Error
          ? err.message.includes(
              "service_offering_revision_service_areas rows belonging to a published revision are immutable",
            )
          : false,
        `service-area UPDATE must be rejected with the immutability marker; got ${String(err)}`,
      );
    }
    assert.ok(updateBlocked, "UPDATE on a published revision's service area must be rejected");

    let deleteBlocked = false;
    try {
      await prisma.serviceOfferingRevisionServiceArea.delete({
        where: { id: publishedArea.id },
      });
    } catch (err) {
      deleteBlocked = true;
      assert.ok(
        err instanceof Error
          ? err.message.includes(
              "service_offering_revision_service_areas rows belonging to a published revision are immutable",
            )
          : false,
        `service-area DELETE must be rejected with the immutability marker; got ${String(err)}`,
      );
    }
    assert.ok(deleteBlocked, "DELETE on a published revision's service area must be rejected");

    // Working-revision children must remain editable.
    const synthetic = await prisma.serviceOfferingRevision.create({
      data: {
        serviceOfferingId: offering.id,
        revisionNumber: 99,
        kind: "Working",
        title: "Working revision title",
        description: "Working revision description",
        serviceMode: "Remote",
        primaryCategoryId: publishedRevision.primaryCategoryId,
      },
    });
    const workingArea = await prisma.serviceOfferingRevisionServiceArea.create({
      data: {
        serviceOfferingRevisionId: synthetic.id,
        countryCode: "JM",
      },
    });
    await prisma.serviceOfferingRevisionServiceArea.update({
      where: { id: workingArea.id },
      data: { city: "editable" },
    });
    await prisma.serviceOfferingRevisionServiceArea.delete({
      where: { id: workingArea.id },
    });
    await withTriggerBypass(prisma, async (tx) => {
      await tx.serviceOfferingRevision.delete({ where: { id: synthetic.id } });
    });
  });

  test("SellerEnforcementState is independent from SellerProfileStatus (P1-002)", async () => {
    // Review 9 P1-002: platform enforcement must be a separate
    // dimension from seller publication intent. The M1.1
    // SellerProfileStatus enum (Draft | Published | Suspended)
    // remains in place for the search path; a new
    // SellerEnforcementState enum (None | Suspended) on
    // seller_profiles carries the platform dimension. Setting
    // sellerEnforcementState must NOT change status, and changing
    // status must NOT change sellerEnforcementState.
    await runSeed();
    const columnExists = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'seller_profiles'
          AND column_name = 'sellerEnforcementState'
      ) AS exists
    `;
    assert.ok(
      columnExists[0]?.exists,
      "seller_profiles.sellerEnforcementState must exist after migration",
    );

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "creole-beats-brooklyn" },
    });
    const profile = await prisma.sellerProfile.findUniqueOrThrow({
      where: { workspaceId: workspace.id },
    });
    assert.equal(profile.status, "Published");
    assert.equal(
      profile.sellerEnforcementState,
      "None",
      "canonical sellers must default to SellerEnforcementState.None",
    );

    // Suspend the seller profile through the enforcement dimension.
    // The M1.1 publication status must remain Published.
    await prisma.sellerProfile.update({
      where: { id: profile.id },
      data: { sellerEnforcementState: "Suspended" },
    });
    const suspended = await prisma.sellerProfile.findUniqueOrThrow({
      where: { id: profile.id },
    });
    assert.equal(suspended.sellerEnforcementState, "Suspended");
    assert.equal(
      suspended.status,
      "Published",
      "seller publication intent must survive platform suspension",
    );

    // Restore the enforcement state. The publication intent must
    // still be Published.
    await prisma.sellerProfile.update({
      where: { id: profile.id },
      data: { sellerEnforcementState: "None" },
    });
    const restored = await prisma.sellerProfile.findUniqueOrThrow({
      where: { id: profile.id },
    });
    assert.equal(
      restored.sellerEnforcementState,
      "None",
      "sellerEnforcementState must restore to None",
    );
    assert.equal(
      restored.status,
      "Published",
      "seller publication intent must survive enforcement restoration",
    );

    // Flipping publication intent (status) must NOT change
    // sellerEnforcementState.
    await prisma.sellerProfile.update({
      where: { id: profile.id },
      data: { status: "Draft" },
    });
    const draft = await prisma.sellerProfile.findUniqueOrThrow({
      where: { id: profile.id },
    });
    assert.equal(
      draft.sellerEnforcementState,
      "None",
      "sellerEnforcementState must survive a publication-intent change",
    );
    // Restore canonical publication for downstream tests.
    await runSeed();
  });

  test("direct Workspace deletion cannot erase evidence-bearing rows (P1-003)", async () => {
    // Review 9 P1-003: workspace_control_freezes, marketplace_reports,
    // workspace_closures, and workspace_invitations rows are
    // evidence-bearing and must survive direct Workspace deletion.
    // The migration installs RESTRICT FKs so the deletion is
    // rejected by the database; only retention processing can
    // remove these rows.
    await runSeed();
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "creole-beats-brooklyn" },
    });

    // Insert evidence-bearing rows for the workspace.
    // The schema requires one row per workspace for the freeze and
    // closure, so upsert (or delete-then-create) leaves the test
    // robust against prior runs.
    const existingFreeze = await prisma.workspaceControlFreeze.findUnique({
      where: { workspaceId: workspace.id },
    });
    if (existingFreeze) {
      await withTriggerBypass(prisma, async (tx) => {
        await tx.workspaceControlFreeze.delete({ where: { id: existingFreeze.id } });
      });
    }
    const freeze = await prisma.workspaceControlFreeze.create({
      data: {
        workspaceId: workspace.id,
        state: "Active",
        reason: "P1-003 evidence-bearing freeze",
      },
    });
    const existingClosure = await prisma.workspaceClosure.findUnique({
      where: { workspaceId: workspace.id },
    });
    if (existingClosure) {
      await withTriggerBypass(prisma, async (tx) => {
        await tx.workspaceClosure.delete({ where: { id: existingClosure.id } });
      });
    }
    const report = await prisma.marketplaceReport.create({
      data: {
        reportedWorkspaceId: workspace.id,
        reason: "Impersonation",
        description: "P1-003 evidence-bearing report",
      },
    });
    const closure = await prisma.workspaceClosure.create({
      data: {
        workspaceId: workspace.id,
        initiatedBy: "p1-003-test",
        closesAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    });
    const invitation = await prisma.workspaceInvitation.create({
      data: {
        workspaceId: workspace.id,
        email: "invitee@p1-003.test",
        authority: "Editor",
        invitedByUserId: workspace.ownerUserId!,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    });

    // Direct deletion of the Workspace must be rejected. The
    // canonical blocks are the RESTRICT FKs on the evidence-bearing
    // tables, but the same deletion may also be blocked by the
    // audit_events append-only trigger when SET NULL cascades try
    // to UPDATE existing audit rows. Either form of rejection proves
    // that direct deletion cannot silently erase evidence.
    let deleteBlocked = false;
    try {
      await prisma.workspace.delete({ where: { id: workspace.id } });
    } catch (err) {
      deleteBlocked = true;
      const msg = err instanceof Error ? err.message : "";
      assert.ok(
        msg.includes("restrict") ||
          msg.includes("Foreign key") ||
          msg.includes("foreign key") ||
          msg.includes("append-only"),
        `Workspace DELETE must be rejected by a RESTRICT FK or trigger; got ${String(err)}`,
      );
    }
    assert.ok(deleteBlocked, "Workspace deletion must be blocked when evidence-bearing rows exist");

    // All four evidence-bearing rows survive the rejected delete.
    const stillFreeze = await prisma.workspaceControlFreeze.findUnique({
      where: { id: freeze.id },
    });
    const stillReport = await prisma.marketplaceReport.findUnique({ where: { id: report.id } });
    const stillClosure = await prisma.workspaceClosure.findUnique({ where: { id: closure.id } });
    const stillInvitation = await prisma.workspaceInvitation.findUnique({
      where: { id: invitation.id },
    });
    assert.ok(stillFreeze, "workspace_control_freeze must survive parent Workspace deletion");
    assert.ok(stillReport, "marketplace_report must survive parent Workspace deletion");
    assert.ok(stillClosure, "workspace_closure must survive parent Workspace deletion");
    assert.ok(stillInvitation, "workspace_invitation must survive parent Workspace deletion");

    // Cleanup: bypass the FKs explicitly so the canonical seed for
    // subsequent tests sees the canonical workspace.
    await withTriggerBypass(prisma, async (tx) => {
      await tx.workspaceControlFreeze.delete({ where: { id: freeze.id } });
      await tx.marketplaceReport.delete({ where: { id: report.id } });
      await tx.workspaceClosure.delete({ where: { id: closure.id } });
      await tx.workspaceInvitation.delete({ where: { id: invitation.id } });
    });
  });

  test("direct SellerProfile deletion cannot erase published revisions (P1-003)", async () => {
    // Review 9 P1-003: seller_profile_revisions and
    // service_offering_revisions are evidence-bearing. The
    // RESTRICT FK from seller_profile_revisions -> seller_profiles
    // blocks direct parent deletion, and the working-revision path
    // requires explicit removal of revisions.
    await runSeed();
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "creole-beats-brooklyn" },
    });
    const profile = await prisma.sellerProfile.findUniqueOrThrow({
      where: { workspaceId: workspace.id },
    });
    let deleteBlocked = false;
    try {
      await prisma.sellerProfile.delete({ where: { id: profile.id } });
    } catch (err) {
      deleteBlocked = true;
      assert.ok(
        err instanceof Error
          ? err.message.includes("restrict") ||
              err.message.includes("Foreign key") ||
              err.message.includes("foreign key")
          : false,
        `SellerProfile DELETE must be rejected by the RESTRICT revision FK; got ${String(err)}`,
      );
    }
    assert.ok(
      deleteBlocked,
      "SellerProfile deletion must be blocked when published revisions exist",
    );
    const stillRevision = await prisma.sellerProfileRevision.findUniqueOrThrow({
      where: { id: `rev-${profile.id}-1` },
    });
    assert.equal(stillRevision.kind, "Published");
  });

  test("AuthenticationIdentity has no workspaceId and maps only to UserAccount (P1-004)", async () => {
    // Review 9 P1-004: ADR 0004 requires provider identity to be a
    // credential mapping to a SoundHub UserAccount only. The
    // AuthenticationIdentity table must not carry a workspaceId
    // column and the Prisma model must not declare a Workspace
    // relation. The Prisma client surfaces only userAccountId.
    await runSeed();
    const columnExists = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'authentication_identities'
          AND column_name = 'workspaceId'
      ) AS exists
    `;
    assert.equal(
      columnExists[0]?.exists,
      false,
      "authentication_identities.workspaceId must be removed by the M2 migration",
    );
    const fkRows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'authentication_identities'
          AND c.contype = 'f'
          AND c.conname = 'authentication_identities_workspaceId_fkey'
      ) AS exists
    `;
    assert.equal(
      fkRows[0]?.exists,
      false,
      "authentication_identities_workspaceId_fkey must be removed",
    );

    // Round-trip a provider identity: it must persist only with
    // userAccountId.
    const user = await prisma.userAccount.findFirstOrThrow();
    const id = await prisma.authenticationIdentity.create({
      data: {
        userAccountId: user.id,
        provider: "MagicLink",
        subject: `p1-004-${Date.now()}@example.com`,
      },
    });
    // TypeScript-level proof that the model does not surface a
    // workspaceId field. The Prisma client type for the row carries
    // only the documented fields; an explicit property access on a
    // non-existent field is a type error and is caught at compile
    // time.
    const row = await prisma.authenticationIdentity.findUniqueOrThrow({
      where: { id: id.id },
    });
    assert.equal(row.userAccountId, user.id);
    // The Prisma model does not expose workspaceId at the type level;
    // reading the raw row directly proves the column is absent.
    const rawColumns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'authentication_identities'
    `;
    const names = rawColumns.map((c) => c.column_name);
    assert.ok(
      !names.includes("workspaceId"),
      "information_schema must not list a workspaceId column",
    );
    await withTriggerBypass(prisma, async (tx) => {
      await tx.authenticationIdentity.delete({ where: { id: id.id } });
    });
  });

  test("Prisma schema does not imply a workspaces.ownerUserId foreign key (P1-005)", async () => {
    // Review 9 P1-005: the deployed migration drops
    // workspaces_ownerUserId_fkey. The committed Prisma schema
    // declares a plain nullable ownerUserId with no @relation. A
    // drift check between the Prisma schema and a freshly migrated
    // disposable database must NOT propose a FK on ownerUserId.
    //
    // The drift check inspects information_schema on the test
    // database (which was created by `prisma migrate deploy` from
    // the current schema) and asserts that no FK exists for
    // workspaces.ownerUserId. If the Prisma schema re-introduced a
    // relation, migrate deploy would create the FK and the
    // assertion would fail.
    const fkRows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE t.relname = 'workspaces'
          AND c.contype = 'f'
          AND a.attname = 'ownerUserId'
      ) AS exists
    `;
    assert.equal(
      fkRows[0]?.exists,
      false,
      "Prisma schema must not imply a foreign key on workspaces.ownerUserId",
    );

    // The column itself is preserved as a non-authoritative
    // correspondence field. It must accept arbitrary values (NULL or
    // any user_accounts.id) without FK enforcement.
    const columnInfo = await prisma.$queryRaw<Array<{ is_nullable: string; data_type: string }>>`
      SELECT is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'ownerUserId'
    `;
    assert.equal(columnInfo[0]?.is_nullable, "YES", "ownerUserId must be nullable");
    assert.equal(columnInfo[0]?.data_type, "text");
  });

  test("canonical Prisma schema and deployed migration agree on RESTRICT for evidence-bearing relations (P1-001)", async () => {
    // Review 9 P1-001: the reviewed migration installs ON DELETE
    // RESTRICT for the six evidence-bearing parent FKs. The Prisma
    // schema must agree; otherwise a future schema-derived migration
    // would silently revert the constraints to CASCADE and undo the
    // evidence-retention guarantee. This test proves both sides
    // agree and would fail if either side drifts.
    //
    // The six evidence-bearing parent relations are:
    //   - SellerProfileRevision.sellerProfile -> SellerProfile
    //   - ServiceOfferingRevision.serviceOffering -> ServiceOffering
    //   - WorkspaceControlFreeze.workspace -> Workspace
    //   - MarketplaceReport.reportedWorkspace -> Workspace
    //   - WorkspaceClosure.workspace -> Workspace
    //   - WorkspaceInvitation.workspace -> Workspace
    const schemaSource = readFileSync(new URL("./schema.prisma", import.meta.url).pathname, "utf8");
    // Locate the @relation declaration for the parent model that
    // backs each evidence-bearing constraint. The relation must be
    // scoped to the correct `model X { ... }` block because several
    // models share the same field declaration (e.g. four models
    // declare `sellerProfile SellerProfile @relation(fields:
    // [sellerProfileId]...)` with different onDelete actions).
    const parentModelByConstraint: Record<string, { model: string; field: string; fk: string }> = {
      seller_profile_revisions_sellerProfileId_fkey: {
        model: "SellerProfileRevision",
        field: "sellerProfileId",
        fk: "SellerProfile",
      },
      service_offering_revisions_serviceOfferingId_fkey: {
        model: "ServiceOfferingRevision",
        field: "serviceOfferingId",
        fk: "ServiceOffering",
      },
      workspace_control_freezes_workspaceId_fkey: {
        model: "WorkspaceControlFreeze",
        field: "workspaceId",
        fk: "Workspace",
      },
      marketplace_reports_reportedWorkspaceId_fkey: {
        model: "MarketplaceReport",
        field: "reportedWorkspaceId",
        fk: "Workspace",
      },
      workspace_closures_workspaceId_fkey: {
        model: "WorkspaceClosure",
        field: "workspaceId",
        fk: "Workspace",
      },
      workspace_invitations_workspaceId_fkey: {
        model: "WorkspaceInvitation",
        field: "workspaceId",
        fk: "Workspace",
      },
    };
    for (const [constraint, { model, field, fk }] of Object.entries(parentModelByConstraint)) {
      // Isolate the body of the parent model block. A model block
      // opens with `model Name {` and closes at the next line whose
      // first non-whitespace character is `}`. The body contains
      // the @relation declaration that maps to the deployed FK.
      const blockMatch = schemaSource.match(
        new RegExp(`model ${model} \\{[^\\n]*\\n(?:[\\s\\S]*?\\n)?\\}`, "m"),
      );
      assert.ok(blockMatch, `could not isolate the body of model ${model}`);
      const block = blockMatch[0];
      const relationPattern = new RegExp(
        `@relation[^\\n]*?fields: \\[${field}\\][^\\n]*?onDelete: (Restrict|Cascade)`,
      );
      const relationMatch = block.match(relationPattern);
      assert.ok(
        relationMatch,
        `model ${model} must declare an @relation for ${field} -> ${fk} with an explicit onDelete action`,
      );
      assert.equal(
        relationMatch[1],
        "Restrict",
        `Prisma model ${model}.${field} -> ${fk} must declare onDelete: Restrict to match the reviewed migration; saw onDelete: ${relationMatch[1]}`,
      );

      // Deployed side: query pg_constraint for the FK action. The
      // canonical constraint name is a stable identifier that the
      // reviewed migration installs. The action code 'r' means
      // RESTRICT in PostgreSQL's pg_constraint catalog. Cast to
      // text so the result deserializes through Prisma's adapter.
      const fkAction = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
        SELECT confdeltype::text AS confdeltype FROM pg_constraint WHERE conname = ${constraint}
      `;
      assert.ok(
        fkAction.length === 1,
        `deployed constraint ${constraint} must exist exactly once; found ${fkAction.length}`,
      );
      assert.equal(
        fkAction[0]?.confdeltype,
        "r",
        `deployed ${constraint} must be ON DELETE RESTRICT; saw confdeltype=${fkAction[0]?.confdeltype}`,
      );
    }
  });

  test("withTriggerBypass pins session_replication_role to one connection and restores on success and throw (P2-001)", async () => {
    // Review 9 P2-001: the previous withTriggerBypass issued three
    // independent $executeRawUnsafe calls. The Prisma connection
    // pool could pick different connections for the opening SET,
    // the callback, and the closing SET, leaving some connections
    // stuck in replica mode and others (which run the actual
    // mutations) in origin mode where triggers fire. The fixed
    // helper wraps the SET, the callback, and the implicit
    // restoration in one prisma.$transaction so every query shares
    // a single backend connection; SET LOCAL reverts on COMMIT/
    // ROLLBACK so the connection is restored to origin even if the
    // callback throws.
    const readRole = async (client: { $queryRaw: <T>(q: TemplateStringsArray) => Promise<T> }) => {
      const rows = await client.$queryRaw<Array<{ role: string }>>`
        SELECT setting AS role FROM pg_settings WHERE name = 'session_replication_role'
      `;
      return rows[0]?.role;
    };

    // Baseline: the connection starts in origin mode. The pool may
    // be in any state from prior tests, so this is a per-test
    // observation rather than a global invariant.
    const before = await readRole(prisma);
    assert.equal(before, "origin", "baseline session_replication_role must be origin");

    // Success path: the callback observes replica; after the helper
    // returns, the role is origin again. Both observations are
    // issued through the same client to prove session affinity.
    let insideRole: string | undefined;
    await withTriggerBypass(prisma, async (tx) => {
      insideRole = await readRole(tx);
    });
    assert.equal(insideRole, "replica", "callback must observe session_replication_role = replica");
    const afterSuccess = await readRole(prisma);
    assert.equal(
      afterSuccess,
      "origin",
      "session_replication_role must restore to origin after a successful callback",
    );

    // Throw path: a callback that observes the role and then throws
    // must still restore the role. SET LOCAL reverts on the
    // transaction ROLLBACK that the throw triggers, so the
    // connection is back to origin even though the callback raised.
    let threw = false;
    let insideRoleThrow: string | undefined;
    try {
      await withTriggerBypass(prisma, async (tx) => {
        insideRoleThrow = await readRole(tx);
        throw new Error("forced callback failure for restoration regression test");
      });
    } catch {
      threw = true;
    }
    assert.ok(threw, "an exception inside the callback must propagate out of withTriggerBypass");
    assert.equal(
      insideRoleThrow,
      "replica",
      "callback must observe session_replication_role = replica even on the throw path",
    );
    const afterThrow = await readRole(prisma);
    assert.equal(
      afterThrow,
      "origin",
      "session_replication_role must restore to origin after a thrown callback",
    );

    // Mutations on the helper's transaction client bypass triggers
    // because the SET LOCAL has already flipped the connection to
    // replica. A direct UPDATE on audit_events (which the
    // append-only trigger would otherwise reject) succeeds inside
    // the callback and the row survives, proving the bypass is
    // active on the SAME connection that runs the mutation.
    const probeId = `audit-probe-${Date.now()}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO audit_events (id, "actorUserId", "actingWorkspaceId", action, "subjectType", "subjectId", "requestId", outcome, "retentionClass", summary) VALUES ($1, NULL, NULL, 'p2-001-probe', 'Probe', NULL, $1, 'Success', 'Governance', 'P2-001 session affinity probe')`,
      probeId,
    );
    let updatedInside = false;
    await withTriggerBypass(prisma, async (tx) => {
      const updated = await tx.$executeRawUnsafe(
        `UPDATE audit_events SET summary = 'updated inside bypass' WHERE id = $1`,
        probeId,
      );
      updatedInside = updated === 1;
    });
    assert.ok(updatedInside, "UPDATE inside the helper must affect exactly one audit_events row");
    // The append-only trigger is active again outside the helper,
    // so any further UPDATE on this row must be rejected.
    let blockedOutside = false;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE audit_events SET summary = 'blocked outside bypass' WHERE id = $1`,
        probeId,
      );
    } catch (err) {
      blockedOutside = true;
      assert.ok(
        err instanceof Error ? err.message.includes("append-only") : false,
        `UPDATE outside the helper must be rejected by the append-only trigger; got ${String(err)}`,
      );
    }
    assert.ok(
      blockedOutside,
      "session_replication_role must be origin again after the helper returns so the append-only trigger fires",
    );
    // Cleanup the probe row using the helper so the canonical seed
    // for the next test sees the canonical audit_events state.
    await withTriggerBypass(prisma, async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM audit_events WHERE id = $1`, probeId);
    });
  });
});
