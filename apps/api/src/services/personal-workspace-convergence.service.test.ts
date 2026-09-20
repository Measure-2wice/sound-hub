// Personal Workspace Convergence service tests (M2 #82).
//
// Background: the convergence service decides between
// `converged | none | attachable | recovery` and orchestrates the
// create/attach transactions by calling the AuthRepository primitives.
// These tests pin the decision and orchestration logic via an
// in-memory AuthRepository.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { ConvergenceRaceError } from "../lib/personal-workspace-convergence-domain.js";
import { PersonalWorkspaceConvergenceService } from "./personal-workspace-convergence.service.js";

const USER_ID = "user-1";
const WORKSPACE_ID = "ws-personal";
const ORG_WORKSPACE_ID = "ws-org";
const OTHER_PERSONAL_ID = "ws-personal-2";
// Stable clock for the co-ownership fixtures so the
// InMemoryAuthRepository's `createdAt` is deterministic across
// runs and the test never depends on the wall clock.
const now = 1_700_000_000_000;

function makeRepo(): InMemoryAuthRepository {
  return new InMemoryAuthRepository([
    {
      userAccountId: USER_ID,
      email: "buyer@example.com",
      identityProvider: "deterministic",
      identitySubject: "buyer-subject",
      memberships: [
        {
          workspaceId: WORKSPACE_ID,
          slug: "personal-1",
          name: "Personal Workspace 1",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: [],
        },
        {
          workspaceId: ORG_WORKSPACE_ID,
          slug: "org-1",
          name: "Org Workspace",
          workspaceType: "Organization",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: [],
        },
      ],
    },
  ]);
}

