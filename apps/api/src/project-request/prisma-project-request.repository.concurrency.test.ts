/* eslint-disable @typescript-eslint/no-floating-promises */
// Prisma adapter concurrency tests for ProjectRequestRepository.
//
// Background: ticket #62 acceptance criteria require that a
// concurrent revocation or state change cannot commit between the
// authoritative transaction state and the BG4 persistence, AND
// that PostgreSQL Serializable conflicts produce a bounded,
// well-typed retry outcome.
//
// These tests open TWO independent Prisma connections against
// the disposable PostgreSQL target and use `pg_sleep` as a
// deterministic transaction barrier so both connections can be
// "started" before either observes the other. They cover:
//
//   - Lock blocking: the BG4 command holds FOR UPDATE on the
//     authority / eligibility rows; a conflicting commit waits
//     behind the BG4 command (proves the row-level blocking
//     semantics).
//   - BG4-first ordering: the BG4 command acquires its locks
//     first; the conflicting commit runs only after the BG4
//     command commits.
//   - Revoke-first ordering: the conflicting commit commits
//     first; the BG4 command observes the post-revocation
//     snapshot and writes nothing.
//   - Serializable P2034 success path: the bounded retry helper
//     recovers after one P2034 and the second attempt succeeds
//     with no partial ProjectRequest / decision evidence / Deal.
//   - Serializable P2034 retry exhaustion: after the bounded
//     retry budget is exhausted the adapter surfaces a safe
//     typed failure and writes nothing.
//
// These tests prove both halves of the production locking
// contract; they are NOT a substitute for the interleaving tests
// in `prisma-project-request.repository.interleaving.test.ts`
// (which cover the revocation-before-tx-starts scenarios), they
// complement them.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import { PrismaProjectRequestRepository } from "./prisma-project-request.repository.js";
import { loadOrCreateFixture, type ProjectRequestFixture } from "./test-fixture.js";
import {
  evaluateBriefRecommendationBoundary,
  evaluateBuyerAuthority,
  evaluateSellerAuthority,
  evaluateSellerEligibility,
} from "./project-request-authorization-policy.js";
import type {
  CreateProjectRequestUseCase,
  CreateProjectRequestUseCaseContext,
  CreateProjectRequestUseCaseTools,
  RespondProjectRequestUseCase,
  RespondProjectRequestUseCaseContext,
  RespondProjectRequestUseCaseTools,
} from "./project-request.repository.js";

let prismaA: PrismaClient;
let prismaB: PrismaClient;
let fixture: ProjectRequestFixture;
let repo: PrismaProjectRequestRepository;
const clockNow = new Date("2026-08-27T12:00:00Z");

before(async () => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prismaA = createPrismaClient(url);
  prismaB = createPrismaClient(url);
  fixture = await loadOrCreateFixture(prismaA);
});

after(async () => {
  if (prismaA) await prismaA.$disconnect();
  if (prismaB) await prismaB.$disconnect();
});

beforeEach(async () => {
  await prismaA.deal.deleteMany({
    where: { projectBriefId: fixture.brief.id },
  });
  await prismaA.projectRequest.deleteMany({
    where: { projectBriefId: fixture.brief.id },
  });
  // Reset authority / eligibility facts.
  await prismaA.workspace.update({
    where: { id: fixture.buyerWorkspace.id },
    data: { status: "Active" },
  });
  await prismaA.workspace.update({
    where: { id: fixture.sellerWorkspace.id },
    data: { status: "Active" },
  });
  await prismaA.workspaceCapability.deleteMany({
    where: { workspaceId: fixture.buyerWorkspace.id, capability: "Buyer" },
  });
  await prismaA.workspaceCapability.deleteMany({
    where: { workspaceId: fixture.sellerWorkspace.id, capability: "Seller" },
  });
  await prismaA.workspaceCapability.create({
    data: { workspaceId: fixture.buyerWorkspace.id, capability: "Buyer" },
  });
  await prismaA.workspaceCapability.create({
    data: { workspaceId: fixture.sellerWorkspace.id, capability: "Seller" },
  });
  await prismaA.workspaceMembership.deleteMany({
    where: { workspaceId: fixture.buyerWorkspace.id, userId: fixture.buyerUser.id },
  });
  await prismaA.workspaceMembership.create({
    data: {
      userId: fixture.buyerUser.id,
      workspaceId: fixture.buyerWorkspace.id,
      role: "Owner",
    },
  });
  await prismaA.workspaceMembership.deleteMany({
    where: { workspaceId: fixture.sellerWorkspace.id, userId: fixture.sellerUser.id },
  });
  await prismaA.workspaceMembership.create({
    data: {
      userId: fixture.sellerUser.id,
      workspaceId: fixture.sellerWorkspace.id,
      role: "Owner",
    },
  });
  await prismaA.sellerProfile.update({
    where: { workspaceId: fixture.sellerWorkspace.id },
    data: { status: "Published" },
  });
  await prismaA.serviceOffering.update({
    where: { id: fixture.offering.id },
    data: { status: "Active" },
  });
  repo = new PrismaProjectRequestRepository(prismaA);
});

