/* eslint-disable @typescript-eslint/no-floating-promises */
// Prisma adapter concurrency tests for ProjectRequestRepository.
//
// Background: ticket #62 acceptance criteria require that a
// concurrent revocation or state change cannot commit between the
// authoritative transaction state and the BG4 persistence.
//
// These tests open TWO independent Prisma connections against
// the disposable PostgreSQL target and exercise the REAL
// production `PrismaProjectRequestRepository.createProjectRequestInTransaction`
// / `respondToProjectRequestInTransaction` commands. The only
// non-production seam is `setTransactionStageHookForTesting`,
// which pauses the real transaction AFTER every authoritative
// FOR UPDATE-locked row has been acquired but BEFORE the use case
// runs and BEFORE the INSERT / UPDATE commits. Production never
// installs the hook; tests install it to coordinate a second
// connection against the real transaction path.
//
// Required ordering semantics (ticket #62):
//
//   BG4-first ordering:
//     - Transaction A: real create/accept/decline command
//       acquires authoritative locks, then pauses at the test
//       barrier.
//     - Transaction B: attempts a conflicting
//       membership/state mutation; remains blocked while A owns
//       the relevant locks.
//     - Release A: A completes atomically; B may then continue.
//
//   Revocation-first ordering:
//     - Transaction B: revoke/suspend authority, commit.
//     - Transaction A: invokes the real BG4 command, observes
//       the current unauthorized state, fails safely, writes
//       nothing.
//
// Invariants preserved across every failing case:
//   - no ProjectRequest row,
//   - no seller decision evidence,
//   - no Deal row.

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import {
  PrismaProjectRequestRepository,
  setTransactionStageHookForTesting,
} from "./prisma-project-request.repository.js";
import { loadOrCreateFixture, type ProjectRequestFixture } from "./test-fixture.js";
import { buyerOkUseCase, buildAcceptUseCase, buildDeclineUseCase } from "./test-use-cases.js";

let prismaA: PrismaClient;
let prismaB: PrismaClient;
let fixture: ProjectRequestFixture;
let repo: PrismaProjectRequestRepository;
const clockNow = new Date("2026-08-27T12:00:00Z");
const acceptUseCase = buildAcceptUseCase(clockNow);
const declineUseCase = buildDeclineUseCase(clockNow);

before(async () => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prismaA = createPrismaClient(url);
  prismaB = createPrismaClient(url);
  fixture = await loadOrCreateFixture(prismaA);
});

after(async () => {
  // Defensive: tests that throw out of a hook leave the hook
  // installed. Clear it before disconnecting so subsequent test
  // files cannot accidentally inherit the hook.
  setTransactionStageHookForTesting(undefined);
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

afterEach(() => {
  // Defensive: tests that throw out of a hook leave the hook
  // installed. Clear it before each subsequent test so no hook
  // leaks between cases.
  setTransactionStageHookForTesting(undefined);
});

// ---------- helpers ----------

/**
 * Install the production-path barrier hook, run the supplied
 * production command via the real repository, and return a
 * controller the test can use to wait until the barrier has
 * fired and to release the production transaction.
 *
 * `command` is the awaited result of invoking
 * `repo.createProjectRequestInTransaction(...)` /
 * `repo.respondToProjectRequestInTransaction(...)`. The hook
 * fires INSIDE the production transaction AFTER every
 * authoritative FOR UPDATE-locked row has been acquired but
 * BEFORE the use case runs and BEFORE any write commits.
 */
interface BarrierController {
  readonly promise: Promise<void>;
  release(): void;
}

function runWithProductionBarrier<T>(command: () => Promise<T>): {
  result: Promise<T>;
  controller: BarrierController;
} {
  let release: (() => void) | undefined;
  let resolveHook: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveHook = resolve;
  });
  const barrierPromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  setTransactionStageHookForTesting(async () => {
    resolveHook!();
    await barrierPromise;
  });
  // Kick off the production command without awaiting it.
  const result = command();
  return {
    result,
    controller: {
      promise,
      release: () => release!(),
    },
  };
}

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

// ---------- buyer-side interleavings ----------

