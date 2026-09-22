// In-memory intent primitive contract (M2 #83).
//
// Symmetric coverage of the Prisma adapter's expected-state
// intent primitive. The in-memory adapter mirrors the Prisma
// adapter's transition algorithm + a per-Workspace Promise
// mutex queue (the in-memory analogue of
// `pg_advisory_xact_lock`).
//
// Coverage:
//
//   - Initial selection paths (Hire / Offer / Both) against an
//     empty Personal.
//   - Later-add paths (`[Buyer] + Offer → Both`;
//     `[Seller] + Hire → Both`).
//   - Idempotency invariant: a chosen set already covered by
//     the persisted set is a no-op success, regardless of
//     `expectedCapabilities` staleness.
//   - Stale-precondition conflict: persisted != expected but
//     the chosen set is NOT fully covered → INTENT_CONFLICT
//     with the fresh state preserved.
//   - Per-Workspace serialization: concurrent disjoint first
//     submissions on the same Workspace cannot produce an
//     unintended union.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InMemoryAuthRepository } from "./in-memory-auth-repository.js";
import { IntentConflictError } from "./auth-repository.js";
import type { MarketplaceCapabilityV1 } from "@soundhub/types";

const USER_ID = "user-in-mem-intent";
const WS_ID = "ws-in-mem-intent-personal";

function buildRepo(): InMemoryAuthRepository {
  return new InMemoryAuthRepository([
    {
      userAccountId: USER_ID,
      email: "in-mem-intent@example.test",
      identityProvider: "deterministic",
      identitySubject: "in-mem-intent",
      memberships: [
        {
          workspaceId: WS_ID,
          slug: "in-mem-intent-personal",
          name: "In-Memory Intent Personal",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: [],
        },
      ],
    },
  ]);
}

describe("InMemoryAuthRepository.provisionIntentAtomically (expected-state)", () => {
  test("Hire on empty Personal adds Buyer", async () => {
    const repo = buildRepo();
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Buyer"],
      expectedCapabilities: [],
    });
    const view = await repo.getPublicUser(USER_ID);
    const ws = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(ws?.capabilities, ["Buyer"]);
  });

  test("Offer on empty Personal adds Seller", async () => {
    const repo = buildRepo();
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Seller"],
      expectedCapabilities: [],
    });
    const view = await repo.getPublicUser(USER_ID);
    const ws = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(ws?.capabilities, ["Seller"]);
  });

  test("Both on empty Personal adds Buyer + Seller atomically", async () => {
    const repo = buildRepo();
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Buyer", "Seller"],
      expectedCapabilities: [],
    });
    const view = await repo.getPublicUser(USER_ID);
    const ws = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(ws?.capabilities, ["Buyer", "Seller"]);
  });

  test("Later-add: [Buyer] + Offer (expected=[Buyer]) -> Both", async () => {
    const repo = buildRepo();
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Buyer"],
      expectedCapabilities: [],
    });
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Seller"],
      expectedCapabilities: ["Buyer"],
    });
    const view = await repo.getPublicUser(USER_ID);
    const ws = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(ws?.capabilities, ["Buyer", "Seller"]);
  });

  test("Later-add: [Seller] + Hire (expected=[Seller]) -> Both", async () => {
    const repo = buildRepo();
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Seller"],
      expectedCapabilities: [],
    });
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Buyer"],
      expectedCapabilities: ["Seller"],
    });
    const view = await repo.getPublicUser(USER_ID);
    const ws = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(ws?.capabilities, ["Buyer", "Seller"]);
  });

  test("Idempotent: persisted=Both + Hire with expected=[] -> no-op success", async () => {
    const repo = buildRepo();
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Buyer", "Seller"],
      expectedCapabilities: [],
    });
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Buyer"],
      expectedCapabilities: [],
    });
    const view = await repo.getPublicUser(USER_ID);
    const ws = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(ws?.capabilities, ["Buyer", "Seller"]);
  });

  test("Conflicting stale precondition: persisted=Buyer + Offer (expected=[]) -> IntentConflictError; final=Buyer", async () => {
    const repo = buildRepo();
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Buyer"],
      expectedCapabilities: [],
    });
    await assert.rejects(
      () =>
        repo.provisionIntentAtomically({
          workspaceId: WS_ID,
          userAccountId: USER_ID,
          capabilities: ["Seller"],
          expectedCapabilities: [],
        }),
      (err: unknown) => {
        assert.ok(err instanceof IntentConflictError);
        assert.deepEqual(err.existing, ["Buyer"]);
        assert.deepEqual(err.expected, []);
        // `fresh` mirrors the persisted state at conflict
        // detection — the customer needs this to construct
        // the correct retry.
        assert.deepEqual(err.fresh, ["Buyer"]);
        return true;
      },
    );
    const view = await repo.getPublicUser(USER_ID);
    const ws = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(ws?.capabilities, ["Buyer"], "no silent union");
  });

  // Per-Workspace serialization. The in-memory adapter uses a
  // per-workspace Promise mutex queue; the Prisma adapter uses
  // `pg_advisory_xact_lock`. Both must serialize disjoint first
  // submissions on the same Workspace so the final state is one
  // row, never two.
  test("Concurrent Hire + Offer on same empty Workspace: one wins, one conflicts; final state is one row", async () => {
    const repo = buildRepo();
    const hire = repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Buyer"],
      expectedCapabilities: [],
    });
    const offer = repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Seller"],
      expectedCapabilities: [],
    });
    const settled = await Promise.allSettled([hire, offer]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one submission succeeds");
    assert.equal(rejected.length, 1, "exactly one submission conflicts");
    const rejection = (rejected[0] as PromiseRejectedResult).reason as IntentConflictError;
    assert.equal(rejection.existing.length, 1, "loser observes exactly one persisted row");
    const finalCaps: readonly MarketplaceCapabilityV1[] = (await repo.getPublicUser(
      USER_ID,
    ))!.workspaces.find((w) => w.workspaceId === WS_ID)!.capabilities;
    assert.equal(finalCaps.length, 1, "final state is one row, not Both");
  });
});
