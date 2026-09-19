// Return-context HTTP round-trip tests (M2 #82).
//
// Background: Codex review (P1-004(c)) flagged that the branch did
// not exercise the return-context cookie flow at the HTTP boundary.
// The validator is unit-tested in `apps/api/src/lib/return-context.test.ts`;
// these tests pin the route-level behavior:
//
//   1. Valid return path: `magic-link` with a validated return path
//      sets the HttpOnly return-context cookie; `verify-token`
//      surfaces `returnTo` verbatim from the cookie and clears it.
//   2. Recovery return path: when the convergence service returns
//      `recovery`, the route MUST clear the cookie AND set
//      `returnTo: null` in the response — the recovery state
//      overrides any pending return destination.
//   3. Authority regression: a return path of the form
//      `/deals/{dealId}` for a Deal the user is NOT a party to is
//      accepted by the return-context validator (the validator only
//      checks structure, not authority) but the destination's own
//      authorization layer (the Deal detail endpoint) MUST still
//      deny the user. This proves return context preserves intent
//      without conferring authority.

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import request from "supertest";
import type { Application } from "express";
import { buildApp } from "../index.js";
import { DeterministicIdentityAdapter } from "../identity/deterministic-identity-adapter.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { AuthenticationService } from "../services/authentication.service.js";
import { PersonalWorkspaceConvergenceService } from "../services/personal-workspace-convergence.service.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import { InMemoryDealTermsRepository } from "../deal-terms/in-memory-deal-terms.repository.js";
import { DealTermsService } from "../deal-terms/deal-terms.service.js";

const BUYER_USER_ID = "user-rc-buyer";
const BUYER_WORKSPACE_ID = "ws-rc-buyer";
const SELLER_USER_ID = "user-rc-seller";
const SELLER_WORKSPACE_ID = "ws-rc-seller";

function deterministicSubjectFor(email: string): string {
  return createHash("sha256").update(`deterministic|${email.trim().toLowerCase()}`).digest("hex");
}

function buildTestApp(opts?: { readonly recovery?: boolean; readonly buyerSubject?: string }): {
  readonly app: Application;
  readonly adapter: DeterministicIdentityAdapter;
} {
  const adapter = new DeterministicIdentityAdapter({ allowDevVerificationUrl: true });
  const buyerEmail = "rc-buyer@example.test";
  const buyerSubject = opts?.buyerSubject ?? deterministicSubjectFor(buyerEmail);
  const authRepo = new InMemoryAuthRepository([
    {
      userAccountId: BUYER_USER_ID,
      email: buyerEmail,
      identityProvider: "deterministic",
      identitySubject: buyerSubject,
      // For the recovery case, give the buyer TWO Owner Personal
      // memberships so the convergence service classifies as
      // `recovery: multiple-personal-workspaces`.
      memberships: opts?.recovery
        ? [
            {
              workspaceId: BUYER_WORKSPACE_ID,
              slug: "rc-personal-1",
              name: "RC Personal 1",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: [],
            },
            {
              workspaceId: "ws-rc-personal-2",
              slug: "rc-personal-2",
              name: "RC Personal 2",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: [],
            },
          ]
        : [
            {
              workspaceId: BUYER_WORKSPACE_ID,
              slug: "rc-personal",
              name: "RC Personal",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: [],
            },
          ],
    },
    {
      userAccountId: SELLER_USER_ID,
      email: "rc-seller@example.test",
      identityProvider: "deterministic",
      identitySubject: deterministicSubjectFor("rc-seller@example.test"),
      memberships: [
        {
          workspaceId: SELLER_WORKSPACE_ID,
          slug: "rc-seller",
          name: "RC Seller Workspace",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: [],
        },
      ],
    },
  ]);
  const authenticationService = new AuthenticationService({
    identityAdapter: adapter,
    authRepository: authRepo,
    personalWorkspaceConvergenceService: new PersonalWorkspaceConvergenceService({
      authRepository: authRepo,
    }),
  });
  const workspaceAuthorizationService = new WorkspaceAuthorizationService({
    authRepository: authRepo,
  });
  // Deal boundary: the return-context authority regression test
  // exercises the actual Deal view endpoint, so the app must carry
  // a DealTermsService backed by an in-memory repository. Other
  // tests in this file do not need it but they tolerate the
  // additional wiring.
  const dealTermsRepository = new InMemoryDealTermsRepository();
  const dealTermsService = new DealTermsService({
    dealTermsRepository,
    workspaceAuthorizationService,
  });
  const stubPrisma = new Proxy({} as never, {
    get() {
      throw new Error(
        "Prisma client was invoked; the return-context tests must use the in-memory auth repository.",
      );
    },
  });
  const { app } = buildApp({
    authenticationService,
    workspaceAuthorizationService,
    authRepository: authRepo,
    identityAdapter: adapter,
    prismaClient: stubPrisma,
    dealTermsService,
  });
  return { app, adapter };
}

