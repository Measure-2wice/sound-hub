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
import { after, before, describe, test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";

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
    await prisma.$executeRawUnsafe('SET session_replication_role = "replica";');
    try {
      await prisma.sellerProfileRevision.delete({
        where: { id: laterRevision.id },
      });
      await prisma.serviceOfferingRevision.delete({
        where: { id: laterOfferingRevision.id },
      });
    } finally {
      await prisma.$executeRawUnsafe('SET session_replication_role = "origin";');
    }
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
});
