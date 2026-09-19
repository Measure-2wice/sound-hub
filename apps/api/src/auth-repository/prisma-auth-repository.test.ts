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
    // The seed persists the demo buyer `IdentityProvider` row under
    // the HASHED subject the deterministic adapter derives at
    // sign-in time (seed.ts:1072). A literal `"demo-buyer"` lookup
    // would never resolve — only the derivation round-trips.
    const { createHash } = await import("node:crypto");
    const { deriveDeterministicSubject } = await import("@soundhub/types");
    const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
    const demoBuyerSubject = deriveDeterministicSubject("demo.buyer@soundhub.example", sha256);
    const mapping = await repo.findUserByIdentity({
      provider: "deterministic",
      subject: demoBuyerSubject,
    });
    assert.ok(mapping);
    assert.equal(mapping.provider, "deterministic");
    assert.equal(mapping.subject, demoBuyerSubject);
    assert.equal(mapping.providerEmail, "demo.buyer@soundhub.example");
  });

  test("createUserForIdentity attaches every new provider credential to the SAME SoundHub UserAccount for that email (P1-001)", async (t) => {
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
      where: { subject: { in: ["first-credential", "second-credential", "third-credential"] } },
    });
    await prisma.userAccount.deleteMany({
      where: { email: "linked-user@soundhub.example" },
    });
    // Pre-create a UserAccount with an email and NO IdentityProvider
    // mappings. This models the application-owned linking seam: a
    // SoundHub-managed account exists before the human first signs
    // in via a provider.
    const precreated = await prisma.userAccount.create({
      data: { email: "linked-user@soundhub.example" },
    });
    try {
      const first = await repo.createUserForIdentity({
        provider: "managed-magic-link",
        subject: "first-credential",
        providerEmail: "linked-user@soundhub.example",
      });
      // The new IdentityProvider must point to the PRE-EXISTING
      // UserAccount, not a freshly-created one.
      assert.equal(first.userAccountId, precreated.id);

      // Application-owned verified linking: a second provider for
      // the same email attaches to the SAME UserAccount. The
      // marketplace identity does not change when the human
      // changes providers.
      const second = await repo.createUserForIdentity({
        provider: "deterministic",
        subject: "second-credential",
        providerEmail: "linked-user@soundhub.example",
      });
      assert.equal(second.userAccountId, precreated.id);

      // A third credential (yet another provider) keeps linking to
      // the same UserAccount; the user accumulates providers but
      // never loses their marketplace identity.
      const third = await repo.createUserForIdentity({
        provider: "managed-magic-link",
        subject: "third-credential",
        providerEmail: "linked-user@soundhub.example",
      });
      assert.equal(third.userAccountId, precreated.id);

      const mappings = await prisma.identityProvider.findMany({
        where: { userAccountId: precreated.id },
      });
      assert.equal(mappings.length, 3);
    } finally {
      void prisma.identityProvider.deleteMany({
        where: { providerEmail: "linked-user@soundhub.example" },
      });
      void prisma.identityProvider.deleteMany({
        where: { subject: { in: ["first-credential", "second-credential", "third-credential"] } },
      });
      void prisma.userAccount.deleteMany({
        where: { email: "linked-user@soundhub.example" },
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

  test("createInitialPersonalWorkspace returns an opaque slug matching ^personal-c[a-z0-9]+$ AND equals personal-<workspaceId>", async (t) => {
    // Codex review (P1-002): the slug must be opaque, lowercase
    // alphanumeric, prefixed with `personal-c`, free of email or
    // provider subject fragments, AND the plan-approved invariant
    // `slug === "personal-" + workspace.id` must hold — the slug
    // identifier IS the Workspace id.
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    // Clean up any leftover rows from a previous run so this test
    // is hermetic.
    const TEST_EMAIL = "slug-shape@example.test";
    await prisma.workspaceMembership.deleteMany({
      where: { user: { email: TEST_EMAIL } },
    });
    await prisma.workspace.deleteMany({
      where: { slug: { startsWith: "personal-c" }, owner: { email: TEST_EMAIL } },
    });
    await prisma.userAccount.deleteMany({ where: { email: TEST_EMAIL } });

    const freshUser = await prisma.userAccount.create({
      data: { email: TEST_EMAIL },
    });
    try {
      const result = await repo.createInitialPersonalWorkspace({
        userAccountId: freshUser.id,
      });
      assert.match(result.slug, /^personal-c[a-z0-9]+$/, "slug must match ^personal-c[a-z0-9]+$");
      assert.equal(
        result.slug,
        `personal-${result.workspaceId}`,
        "slug must equal personal-<workspaceId> per the plan-approved invariant",
      );
      assert.equal(result.slug.includes("@"), false, "slug must not contain '@' (no email leak)");
      // Stability: a second createInitialPersonalWorkspace call on
      // the SAME UserAccount will lose the CAS (pointer is already
      // set) and throw ConvergenceRaceError — the repository's
      // atomic boundary. The convergence service catches this and
      // re-reads the winner's records. We catch here too so the
      // assertion is hermetic.
      let second: { workspaceId: string; slug: string } | null = null;
      try {
        second = await repo.createInitialPersonalWorkspace({
          userAccountId: freshUser.id,
        });
      } catch (err) {
        if (!(err instanceof Error) || err.name !== "ConvergenceRaceError") {
          throw err;
        }
      }
      // Whether the second call succeeded or hit the CAS boundary,
      // the persisted slug (the one returned from the first call)
      // must be the canonical one the UserAccount is linked to.
      const persisted = await prisma.workspace.findUnique({
        where: { id: result.workspaceId },
      });
      assert.ok(persisted, "the persisted Workspace must still exist");
      assert.equal(
        persisted.slug,
        result.slug,
        "the persisted slug must equal the first call's slug",
      );
      // If the second call succeeded (e.g., pointer was reset),
      // both must agree.
      if (second) {
        assert.equal(second.slug, result.slug, "second call must agree on slug");
      }
    } finally {
      await prisma.userAccount.update({
        where: { id: freshUser.id },
        data: { personalWorkspaceId: null },
      });
      await prisma.workspaceMembership.deleteMany({ where: { userId: freshUser.id } });
      await prisma.workspace.deleteMany({ where: { ownerUserId: freshUser.id } });
      await prisma.userAccount.delete({ where: { id: freshUser.id } });
    }
  });
});