describe("PersonalWorkspaceConvergenceService", () => {
  let repo: InMemoryAuthRepository;
  let service: PersonalWorkspaceConvergenceService;

  beforeEach(() => {
    repo = makeRepo();
    service = new PersonalWorkspaceConvergenceService({ authRepository: repo });
  });

  test("classifies an unambiguous state as converged", async () => {
    // Pre-attach so personalWorkspaceId is set.
    await service.attachExistingConvergence({
      userAccountId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    const kind = await service.resolveConvergence({ userAccountId: USER_ID });
    assert.equal(kind.kind, "converged");
    if (kind.kind === "converged") {
      assert.equal(kind.workspaceId, WORKSPACE_ID);
    }
  });

  test("classifies a single Owner Personal membership with no pointer as attachable", async () => {
    const kind = await service.resolveConvergence({ userAccountId: USER_ID });
    assert.equal(kind.kind, "attachable");
    if (kind.kind === "attachable") {
      assert.equal(kind.workspaceId, WORKSPACE_ID);
    }
  });

  test("attachExistingConvergence links the existing workspace via CAS", async () => {
    await service.attachExistingConvergence({
      userAccountId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    const reattached = await service.attachExistingConvergence({
      userAccountId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    // The second call is a no-op because the pointer is already set.
    void reattached;
    const kind = await service.resolveConvergence({ userAccountId: USER_ID });
    assert.equal(kind.kind, "converged");
  });

  test("createInitialConvergence creates a Personal Workspace + Owner membership atomically", async () => {
    // Use a fresh user with no memberships so resolveConvergence
    // returns "none".
    const freshRepo = new InMemoryAuthRepository([
      {
        userAccountId: "user-fresh",
        email: "fresh@example.com",
        identityProvider: "deterministic",
        identitySubject: "fresh-subject",
        memberships: [],
      },
    ]);
    const freshService = new PersonalWorkspaceConvergenceService({
      authRepository: freshRepo,
    });
    const { workspaceId, slug } = await freshService.createInitialConvergence({
      userAccountId: "user-fresh",
    });
    assert.ok(workspaceId);
    // The slug is opaque, stable, lowercase-alphanumeric, and
    // prefixed with `personal-c`. No email or provider subject
    // fragment may appear.
    assert.match(slug, /^personal-c[a-z0-9]+$/);
    assert.equal(slug.includes("@"), false);
    const kind = await freshService.resolveConvergence({
      userAccountId: "user-fresh",
    });
    assert.equal(kind.kind, "converged");
    if (kind.kind === "converged") {
      assert.equal(kind.workspaceId, workspaceId);
    }
  });

  test("concurrent createInitialConvergence calls converge on the same workspace", async () => {
    // Use a fresh user. The convergence service retries via
    // resolveConvergence + the auth repository's CAS — losing
    // transactions re-read the winner's records.
    const freshRepo = new InMemoryAuthRepository([
      {
        userAccountId: "user-concurrent",
        email: "concurrent@example.com",
        identityProvider: "deterministic",
        identitySubject: "concurrent-subject",
        memberships: [],
      },
    ]);
    const freshService = new PersonalWorkspaceConvergenceService({
      authRepository: freshRepo,
    });
    const [a, b] = await Promise.all([
      freshService.createInitialConvergence({ userAccountId: "user-concurrent" }),
      freshService.createInitialConvergence({ userAccountId: "user-concurrent" }),
    ]);
    // Both callers must see a valid workspace id; one may have
    // retried and read the winner's record.
    assert.ok(a.workspaceId);
    assert.ok(b.workspaceId);
    const kind = await freshService.resolveConvergence({
      userAccountId: "user-concurrent",
    });
    assert.equal(kind.kind, "converged");
  });

  test("classifies multiple Owner Personal memberships as recovery (multiple-personal-workspaces)", async () => {
    // Construct a separate repo with two Personal Workspaces for the
    // same user, so the recovery classification can be exercised.
    const recoveryRepo = new InMemoryAuthRepository([
      {
        userAccountId: USER_ID,
        email: "buyer@example.com",
        identityProvider: "deterministic",
        identitySubject: "buyer-subject",
        memberships: [
          {
            workspaceId: WORKSPACE_ID,
            slug: "personal-1",
            name: "Personal Workspace 1",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
          {
            workspaceId: OTHER_PERSONAL_ID,
            slug: "personal-2",
            name: "Personal Workspace 2",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
        ],
      },
    ]);
    const recoveryService = new PersonalWorkspaceConvergenceService({
      authRepository: recoveryRepo,
    });
    const kind = await recoveryService.resolveConvergence({
      userAccountId: USER_ID,
    });
    assert.equal(kind.kind, "recovery");
    if (kind.kind === "recovery") {
      assert.equal(kind.reason, "multiple-personal-workspaces");
    }
  });

  test("createInitialConvergence rethrows a non-race error from the repository", async () => {
    // Construct a custom repository that throws a non-race error.
    const errorRepo = {
      ...makeRepo(),
      createInitialPersonalWorkspace: async (): Promise<{
        workspaceId: string;
        slug: string;
      }> => {
        await Promise.resolve();
        throw new Error("boom");
      },
    } as unknown as InMemoryAuthRepository;
    const errorService = new PersonalWorkspaceConvergenceService({
      authRepository: errorRepo,
    });
    await assert.rejects(
      () =>
        errorService.createInitialConvergence({
          userAccountId: "user-fresh-no-memberships",
        }),
      /boom/,
    );
  });

  test("does not select, merge, or auto-claim on recovery", async () => {
    // Two Personal Workspaces; the recovery kind never selects one.
    const recoveryRepo = new InMemoryAuthRepository([
      {
        userAccountId: USER_ID,
        email: "buyer@example.com",
        identityProvider: "deterministic",
        identitySubject: "buyer-subject",
        memberships: [
          {
            workspaceId: WORKSPACE_ID,
            slug: "personal-1",
            name: "Personal Workspace 1",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
          {
            workspaceId: OTHER_PERSONAL_ID,
            slug: "personal-2",
            name: "Personal Workspace 2",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
        ],
      },
    ]);
    const recoveryService = new PersonalWorkspaceConvergenceService({
      authRepository: recoveryRepo,
    });
    const kind = await recoveryService.resolveConvergence({
      userAccountId: USER_ID,
    });
    assert.equal(kind.kind, "recovery");
    // The recovery reason is the only signal exposed internally;
    // no workspace id is selected.
    if (kind.kind === "recovery") {
      assert.equal("workspaceId" in kind, false);
    }
  });

  test("ConvergenceRaceError is exported and has the expected name", () => {
    const err = new ConvergenceRaceError();
    assert.equal(err.name, "ConvergenceRaceError");
  });

  // ---- All six recovery reasons are explicitly exercised so a
  // future classifier refactor cannot silently drop one. ----

  test("recovery: contradictory-personal-relationships when the pointer matches one of multiple Owner Personal memberships", async () => {
    // Two Owner Personal memberships AND the pointer points to ONE
    // of them — the user owns a separate Personal Workspace the
    // pointer did not pick. This is the distinct
    // `contradictory-personal-relationships` recovery state.
    const contradictoryRepo = new InMemoryAuthRepository(
      [
        {
          userAccountId: USER_ID,
          email: "contradictory@example.com",
          identityProvider: "deterministic",
          identitySubject: "contradictory-subject",
          memberships: [
            {
              workspaceId: WORKSPACE_ID,
              slug: "personal-1",
              name: "Personal Workspace 1",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: [],
            },
            {
              workspaceId: OTHER_PERSONAL_ID,
              slug: "personal-2",
              name: "Personal Workspace 2",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: [],
            },
          ],
        },
      ],
      () => new Date("2024-01-01T00:00:00Z").getTime(),
    );
    // Pre-attach so personalWorkspaceId points at WORKSPACE_ID,
    // which is one of the two Owner Personal memberships.
    const initService = new PersonalWorkspaceConvergenceService({
      authRepository: contradictoryRepo,
    });
    await initService.attachExistingConvergence({
      userAccountId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    const kind = await initService.resolveConvergence({ userAccountId: USER_ID });
    assert.equal(kind.kind, "recovery");
    if (kind.kind === "recovery") {
      assert.equal(
        kind.reason,
        "contradictory-personal-relationships",
        "pointer matching one of multiple Owner Personal memberships must emit the distinct reason",
      );
    }
  });

  test("recovery: pointer-workspace-missing when the pointed Workspace row is gone", async () => {
    const repo = makeRepo();
    const service = new PersonalWorkspaceConvergenceService({ authRepository: repo });
    // Manually mutate the in-memory state so personalWorkspaceId
    // points at a Workspace id that does not exist in the repo.
    const internalUser = (
      repo as unknown as {
        usersById: Map<string, { personalWorkspaceId: string | null }>;
      }
    ).usersById.get(USER_ID);
    if (!internalUser) throw new Error("expected seeded user");
    internalUser.personalWorkspaceId = "ws-does-not-exist";
    const kind = await service.resolveConvergence({ userAccountId: USER_ID });
    assert.equal(kind.kind, "recovery");
    if (kind.kind === "recovery") {
      assert.equal(kind.reason, "pointer-workspace-missing");
    }
  });

  test("recovery: pointer-not-personal when the pointed Workspace is not Personal", async () => {
    const repo = makeRepo();
    const service = new PersonalWorkspaceConvergenceService({ authRepository: repo });
    // Add an Organization Workspace and point personalWorkspaceId
    // at it. The classifier must report pointer-not-personal (the
    // pointed Workspace exists but is not Personal).
    const internalWorkspaces = (
      repo as unknown as {
        workspacesById: Map<string, { id: string; type: string }>;
      }
    ).workspacesById;
    internalWorkspaces.set(ORG_WORKSPACE_ID, {
      id: ORG_WORKSPACE_ID,
      type: "Organization",
    });
    const internalUser = (
      repo as unknown as {
        usersById: Map<string, { personalWorkspaceId: string | null }>;
      }
    ).usersById.get(USER_ID);
    if (!internalUser) throw new Error("expected seeded user");
    internalUser.personalWorkspaceId = ORG_WORKSPACE_ID;
    const kind = await service.resolveConvergence({ userAccountId: USER_ID });
    assert.equal(kind.kind, "recovery");
    if (kind.kind === "recovery") {
      assert.equal(kind.reason, "pointer-not-personal");
    }
  });

  test("recovery: owner-membership-missing when the pointer is set but the user has NO membership on it at all", async () => {
    // Distinct from membership-not-owner: the pointed Workspace
    // exists and is Personal, but the user has zero memberships on
    // it (not even a non-Owner one). The Owner membership is
    // therefore "missing" — there is nothing to upgrade.
    const repo = new InMemoryAuthRepository(
      [
        {
          userAccountId: USER_ID,
          email: "no-membership@example.com",
          identityProvider: "deterministic",
          identitySubject: "no-membership-subject",
          memberships: [],
        },
      ],
      () => new Date("2024-01-01T00:00:00Z").getTime(),
    );
    // Seed a Personal Workspace the user does NOT belong to.
    const internalWorkspaces = (
      repo as unknown as {
        workspacesById: Map<
          string,
          {
            id: string;
            type: string;
            name: string;
            slug: string;
            status: string;
            ownerUserId: string;
          }
        >;
      }
    ).workspacesById;
    internalWorkspaces.set(WORKSPACE_ID, {
      id: WORKSPACE_ID,
      slug: "personal-orphan",
      name: "Orphan Personal Workspace",
      type: "Personal",
      status: "Active",
      ownerUserId: "someone-else",
    });
    const internalUser = (
      repo as unknown as {
        usersById: Map<string, { personalWorkspaceId: string | null }>;
      }
    ).usersById.get(USER_ID);
    if (!internalUser) throw new Error("expected seeded user");
    internalUser.personalWorkspaceId = WORKSPACE_ID;
    const service = new PersonalWorkspaceConvergenceService({
      authRepository: repo,
    });
    const kind = await service.resolveConvergence({ userAccountId: USER_ID });
    assert.equal(kind.kind, "recovery");
    if (kind.kind === "recovery") {
      assert.equal(
        kind.reason,
        "owner-membership-missing",
        "pointed Workspace exists and is Personal but the user has no membership on it",
      );
    }
  });

  test("recovery: membership-not-owner when the pointer resolves to a non-Owner membership on a Personal Workspace", async () => {
    // Distinct from owner-membership-missing: there IS a membership
    // on the pointed Workspace, but its role is not Owner.
    const repo = new InMemoryAuthRepository(
      [
        {
          userAccountId: USER_ID,
          email: "not-owner@example.com",
          identityProvider: "deterministic",
          identitySubject: "not-owner-subject",
          memberships: [
            {
              workspaceId: WORKSPACE_ID,
              slug: "personal-as-member",
              name: "Personal As Member",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Member",
              capabilities: [],
            },
          ],
        },
      ],
      () => new Date("2024-01-01T00:00:00Z").getTime(),
    );
    // Manually point at WORKSPACE_ID (which has only a Member
    // membership). The classifier must report membership-not-owner
    // because a membership exists but with the wrong role.
    const internalUser = (
      repo as unknown as {
        usersById: Map<string, { personalWorkspaceId: string | null }>;
      }
    ).usersById.get(USER_ID);
    if (!internalUser) throw new Error("expected seeded user");
    internalUser.personalWorkspaceId = WORKSPACE_ID;
    const service = new PersonalWorkspaceConvergenceService({
      authRepository: repo,
    });
    const kind = await service.resolveConvergence({ userAccountId: USER_ID });
    assert.equal(kind.kind, "recovery");
    if (kind.kind === "recovery") {
      assert.equal(kind.reason, "membership-not-owner");
    }
  });

  // ---- co-owned-personal-workspace defense (Tenki PR #91) ----
  //
  // The pre-existing recovery reasons cover per-user contradictions
  // (a single UserAccount in an inconsistent state). The
  // cross-user shape — two distinct UserAccounts both Owner of the
  // same Personal Workspace — is a separate contradiction. The
  // classifier MUST block both `attachable` (NULL pointer, candidate
  // workspace co-owned) and `converged` (pointer set to a co-owned
  // workspace) and surface the distinct
  // `recovery(co-owned-personal-workspace)` reason.

  test("recovery: co-owned-personal-workspace blocks attachable when the candidate Personal Workspace has another Owner", async () => {
    const CO_OWNED_WORKSPACE_ID = "ws-co-owned";
    const CO_OWNED_USER_A = "user-co-owned-a";
    const CO_OWNED_USER_B = "user-co-owned-b";
    const repo = new InMemoryAuthRepository(
      [
        {
          userAccountId: CO_OWNED_USER_A,
          email: "tenki-co-a@example.com",
          identityProvider: "deterministic",
          identitySubject: "tenki-co-a-subject",
          memberships: [
            {
              workspaceId: CO_OWNED_WORKSPACE_ID,
              slug: "personal-co-owned",
              name: "Co-owned Personal",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: [],
            },
          ],
        },
        {
          userAccountId: CO_OWNED_USER_B,
          email: "tenki-co-b@example.com",
          identityProvider: "deterministic",
          identitySubject: "tenki-co-b-subject",
          memberships: [
            {
              workspaceId: CO_OWNED_WORKSPACE_ID,
              slug: "personal-co-owned",
              name: "Co-owned Personal",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: [],
            },
          ],
        },
      ],
      () => now,
    );
    const service = new PersonalWorkspaceConvergenceService({
      authRepository: repo,
    });
    // For User A: pointer is NULL, exactly one Owner Personal
    // membership on the co-owned workspace. Without the
    // workspace-side gate this would classify as `attachable`;
    // the new gate MUST surface `recovery(co-owned-personal-
    // workspace)` instead.
    const kindA = await service.resolveConvergence({
      userAccountId: CO_OWNED_USER_A,
    });
    assert.equal(
      kindA.kind,
      "recovery",
      "User A: candidate Personal Workspace is co-owned — must classify recovery, never attachable",
    );
    if (kindA.kind === "recovery") {
      assert.equal(kindA.reason, "co-owned-personal-workspace");
    }
    // For User B: identical situation, identical classification.
    const kindB = await service.resolveConvergence({
      userAccountId: CO_OWNED_USER_B,
    });
    assert.equal(kindB.kind, "recovery");
    if (kindB.kind === "recovery") {
      assert.equal(kindB.reason, "co-owned-personal-workspace");
    }
    // Authority records are intact: no pointer, both Owner
    // memberships remain.
    const afterA = await repo.findPersonalWorkspaceState({
      userAccountId: CO_OWNED_USER_A,
    });
    assert.equal(afterA.personalWorkspaceId, null);
    assert.equal(afterA.ownerPersonalMemberships.length, 1);
    assert.equal(afterA.coOwnedPersonalWorkspaceIds.has(CO_OWNED_WORKSPACE_ID), true);
    const afterB = await repo.findPersonalWorkspaceState({
      userAccountId: CO_OWNED_USER_B,
    });
    assert.equal(afterB.personalWorkspaceId, null);
    assert.equal(afterB.ownerPersonalMemberships.length, 1);
    assert.equal(afterB.coOwnedPersonalWorkspaceIds.has(CO_OWNED_WORKSPACE_ID), true);
  });

  test("recovery: co-owned-personal-workspace blocks converged when the pointed Workspace has another Owner", async () => {
    // Defense against the deferred-ambiguity scenario: User A
    // authenticates first, the migration/runtime already linked
    // A's pointer to the co-owned workspace (legacy), then User B
    // tries to authenticate. The classifier MUST NOT report
    // `converged` for A's stale pointer; it MUST surface the
    // recovery reason and refuse to act on the unsafe state.
    const CO_OWNED_WORKSPACE_ID = "ws-co-owned-2";
    const CO_OWNED_USER_A = "user-co-owned-2a";
    const CO_OWNED_USER_B = "user-co-owned-2b";
    const repo = new InMemoryAuthRepository(
      [
        {
          userAccountId: CO_OWNED_USER_A,
          email: "tenki-co-2a@example.com",
          identityProvider: "deterministic",
          identitySubject: "tenki-co-2a-subject",
          memberships: [
            {
              workspaceId: CO_OWNED_WORKSPACE_ID,
              slug: "personal-co-owned-2",
              name: "Co-owned Personal 2",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: [],
            },
          ],
        },
        {
          userAccountId: CO_OWNED_USER_B,
          email: "tenki-co-2b@example.com",
          identityProvider: "deterministic",
          identitySubject: "tenki-co-2b-subject",
          memberships: [
            {
              workspaceId: CO_OWNED_WORKSPACE_ID,
              slug: "personal-co-owned-2",
              name: "Co-owned Personal 2",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: [],
            },
          ],
        },
      ],
      () => now,
    );
    // Stage the legacy "User A already won the pointer" state by
    // attaching the existing co-owned workspace to A. This is the
    // exact scenario the migration's workspace-side gate now
    // prevents at the database level; here we exercise the
    // runtime defense against the same shape surviving in a
    // legacy / pre-migration database.
    await repo.attachExistingPersonalWorkspace({
      userAccountId: CO_OWNED_USER_A,
      workspaceId: CO_OWNED_WORKSPACE_ID,
    });
    const service = new PersonalWorkspaceConvergenceService({
      authRepository: repo,
    });
    const kindA = await service.resolveConvergence({
      userAccountId: CO_OWNED_USER_A,
    });
    assert.equal(
      kindA.kind,
      "recovery",
      "User A: pointer set to a co-owned workspace — must classify recovery, never converged",
    );
    if (kindA.kind === "recovery") {
      assert.equal(kindA.reason, "co-owned-personal-workspace");
    }
    // User B's pointer is still NULL; the candidate is the same
    // co-owned workspace; classification remains recovery.
    const kindB = await service.resolveConvergence({
      userAccountId: CO_OWNED_USER_B,
    });
    assert.equal(kindB.kind, "recovery");
    if (kindB.kind === "recovery") {
      assert.equal(kindB.reason, "co-owned-personal-workspace");
    }
  });

  test("does not classify a sole-Owner Personal Workspace as co-owned", async () => {
    // Sanity check: a Personal Workspace with exactly ONE Owner
    // UserAccount must NOT appear in `coOwnedPersonalWorkspaceIds`
    // and the classification must remain `attachable` for a user
    // with NULL pointer + single Owner Personal membership.
    const SOLE_WORKSPACE_ID = "ws-sole-owned";
    const SOLE_USER = "user-sole";
    const repo = new InMemoryAuthRepository(
      [
        {
          userAccountId: SOLE_USER,
          email: "tenki-sole@example.com",
          identityProvider: "deterministic",
          identitySubject: "tenki-sole-subject",
          memberships: [
            {
              workspaceId: SOLE_WORKSPACE_ID,
              slug: "personal-sole-owned",
              name: "Sole-owned Personal",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: [],
            },
          ],
        },
      ],
      () => now,
    );
    const service = new PersonalWorkspaceConvergenceService({
      authRepository: repo,
    });
    const state = await repo.findPersonalWorkspaceState({
      userAccountId: SOLE_USER,
    });
    assert.equal(state.coOwnedPersonalWorkspaceIds.size, 0);
    const kind = await service.resolveConvergence({
      userAccountId: SOLE_USER,
    });
    assert.equal(kind.kind, "attachable");
  });
});
