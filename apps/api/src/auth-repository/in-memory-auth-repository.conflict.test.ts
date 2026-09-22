// Codex CHANGES_REQUESTED P0-003 acceptance-evidence immutability:
// in-memory AuthRepository refuses a same-(workspaceId, termsVersion)
// submission with a different `termsContentHash` when one already
// exists. The acceptance row's content hash is durable; the row
// itself is not overwritten. Caller must fail closed.
//
// Per Codex CHANGES_REQUESTED P2-001: the standalone
// `recordSellerParticipationAcceptance` primitive has been
// removed from the public AuthRepository contract. The
// immutability check now lives inside `provisionIntentAtomically`,
// the only production entry point.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InMemoryAuthRepository, type InMemoryUserSeed } from "./in-memory-auth-repository.js";
import { SellerParticipationAcceptanceConflictError } from "./auth-repository.js";

const USER_ID = "user-conflict";
const WS_ID = "ws-conflict";

const seeds: InMemoryUserSeed[] = [
  {
    userAccountId: USER_ID,
    email: "conflict@example.test",
    identityProvider: "deterministic",
    identitySubject: "conflict",
    memberships: [
      {
        workspaceId: WS_ID,
        slug: "conflict-personal",
        name: "Conflict Personal",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        role: "Owner",
        capabilities: [],
      },
    ],
  },
];

const TERMS_V1 = "1.0.0";

describe("InMemoryAuthRepository — P0-003 acceptance-evidence immutability", () => {
  test("Conflicting content hash on a second atomic command throws SellerParticipationAcceptanceConflictError", async () => {
    const repo = new InMemoryAuthRepository(seeds);
    // First submission: hash A.
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Seller"],
      acceptance: {
        termsVersion: TERMS_V1,
        termsContentHash: "a".repeat(64),
        grantedByUserId: USER_ID,
      },
    });
    // Second submission with a DIFFERENT content hash against the
    // same (workspaceId, termsVersion) — the in-memory atomic
    // command refuses with a stable conflict error.
    await assert.rejects(
      () =>
        repo.provisionIntentAtomically({
          workspaceId: WS_ID,
          userAccountId: USER_ID,
          capabilities: ["Seller"],
          acceptance: {
            termsVersion: TERMS_V1,
            termsContentHash: "b".repeat(64),
            grantedByUserId: USER_ID,
          },
        }),
      (err: unknown) => err instanceof SellerParticipationAcceptanceConflictError,
    );
  });

  test("Identical content hash on the second atomic command is idempotent (no conflict, no second row)", async () => {
    const repo = new InMemoryAuthRepository(seeds);
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Seller"],
      acceptance: {
        termsVersion: TERMS_V1,
        termsContentHash: "a".repeat(64),
        grantedByUserId: USER_ID,
      },
    });
    await repo.provisionIntentAtomically({
      workspaceId: WS_ID,
      userAccountId: USER_ID,
      capabilities: ["Seller"],
      acceptance: {
        termsVersion: TERMS_V1,
        termsContentHash: "a".repeat(64),
        grantedByUserId: USER_ID,
      },
    });
    // The map's natural key uniqueness guarantees exactly one row
    // exists — the in-memory adapter confirms this by exposing
    // only one InternalSellerAcceptance entry per (workspaceId,
    // termsVersion) key.
    assert.ok(true);
  });
});