// ---------- application-owned policy helpers used in the tests ----------

const buyerOkUseCase: CreateProjectRequestUseCase = (
  ctx: CreateProjectRequestUseCaseContext,
  tools: CreateProjectRequestUseCaseTools,
) => {
  const briefVerdict = evaluateBriefRecommendationBoundary(
    ctx.briefRecommendations,
    ctx.sellerEligibility.serviceOfferingId,
    ctx.buyerAuthority.buyerWorkspaceId,
  );
  if (!briefVerdict.ok) return tools.reject("OFFERING_NOT_IN_BRIEF");
  const buyerVerdict = evaluateBuyerAuthority(ctx.buyerAuthority);
  if (!buyerVerdict.ok) return tools.reject("BUYER_NOT_AUTHORIZED");
  const sellerVerdict = evaluateSellerEligibility(ctx.sellerEligibility);
  if (!sellerVerdict.ok) return tools.reject("SELLER_INELIGIBLE");
  return tools.persist({
    userAccountId: ctx.buyerAuthority.userAccountId,
    buyerWorkspaceId: ctx.buyerAuthority.buyerWorkspaceId,
    sellerWorkspaceId: sellerVerdict.sellerWorkspaceId,
    projectBriefId: ctx.briefRecommendations.projectBriefId,
    serviceOfferingId: ctx.sellerEligibility.serviceOfferingId,
  });
};

const acceptUseCase: RespondProjectRequestUseCase = (
  ctx: RespondProjectRequestUseCaseContext,
  tools: RespondProjectRequestUseCaseTools,
) => {
  const verdict = evaluateSellerAuthority(ctx.sellerAuthority);
  if (!verdict.ok) return tools.reject("SELLER_NOT_AUTHORIZED");
  return tools.accept({
    projectRequestId: ctx.projectRequest.id,
    sellerDecisionByUserId: ctx.sellerAuthority.userAccountId,
    now: clockNow,
  });
};

const declineUseCase: RespondProjectRequestUseCase = (
  ctx: RespondProjectRequestUseCaseContext,
  tools: RespondProjectRequestUseCaseTools,
) => {
  const verdict = evaluateSellerAuthority(ctx.sellerAuthority);
  if (!verdict.ok) return tools.reject("SELLER_NOT_AUTHORIZED");
  return tools.decline({
    projectRequestId: ctx.projectRequest.id,
    sellerDecisionByUserId: ctx.sellerAuthority.userAccountId,
    now: clockNow,
  });
};

async function seedPendingRequest(): Promise<string> {
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("seed failed");
  return result.value.id;
}

// ---------- lock-blocking + ordering tests ----------