test("create: BG4 first — buyer membership revocation blocks until the real create command commits", async () => {
  // 1. Start the real create command WITHOUT awaiting it. The
  //    production transaction acquires FOR UPDATE on the buyer
  //    Workspace / WorkspaceMembership / WorkspaceCapability
  //    + the seller / offering / brief rows, then pauses at
  //    the test barrier.
  const { result, controller } = runWithProductionBarrier(() =>
    repo.createProjectRequestInTransaction(
      {
        buyerWorkspaceId: fixture.buyerWorkspace.id,
        projectBriefId: fixture.brief.id,
        serviceOfferingId: fixture.offering.id,
        userAccountId: fixture.buyerUser.id,
      },
      buyerOkUseCase,
    ),
  );

  // 2. Wait until the barrier has fired (the production
  //    transaction has acquired its authoritative locks).
  await controller.promise;

  // 3. Issue the conflicting revoke on a SECOND connection.
  //    Because the production transaction is still holding
  //    FOR UPDATE on the buyer WorkspaceMembership row, the
  //    revoke MUST block.
  const revokeStart = Date.now();
  let revokeFinished = false;
  const revokePromise = (async () => {
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
    revokeFinished = true;
  })();

  // 4. After a small delay the revoke MUST NOT have completed
  //    because the production transaction still owns the lock.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    revokeFinished,
    false,
    "buyer revoke should still be blocked behind the production create command's FOR UPDATE lock",
  );

  // 5. Release the production transaction. The real create
  //    command completes atomically and the revoke unblocks.
  controller.release();
  const createResult = await result;
  assert.equal(createResult.ok, true);

  await revokePromise;
  const revokeElapsed = Date.now() - revokeStart;
  assert.equal(revokeFinished, true);
  assert.ok(
    revokeElapsed >= 200,
    `revoke elapsed=${revokeElapsed}ms (expected >= 200ms — must wait for production create to release FOR UPDATE)`,
  );

  // 6. State after the production create + the revoke: a
  //    ProjectRequest was committed by the production command;
  //    the revoke then ran AFTER the production command
  //    released its locks. No Deal exists.
  const projectRequestCount = await prismaA.projectRequest.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.equal(projectRequestCount, 1);
  const dealCount = await prismaA.deal.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.equal(dealCount, 0);
});

test("create: revoke first — buyer membership revoked before the real create command → no ProjectRequest, no Deal", async () => {
  // 1. Revoke the buyer membership on connection B FIRST.
  await prismaB.workspaceMembership.delete({
    where: {
      userId_workspaceId: {
        userId: fixture.buyerUser.id,
        workspaceId: fixture.buyerWorkspace.id,
      },
    },
  });

  // 2. Invoke the real create command. The production
  //    transaction acquires FOR UPDATE-locked snapshots, the
  //    application-owned policy evaluator observes the missing
  //    membership, the use case fails closed with
  //    BUYER_NOT_AUTHORIZED, and the transaction commits with
  //    NO write.
  const result = await repo.createProjectRequestInTransaction(
    {
      buyerWorkspaceId: fixture.buyerWorkspace.id,
      projectBriefId: fixture.brief.id,
      serviceOfferingId: fixture.offering.id,
      userAccountId: fixture.buyerUser.id,
    },
    buyerOkUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "BUYER_NOT_AUTHORIZED");

  const projectRequestCount = await prismaA.projectRequest.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.equal(projectRequestCount, 0);
  const dealCount = await prismaA.deal.count({
    where: { projectBriefId: fixture.brief.id },
  });
  assert.equal(dealCount, 0);
});

// ---------- seller-side accept interleavings ----------