function extractReturnContextCookie(headers: string | string[] | undefined): string {
  if (!headers) return "";
  const list = Array.isArray(headers) ? headers : [headers];
  const cookie = list.find((c) => c.startsWith("soundhub_return_context="));
  if (!cookie) return "";
  // Return the full Set-Cookie attribute list (including Max-Age,
  // HttpOnly, SameSite) so callers can inspect the cleared state
  // — `cookie.split(";")[0]` would discard the directive we want
  // to assert.
  return cookie;
}

function extractSessionCookie(headers: string | string[] | undefined): string {
  if (!headers) return "";
  const list = Array.isArray(headers) ? headers : [headers];
  const cookie = list.find((c) => c.startsWith("soundhub_session="));
  if (!cookie) return "";
  return cookie.split(";")[0]!;
}

describe("return-context HTTP round-trip (M2 #82)", () => {
  test("valid internal path round-trips through magic-link → verify-token → returnTo", async () => {
    const { app, adapter } = buildTestApp();

    const magic = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "rc-buyer@example.test", return: "/dashboard" })
      .set("Content-Type", "application/json");
    assert.equal(magic.status, 200);

    // The HttpOnly return-context cookie must be set with the
    // validated path.
    const cookie = extractReturnContextCookie(magic.headers["set-cookie"]);
    assert.ok(cookie, "magic-link must set the return-context cookie for a valid path");
    assert.ok(cookie.includes("soundhub_return_context="), "cookie name must match");

    // Forward the cookie through verify-token; the response must
    // surface `returnTo: "/dashboard"` verbatim.
    const verify = await request(app)
      .post("/api/auth/verify-token")
      .send({
        verificationToken: (await adapter.requestSignIn({ email: "rc-buyer@example.test" }))
          .verificationToken,
      })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(verify.status, 200);
    assert.equal(verify.body.ok, true);
    assert.equal(
      verify.body.returnTo,
      "/dashboard",
      "returnTo must surface the validated destination verbatim",
    );
    // The return-context cookie must be CLEARED on success (the
    // route always clears it, even on converged sign-in).
    const cleared = extractReturnContextCookie(verify.headers["set-cookie"]);
    assert.ok(
      cleared.includes("Max-Age=0") || cleared.includes("max-age=0"),
      "return-context cookie must be cleared on verify-token success",
    );
  });

  test("invalid return path is silently dropped (no cookie, no error)", async () => {
    const { app } = buildTestApp();
    // `..` path traversal — the validator rejects it.
    const response = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "rc-buyer@example.test", return: "/dashboard/../etc/passwd" })
      .set("Content-Type", "application/json");
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    const cookie = extractReturnContextCookie(response.headers["set-cookie"]);
    assert.equal(cookie, "", "invalid return path must NOT set the return-context cookie");
  });

  test("recovery state clears the cookie and sets returnTo to null", async () => {
    // Use a UserAccount seeded with TWO Owner Personal
    // memberships so the convergence service classifies as
    // `recovery: multiple-personal-workspaces`.
    const { app, adapter } = buildTestApp({ recovery: true });

    // Issue the magic-link with a return path. The validator will
    // accept it; the cookie is set.
    const magic = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "rc-buyer@example.test", return: "/dashboard" })
      .set("Content-Type", "application/json");
    assert.equal(magic.status, 200);
    const cookie = extractReturnContextCookie(magic.headers["set-cookie"]);
    assert.ok(cookie, "magic-link sets the cookie even for a recovery-bound email");

    const verify = await request(app)
      .post("/api/auth/verify-token")
      .send({
        verificationToken: (await adapter.requestSignIn({ email: "rc-buyer@example.test" }))
          .verificationToken,
      })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(verify.status, 200);
    assert.equal(verify.body.ok, true);
    assert.equal(
      verify.body.user.setupState,
      "recovery",
      "user must be classified as recovery (multiple Personal Workspaces)",
    );
    assert.equal(
      verify.body.returnTo,
      null,
      "recovery MUST override the return context — returnTo is null",
    );
    // Cookie must still be cleared.
    const cleared = extractReturnContextCookie(verify.headers["set-cookie"]);
    assert.ok(
      cleared.includes("Max-Age=0") || cleared.includes("max-age=0"),
      "return-context cookie must be cleared even on recovery",
    );
  });

  test("a valid Deal-detail return path is accepted by the validator but the Deal view endpoint denies the user", async () => {
    // The return-context validator only checks path STRUCTURE
    // (no `://`, no `..`, no backslash, same-origin canonical URL).
    // It does NOT check authority. A return path of the form
    // `/deals/{dealId}` is structurally valid even for a user who
    // is NOT a party to that Deal.
    //
    // This test proves two things:
    //   (a) the validator accepts `/deals/{dealId}` as a return
    //       context (intent is preserved);
    //   (b) the ACTUAL Deal view endpoint
    //       (`GET /api/deals/:dealId?actingWorkspaceId=...`)
    //       revalidates authority and denies the user with the
    //       precise `BG5_DEAL_NOT_FOUND` envelope. The Deal
    //       boundary — not acting-Workspace selection — is the
    //       authorization gate the return context cannot bypass.
    const { app, adapter } = buildTestApp();

    const DEAL_ID = "deal-other-user";

    // (a) Validator accepts the Deal-detail return path.
    const magic = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "rc-buyer@example.test", return: `/deals/${DEAL_ID}` })
      .set("Content-Type", "application/json");
    assert.equal(magic.status, 200);
    const cookie = extractReturnContextCookie(magic.headers["set-cookie"]);
    assert.ok(
      cookie,
      "the validator MUST accept a structurally-valid Deal-detail return path even when the user lacks authority to view it",
    );

    const verify = await request(app)
      .post("/api/auth/verify-token")
      .send({
        verificationToken: (await adapter.requestSignIn({ email: "rc-buyer@example.test" }))
          .verificationToken,
      })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(verify.status, 200);
    assert.equal(
      verify.body.returnTo,
      `/deals/${DEAL_ID}`,
      "the response must surface the Deal-detail return path verbatim — return context preserves intent",
    );

    // (b) The Deal view endpoint's OWN authorization layer denies
    // the user. We hit the actual `GET /api/deals/:dealId`
    // endpoint — NOT acting-Workspace selection. The user names
    // their OWN Personal Workspace as the acting context; the
    // Deal boundary must still return BG5_DEAL_NOT_FOUND
    // because the Deal is not visible to that Workspace. The
    // return context preserved the intent; the Deal boundary
    // did not grant authority.
    const sessionCookie = extractSessionCookie(verify.headers["set-cookie"]);
    const dealView = await request(app)
      .get(`/api/deals/${DEAL_ID}`)
      .query({ actingWorkspaceId: BUYER_WORKSPACE_ID })
      .set("Cookie", sessionCookie);
    assert.notEqual(
      dealView.status,
      200,
      "the Deal view endpoint MUST deny the user — return context did not confer authority",
    );
    assert.equal(
      dealView.body?.error?.code,
      "BG5_DEAL_NOT_FOUND",
      "the Deal boundary must surface the precise denial code",
    );
  });
});
