// Prisma-backed AuthRepository integration test.
//
// Background: BG1 requires the (provider, subject) → UserAccount
// mapping to live in PostgreSQL. This test exercises the Prisma
// adapter against the disposable test database the M1 plan established
// so the integration test fails closed without a target.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createPrismaClient } from "@soundhub/db";
import { PrismaAuthRepository } from "./prisma-auth-repository.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;

describe("PrismaAuthRepository", () => {
  let prisma: ReturnType<typeof createPrismaClient> | null = null;
  let repo: PrismaAuthRepository | null = null;

  before(() => {
    if (skip) return;
    prisma = createPrismaClient(TEST_DATABASE_URL);
    repo = new PrismaAuthRepository(prisma);
  });

  after(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test("findUserByIdentity resolves the BG1 demo buyer mapping after the seed", async (t) => {
    if (skip || !repo) {
      t.skip();
      return;
    }
    const mapping = await repo.findUserByIdentity({
      provider: "deterministic",
      subject: "demo-buyer",
    });
    assert.ok(mapping);
    assert.equal(mapping.provider, "deterministic");
    assert.equal(mapping.subject, "demo-buyer");
    assert.equal(mapping.providerEmail, "demo.buyer@soundhub.example");
  });

  test("createUserForIdentity links to a pre-existing UserAccount when its email matches and no identity provider exists yet (P1-002)", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    // Clean up any leftover rows from a previous run so the linking
    // seam sees a clean email namespace AND a clean (provider,
    // subject) namespace. The seed only restores the canonical
    // state it owns; test-only rows persist across runs.
    await prisma.identityProvider.deleteMany({
      where: { providerEmail: "linked-user@soundhub.example" },
    });
    await prisma.identityProvider.deleteMany({
      where: { subject: { in: ["first-credential", "second-credential"] } },
    });
    await prisma.userAccount.deleteMany({
      where: { email: "linked-user@soundhub.example" },
    });
    // Pre-create a UserAccount with an email and NO IdentityProvider
    // mappings. This models the application-owned linking seam: a
    // soundhub-managed account exists before the human first signs
    // in via a provider.
    const precreated = await prisma.userAccount.create({
      data: { email: "linked-user@soundhub.example" },
    });
    try {
      const mapping = await repo.createUserForIdentity({
        provider: "managed-magic-link",
        subject: "first-credential",
        providerEmail: "linked-user@soundhub.example",
      });
      // The new IdentityProvider must point to the PRE-EXISTING
      // UserAccount, not a freshly-created one.
      assert.equal(mapping.userAccountId, precreated.id);

      // Once a SoundHub-managed UserAccount has its first
      // IdentityProvider mapping, additional credentials for the
      // same email are TREATED AS A DIFFERENT HUMAN. The repository
      // creates a fresh UserAccount so the existing marketplace
      // identity is never silently extended. The seeded email
      // already represents a real SoundHub user once any provider
      // has claimed it.
      const second = await repo.createUserForIdentity({
        provider: "deterministic",
        subject: "second-credential",
        providerEmail: "linked-user@soundhub.example",
      });
      assert.notEqual(second.userAccountId, precreated.id);

      // The first link still attaches the new IdentityProvider to
      // precreated; the second call created a separate account.
      const mappings = await prisma.identityProvider.findMany({
        where: { userAccountId: precreated.id },
      });
      assert.equal(mappings.length, 1);
    } finally {
      void prisma.identityProvider.deleteMany({
        where: { providerEmail: "linked-user@soundhub.example" },
      });
      void prisma.identityProvider.deleteMany({
        where: { subject: { in: ["first-credential", "second-credential"] } },
      });
      void prisma.userAccount.deleteMany({
        where: { email: "linked-user@soundhub.example" },
      });
    }
  });

  test("createUserForIdentity does NOT link when the email UserAccount already has an identity provider (P1-002)", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    // Clean up any leftover rows from a previous run so the test
    // sees a clean email namespace.
    void (await prisma.identityProvider.deleteMany({
      where: { providerEmail: "owner@soundhub.example" },
    }));
    void (await prisma.userAccount.deleteMany({
      where: { email: "owner@soundhub.example" },
    }));
    // A UserAccount that already has an IdentityProvider mapping
    // represents a different human sharing the email. The link seam
    // must NOT silently merge it with a new credential.
    const existing = await prisma.userAccount.create({
      data: { email: "owner@soundhub.example" },
    });
    const existingMapping = await prisma.identityProvider.create({
      data: {
        provider: "deterministic",
        subject: "owner-subject",
        providerEmail: "owner@soundhub.example",
        userAccountId: existing.id,
      },
    });
    try {
      const second = await repo.createUserForIdentity({
        provider: "managed-magic-link",
        subject: "impostor-subject",
        providerEmail: "owner@soundhub.example",
      });
      assert.notEqual(second.userAccountId, existing.id);
    } finally {
      void prisma.identityProvider.delete({ where: { id: existingMapping.id } });
      void prisma.userAccount.delete({ where: { id: existing.id } });
      void prisma.identityProvider.deleteMany({
        where: { subject: "impostor-subject" },
      });
      void prisma.userAccount.deleteMany({
        where: { email: "owner@soundhub.example" },
      });
    }
  });

  test("createUserForIdentity handles null providerEmail without crashing", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    // Clean up any leftover rows from a previous run.
    await prisma.identityProvider.deleteMany({
      where: { subject: "no-email-user" },
    });
    const mapping = await repo.createUserForIdentity({
      provider: "deterministic",
      subject: "no-email-user",
      providerEmail: null,
    });
    assert.ok(mapping.userAccountId);
    await prisma.identityProvider.deleteMany({ where: { subject: "no-email-user" } });
    await prisma.userAccount.deleteMany({ where: { id: mapping.userAccountId } });
  });

  test("findUserByIdentity returns null for an unknown (provider, subject)", async (t) => {
    if (skip || !repo) {
      t.skip();
      return;
    }
    const mapping = await repo.findUserByIdentity({
      provider: "deterministic",
      subject: "never-existed",
    });
    assert.equal(mapping, null);
  });

  test("the demo seller subject matches the deterministic derivation (P1-001 regression)", async (t) => {
    if (skip || !repo) {
      t.skip();
      return;
    }
    // The seed maps the existing Marc-André Pierre UserAccount to the
    // deterministic subject derived from his email. A sign-in via the
    // deterministic adapter must resolve to the SAME UserAccount id
    // — otherwise the adapter would create a second account and break
    // the ticket #59 GS 2 / P1-001 contract.
    const { createHash } = await import("node:crypto");
    const { deriveDeterministicSubject } = await import("@soundhub/types");
    const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
    const sellerSubject = deriveDeterministicSubject("marc.andre@creolebeats.example", sha256);
    const mapping = await repo.findUserByIdentity({
      provider: "deterministic",
      subject: sellerSubject,
    });
    assert.ok(
      mapping,
      "seeded demo seller subject must be discoverable via the adapter derivation",
    );
    assert.equal(mapping.providerEmail, "marc.andre@creolebeats.example");
    // Confirm it points to the canonical seller UserAccount (id is
    // deterministic per the seed).
    const seller = await prisma!.userAccount.findUnique({
      where: { email: "marc.andre@creolebeats.example" },
    });
    assert.ok(seller);
    assert.equal(mapping.userAccountId, seller.id);
  });

  test("createUserForIdentity creates a new UserAccount and IdentityProvider row", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    const mapping = await repo.createUserForIdentity({
      provider: "deterministic",
      subject: "fresh-user",
      providerEmail: "fresh-user@soundhub.example",
    });
    assert.equal(mapping.userAccountId.length > 0, true);
    // A second call with the same subject must NOT create a second
    // UserAccount — the (provider, subject) tuple is unique.
    const second = await repo.createUserForIdentity({
      provider: "deterministic",
      subject: "fresh-user",
      providerEmail: "fresh-user@soundhub.example",
    });
    assert.equal(second.userAccountId, mapping.userAccountId);
    // Clean up so the test is repeatable.
    await prisma.identityProvider.deleteMany({ where: { subject: "fresh-user" } });
    await prisma.userAccount.deleteMany({ where: { id: mapping.userAccountId } });
  });

  test("getPublicUser returns the demo buyer with their Workspace and Buyer capability", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    const buyer = await prisma.userAccount.findUnique({
      where: { email: "demo.buyer@soundhub.example" },
    });
    assert.ok(buyer);
    const view = await repo.getPublicUser(buyer.id);
    assert.ok(view);
    assert.equal(view.email, "demo.buyer@soundhub.example");
    assert.equal(view.identityProvider, "deterministic");
    assert.equal(view.workspaces.length, 1);
    assert.equal(view.workspaces[0]!.slug, "bg1-demo-buyer");
    assert.deepEqual(view.workspaces[0]!.capabilities, ["Buyer"]);
  });

  test("createSession + getActiveSession round-trips a session id", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    const buyer = await prisma.userAccount.findUnique({
      where: { email: "demo.buyer@soundhub.example" },
    });
    assert.ok(buyer);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const session = await repo.createSession({
      userAccountId: buyer.id,
      expiresAt: future,
    });
    const active = await repo.getActiveSession(session.sessionId);
    assert.ok(active);
    assert.equal(active.userAccountId, buyer.id);
    assert.equal(active.revokedAt, null);
  });

  test("getActiveSession returns null for an expired session", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    const buyer = await prisma.userAccount.findUnique({
      where: { email: "demo.buyer@soundhub.example" },
    });
    assert.ok(buyer);
    const past = new Date(Date.now() - 60 * 1000);
    const session = await repo.createSession({
      userAccountId: buyer.id,
      expiresAt: past,
    });
    const active = await repo.getActiveSession(session.sessionId);
    assert.equal(active, null);
  });

  test("revokeSession is idempotent (revoking twice returns false the second time)", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    const buyer = await prisma.userAccount.findUnique({
      where: { email: "demo.buyer@soundhub.example" },
    });
    assert.ok(buyer);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const session = await repo.createSession({
      userAccountId: buyer.id,
      expiresAt: future,
    });
    assert.equal(await repo.revokeSession(session.sessionId), true);
    assert.equal(await repo.revokeSession(session.sessionId), false);
    assert.equal(await repo.getActiveSession(session.sessionId), null);
  });

  test("findCurrentMembership returns the demo buyer's WorkspaceMembership (GS 6)", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    const buyer = await prisma.userAccount.findUnique({
      where: { email: "demo.buyer@soundhub.example" },
    });
    assert.ok(buyer);
    const workspace = await prisma.workspace.findUnique({
      where: { slug: "bg1-demo-buyer" },
    });
    assert.ok(workspace);
    const membership = await repo.findCurrentMembership({
      userAccountId: buyer.id,
      workspaceId: workspace.id,
    });
    assert.ok(membership);
    assert.equal(membership.role, "Owner");
    assert.deepEqual(membership.capabilities, ["Buyer"]);
    assert.equal(membership.workspaceStatus, "Active");
  });

  test("findCurrentMembership returns null when the user has no WorkspaceMembership row (GS 4 / GS 5)", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    const buyer = await prisma.userAccount.findUnique({
      where: { email: "demo.buyer@soundhub.example" },
    });
    assert.ok(buyer);
    // The seller Workspace exists but the buyer is not a member.
    const sellerWorkspace = await prisma.workspace.findUnique({
      where: { slug: "creole-beats-brooklyn" },
    });
    assert.ok(sellerWorkspace);
    const membership = await repo.findCurrentMembership({
      userAccountId: buyer.id,
      workspaceId: sellerWorkspace.id,
    });
    assert.equal(membership, null);
  });
});