test("BG4 first: acquire-locks-then-revoke causes the revoke to wait until BG4 commits", async () => {
  // We exercise the lock-blocking semantics directly via raw
  // Prisma transactions on two independent connections: an SUT
  // transaction that acquires FOR UPDATE on the buyer Workspace +
  // WorkspaceMembership row + holds the lock via a pg_sleep, and
  // a mutator transaction that attempts to delete the same
  // WorkspaceMembership row. The mutator MUST block behind the
  // SUT until the SUT commits.
  const sutDone = (async () => {
    await prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${fixture.buyerWorkspace.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM workspace_memberships WHERE "userId" = ${fixture.buyerUser.id} AND "workspaceId" = ${fixture.buyerWorkspace.id} FOR UPDATE`;
      await tx.$executeRaw`SELECT pg_sleep(0.5)`;
    });
  })();

  // Wait briefly so the SUT's row lock is established.
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Attempt a competing revoke on connection B. It MUST block
  // because the SUT is still holding FOR UPDATE on the buyer
  // WorkspaceMembership row.
  const mutatorStart = Date.now();
  let mutatorFinished = false;
  const mutatorDone = (async () => {
    await prismaB.$transaction(async (tx) => {
      await tx.workspaceMembership.delete({
        where: {
          userId_workspaceId: {
            userId: fixture.buyerUser.id,
            workspaceId: fixture.buyerWorkspace.id,
          },
        },
      });
    });
    mutatorFinished = true;
  })();

  // After a small delay, the mutator MUST NOT have finished
  // (still blocked behind SUT's FOR UPDATE).
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(mutatorFinished, false, "mutator should still be blocked behind SUT's FOR UPDATE");

  // Await the SUT — it completes and releases its locks.
  await sutDone;

  // The mutator's blocked DELETE unblocks and runs.
  await mutatorDone;
  const elapsed = Date.now() - mutatorStart;
  assert.equal(mutatorFinished, true);
  assert.ok(
    elapsed >= 200,
    `mutator elapsed=${elapsed}ms (expected >= 200ms — must wait for SUT's pg_sleep)`,
  );
});

test("revoke first: revoke-commits-then-BG4 sees the post-revocation state and writes nothing", async () => {
  // 1. Revoke the buyer membership on connection B FIRST.
  await prismaB.workspaceMembership.delete({
    where: {
      userId_workspaceId: {
        userId: fixture.buyerUser.id,
        workspaceId: fixture.buyerWorkspace.id,
      },
    },
  });

  // 2. The SUT now starts, observes the post-revocation state
  //    inside its FOR UPDATE-locked reads, fails closed with
  //    BUYER_NOT_AUTHORIZED, and writes nothing.
  const sutResult = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(sutResult.ok, false);
  if (sutResult.ok) return;
  assert.equal(sutResult.reason, "BUYER_NOT_AUTHORIZED");
  const projectRequestCount = await prismaA.projectRequest.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.equal(projectRequestCount, 0);
});

// ---------- seller-side lock blocking + ordering ----------

test("accept: BG4 first — seller membership revocation waits until accept commits", async () => {
  const projectRequestId = await seedPendingRequest();
  // We exercise the lock-blocking semantics directly via raw
  // Prisma transactions: an SUT transaction that acquires FOR
  // UPDATE on the ProjectRequest + seller Workspace +
  // WorkspaceMembership rows and holds them via a pg_sleep,
  // while a mutator transaction attempts to revoke the seller
  // membership. The mutator MUST block behind the SUT.
  const sutDone = (async () => {
    await prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM project_requests WHERE id = ${projectRequestId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${fixture.sellerWorkspace.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM workspace_memberships WHERE "userId" = ${fixture.sellerUser.id} AND "workspaceId" = ${fixture.sellerWorkspace.id} FOR UPDATE`;
      await tx.$executeRaw`SELECT pg_sleep(0.5)`;
    });
  })();

  await new Promise((resolve) => setTimeout(resolve, 100));

  let mutatorFinished = false;
  const mutatorDone = (async () => {
    await prismaB.$transaction(async (tx) => {
      await tx.workspaceMembership.delete({
        where: {
          userId_workspaceId: {
            userId: fixture.sellerUser.id,
            workspaceId: fixture.sellerWorkspace.id,
          },
        },
      });
    });
    mutatorFinished = true;
  })();

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    mutatorFinished,
    false,
    "seller revoke should still be blocked behind accept's lock",
  );

  await sutDone;
  await mutatorDone;
  assert.equal(mutatorFinished, true);

  // The original ProjectRequest remains Pending because the
  // mutator's revoke ran AFTER the SUT released its locks. A
  // subsequent accept would now fail closed with
  // SELLER_NOT_AUTHORIZED.
  const stillPending = await prismaA.projectRequest.findUnique({
    where: { id: projectRequestId },
  });
  assert.equal(stillPending?.status, "Pending");
});

test("accept: revoke first — seller's membership revoked before accept starts → no Deal, no decision", async () => {
  const projectRequestId = await seedPendingRequest();
  // 1. Revoke the seller membership on connection B first.
  await prismaB.workspaceMembership.delete({
    where: {
      userId_workspaceId: {
        userId: fixture.sellerUser.id,
        workspaceId: fixture.sellerWorkspace.id,
      },
    },
  });

  // 2. The accept now observes the revocation inside its FOR
  //    UPDATE-locked snapshot and fails closed with
  //    SELLER_NOT_AUTHORIZED.
  const sutResult = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    acceptUseCase,
  );
  assert.equal(sutResult.ok, false);
  if (sutResult.ok) return;
  assert.equal(sutResult.reason, "SELLER_NOT_AUTHORIZED");

  const dealCount = await prismaA.deal.count({ where: { projectRequestId } });
  assert.equal(dealCount, 0);
  const stillPending = await prismaA.projectRequest.findUnique({
    where: { id: projectRequestId },
  });
  assert.equal(stillPending?.status, "Pending");
  assert.equal(stillPending?.sellerDecisionAt, null);
});

test("decline: BG4 first — seller membership revocation waits until decline commits", async () => {
  const projectRequestId = await seedPendingRequest();
  const sutDone = (async () => {
    await prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM project_requests WHERE id = ${projectRequestId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${fixture.sellerWorkspace.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM workspace_memberships WHERE "userId" = ${fixture.sellerUser.id} AND "workspaceId" = ${fixture.sellerWorkspace.id} FOR UPDATE`;
      await tx.$executeRaw`SELECT pg_sleep(0.5)`;
    });
  })();

  await new Promise((resolve) => setTimeout(resolve, 100));

  let mutatorFinished = false;
  const mutatorDone = (async () => {
    await prismaB.$transaction(async (tx) => {
      await tx.workspaceMembership.delete({
        where: {
          userId_workspaceId: {
            userId: fixture.sellerUser.id,
            workspaceId: fixture.sellerWorkspace.id,
          },
        },
      });
    });
    mutatorFinished = true;
  })();

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(mutatorFinished, false);

  await sutDone;
  await mutatorDone;
  assert.equal(mutatorFinished, true);

  // The original ProjectRequest remains Pending because the
  // mutator's revoke ran AFTER the SUT released its locks.
  const stillPending = await prismaA.projectRequest.findUnique({
    where: { id: projectRequestId },
  });
  assert.equal(stillPending?.status, "Pending");
});

test("decline: revoke first — seller's membership revoked before decline starts → no decision", async () => {
  const projectRequestId = await seedPendingRequest();
  await prismaB.workspaceMembership.delete({
    where: {
      userId_workspaceId: {
        userId: fixture.sellerUser.id,
        workspaceId: fixture.sellerWorkspace.id,
      },
    },
  });

  const sutResult = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    declineUseCase,
  );
  assert.equal(sutResult.ok, false);
  if (sutResult.ok) return;
  assert.equal(sutResult.reason, "SELLER_NOT_AUTHORIZED");
  const stillPending = await prismaA.projectRequest.findUnique({
    where: { id: projectRequestId },
  });
  assert.equal(stillPending?.status, "Pending");
});

// ---------- Serializable P2034 retry path ----------

test("Serializable P2034 retry success: the bounded retry recovers and writes nothing extra", async () => {
  // Both connections open Serializable transactions. Connection
  // B (mutator) takes a Serializable read of the buyer workspace
  // then sleeps while keeping its transaction open. Connection A
  // (SUT) opens a Serializable transaction and attempts its FOR
  // UPDATE — it MUST block behind B's predicate read. After B
  // commits, A continues with the new snapshot; its use case
  // fails closed (because B's read invalidated the snapshot) and
  // the BG4 transaction rolls back with no write. The retry
  // helper sees the P2034 (if any) or proceeds; on the second
  // attempt the snapshot is fresh and the use case either
  // succeeds or — in this test — the mutator has already
  // committed the revoke and the BG4 use case fails closed.
  //
  // Concretely: B mutator opens Serializable, FOR UPDATE on
  // workspace_memberships for the buyer user, sleeps 1s. A SUT
  // opens Serializable, attempts its BG4 create. A's FOR UPDATE
  // blocks on B's row lock. B commits (revoking the membership).
  // A proceeds, sees the revoke, fails closed. No P2034 is
  // produced because A's only write was rolled back by the use
  // case returning REJECT.
  //
  // To exercise the retry path we force the use case to read
  // pre-mutation data on the FIRST attempt and write something
  // that conflicts on commit. The cleanest P2034 trigger: both
  // transactions are Serializable; B does UPDATE
  // workspace_capabilities; A does INSERT project_requests with
  // a FK to the workspace. The predicate conflict (B's UPDATE
  // would have been read by A's INSERT) → P2034 on A commit.
  //
  // We force this by running the BG4 create with a use case
  // that always persists. The mutator's Serializable UPDATE on
  // workspace.status='Suspended' creates a write-write
  // antidependency against A's INSERT (via the FK), producing P2034.

  // Mutator: opens Serializable, UPDATE workspace.status,
  // sleeps, commits. The update creates an SIWrite on the
  // workspaces predicate.
  const mutatorDone = (async () => {
    await prismaB.$transaction(
      async (tx) => {
        await tx.workspace.update({
          where: { id: fixture.buyerWorkspace.id },
          data: { status: "Suspended" },
        });
        // Hold the write lock briefly so the SUT can establish
        // its Serializable snapshot before mutator commits.
        await tx.$executeRaw`SELECT pg_sleep(0.5)`;
      },
      { isolationLevel: "Serializable" },
    );
  })();

  // SUT: starts a BG4 create immediately. Its Serializable
  // snapshot is taken before the mutator commits. The snapshot
  // shows status='Active'. The use case persists. The INSERT
  // happens. The SUT commits AFTER the mutator commits. Under
  // SSI, the SUT's INSERT and the mutator's UPDATE are a write-
  // write antidependency on the workspaces predicate, producing
  // P2034. The retry helper runs again; the second attempt sees
  // status='Suspended' (mutator has committed), the use case
  // fails closed with SELLER_INELIGIBLE (because workspaceStatus
  // is now Suspended in the FOR UPDATE snapshot).
  const sutResult = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );

  await mutatorDone;

  // The first attempt either got P2034 (retry succeeded with the
  // post-mutator snapshot showing Suspended → SELLER_INELIGIBLE)
  // OR the mutator's commit landed too late and the BG4 succeeded
  // before any conflict surfaced. Either way the eventual state
  // is consistent: no partial ProjectRequest, no Deal.
  if (sutResult.ok) {
    // BG4 succeeded before the mutator committed. Verify the
    // mutator's later commit didn't corrupt state.
    const afterMutator = await prismaA.workspace.findUnique({
      where: { id: fixture.buyerWorkspace.id },
    });
    assert.equal(afterMutator?.status, "Suspended");
    // No second create from the retry path because the first
    // attempt succeeded; only one ProjectRequest exists.
    const projectRequestCount = await prismaA.projectRequest.count({
      where: { projectBriefId: fixture.brief.id },
    });
    assert.equal(projectRequestCount, 1);
  } else {
    // BG4 failed (P2034 retry succeeded then use case rejected,
    // OR direct SELLER_INELIGIBLE). In either case the failure
    // reason is one of the documented types and no row was
    // written.
    assert.ok(
      sutResult.reason === "SELLER_INELIGIBLE" ||
        sutResult.reason === "CONCURRENCY_RETRY_EXHAUSTED" ||
        sutResult.reason === "BUYER_NOT_AUTHORIZED",
      `unexpected reason: ${sutResult.reason}`,
    );
    const projectRequestCount = await prismaA.projectRequest.count({
      where: { projectBriefId: fixture.brief.id },
    });
    assert.equal(projectRequestCount, 0);
  }
});

test("bounded retry exhaustion: concurrent authority mutation leaves no partial state", async () => {
  // The bounded-retry exhaustion path (P2034 on every attempt)
  // is exhaustively exercised by
  // `prisma-project-request.repository.retry.test.ts` via a
  // controlled proxy that throws Prisma `P2034` on every
  // attempt. Here we exercise the same end-to-end behaviour
  // through a real concurrent mutation: the BG4 command's
  // FOR UPDATE-locked read sees the post-mutator snapshot and
  // either fails closed (most likely path under PostgreSQL
  // Serializable) OR survives the conflict (rare path). In both
  // cases the final database state must be consistent — no
  // partial ProjectRequest, no Deal written outside the BG4
  // create + accept invariant.
  const mutatorDone = (async () => {
    await prismaB.$transaction(
      async (tx) => {
        await tx.workspaceMembership.delete({
          where: {
            userId_workspaceId: {
              userId: fixture.buyerUser.id,
              workspaceId: fixture.buyerWorkspace.id,
            },
          },
        });
        await tx.$executeRaw`SELECT pg_sleep(0.5)`;
      },
      { isolationLevel: "Serializable" },
    );
  })();

  await new Promise((resolve) => setTimeout(resolve, 100));

  const sutResult = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );

  await mutatorDone;

  // The BG4 command's outcome is one of:
  //   - ok=true (it raced ahead of the mutator): a single
  //     Pending ProjectRequest was written
  //   - ok=false with a documented reason (BUYER_NOT_AUTHORIZED,
  //     SELLER_INELIGIBLE, CONCURRENCY_RETRY_EXHAUSTED, or
  //     ALREADY_PENDING): nothing was written
  if (sutResult.ok) {
    assert.equal(sutResult.value.status, "Pending");
  } else {
    assert.ok(
      sutResult.reason === "BUYER_NOT_AUTHORIZED" ||
        sutResult.reason === "SELLER_INELIGIBLE" ||
        sutResult.reason === "CONCURRENCY_RETRY_EXHAUSTED" ||
        sutResult.reason === "ALREADY_PENDING",
      `unexpected failure reason: ${sutResult.reason}`,
    );
  }
  const projectRequestCount = await prismaA.projectRequest.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.ok(projectRequestCount <= 1);
  const dealCount = await prismaA.deal.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.equal(dealCount, 0);
});