test("accept: BG4 first — seller membership revocation blocks until the real accept command commits", async () => {
  const projectRequestId = await seedPendingRequest();
  // 1. Start the real accept command WITHOUT awaiting it. The
  //    production transaction FOR UPDATE-locks the
  //    ProjectRequest + seller authority rows, then pauses at
  //    the test barrier.
  const { result, controller } = runWithProductionBarrier(() =>
    repo.respondToProjectRequestInTransaction(
      {
        projectRequestId,
        actingWorkspaceId: fixture.sellerWorkspace.id,
        userAccountId: fixture.sellerUser.id,
        now: clockNow,
      },
      acceptUseCase,
    ),
  );

  await controller.promise;

  // 2. Issue the conflicting seller membership revoke on
  //    connection B. It MUST block behind the production
  //    accept's FOR UPDATE lock.
  let revokeFinished = false;
  const revokePromise = (async () => {
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
    revokeFinished = true;
  })();

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    revokeFinished,
    false,
    "seller revoke should still be blocked behind the production accept command's FOR UPDATE lock",
  );

  // 3. Release the production transaction. The real accept
  //    completes atomically (Pending → Accepted + exactly one
  //    Negotiating Deal), then the revoke unblocks.
  controller.release();
  const acceptResult = await result;
  assert.equal(acceptResult.ok, true);
  if (!acceptResult.ok) return;

  await revokePromise;
  assert.equal(revokeFinished, true);

  const dealCount = await prismaA.deal.count({ where: { projectRequestId } });
  assert.equal(dealCount, 1, "accept must atomically create exactly one Deal");
  const persisted = await prismaA.projectRequest.findUnique({
    where: { id: projectRequestId },
  });
  assert.equal(persisted?.status, "Accepted");
});

test("accept: revoke first — seller membership revoked before the real accept command → no Deal, no decision", async () => {
  const projectRequestId = await seedPendingRequest();
  // 1. Revoke the seller membership on connection B FIRST.
  await prismaB.workspaceMembership.delete({
    where: {
      userId_workspaceId: {
        userId: fixture.sellerUser.id,
        workspaceId: fixture.sellerWorkspace.id,
      },
    },
  });

  // 2. Invoke the real accept command. The production
  //    transaction FOR UPDATE-locks the snapshot, the
  //    application-owned policy evaluator observes the missing
  //    membership, the use case fails closed with
  //    SELLER_NOT_AUTHORIZED, and the transaction commits with
  //    NO write (no Deal, no decision evidence).
  const result = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    acceptUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_NOT_AUTHORIZED");

  const dealCount = await prismaA.deal.count({ where: { projectRequestId } });
  assert.equal(dealCount, 0);
  const stillPending = await prismaA.projectRequest.findUnique({
    where: { id: projectRequestId },
  });
  assert.equal(stillPending?.status, "Pending");
  assert.equal(stillPending?.sellerDecisionAt, null);
});

// ---------- seller-side decline interleavings ----------

test("decline: BG4 first — seller membership revocation blocks until the real decline command commits", async () => {
  const projectRequestId = await seedPendingRequest();
  const { result, controller } = runWithProductionBarrier(() =>
    repo.respondToProjectRequestInTransaction(
      {
        projectRequestId,
        actingWorkspaceId: fixture.sellerWorkspace.id,
        userAccountId: fixture.sellerUser.id,
        now: clockNow,
      },
      declineUseCase,
    ),
  );

  await controller.promise;

  let revokeFinished = false;
  const revokePromise = (async () => {
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
    revokeFinished = true;
  })();

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    revokeFinished,
    false,
    "seller revoke should still be blocked behind the production decline command's FOR UPDATE lock",
  );

  controller.release();
  const declineResult = await result;
  assert.equal(declineResult.ok, true);

  await revokePromise;
  assert.equal(revokeFinished, true);

  const persisted = await prismaA.projectRequest.findUnique({
    where: { id: projectRequestId },
  });
  assert.equal(persisted?.status, "Declined");
  assert.notEqual(persisted?.sellerDecisionAt, null);
  // Decline creates no Deal.
  const dealCount = await prismaA.deal.count({ where: { projectRequestId } });
  assert.equal(dealCount, 0);
});

test("decline: revoke first — seller membership revoked before the real decline command → no decision", async () => {
  const projectRequestId = await seedPendingRequest();
  await prismaB.workspaceMembership.delete({
    where: {
      userId_workspaceId: {
        userId: fixture.sellerUser.id,
        workspaceId: fixture.sellerWorkspace.id,
      },
    },
  });

  const result = await repo.respondToProjectRequestInTransaction(
    {
      projectRequestId,
      actingWorkspaceId: fixture.sellerWorkspace.id,
      userAccountId: fixture.sellerUser.id,
      now: clockNow,
    },
    declineUseCase,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "SELLER_NOT_AUTHORIZED");

  const stillPending = await prismaA.projectRequest.findUnique({
    where: { id: projectRequestId },
  });
  assert.equal(stillPending?.status, "Pending");
  assert.equal(stillPending?.sellerDecisionAt, null);
});
