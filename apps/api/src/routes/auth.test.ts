// BG1 auth route tests (HTTP contract).
//
// Background: the buildathon environment exercises the routes with
// supertest and the deterministic adapter. The test suite pins the
// GS 2 / GS 3 / GS 4 / GS 5 / GS 6 contract at the HTTP boundary:
// neutral magic-link response, server-validated session via HttpOnly
// cookie, acting-Workspace command rejected for non-members, and
// acting-Workspace command rejected for a legacy ownerUserId without
// current membership.
//
// Per ticket #59 P2-001 the verify-token request body carries the
// PRIVATE `verificationToken`; the PUBLIC correlation id from the
// magic-link response is NOT accepted.

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/consistent-type-imports */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, describe, test } from "node:test";
import { createPrismaClient } from "@soundhub/db";
import request from "supertest";
import { buildApp } from "../index.js";
import { DeterministicIdentityAdapter } from "../identity/deterministic-identity-adapter.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { AuthenticationService } from "../services/authentication.service.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";

const BUYER_USER_ID = "user-bg1-route-buyer";
const BUYER_WORKSPACE_ID = "ws-bg1-route-buyer";
const SELLER_USER_ID = "user-route-seller";
const SELLER_WORKSPACE_ID = "ws-route-seller";

describe("BG1 auth routes (in-memory, deterministic adapter)", () => {
  const adapter = new DeterministicIdentityAdapter({ allowDevVerificationUrl: true });
  const buyerSubject = deterministicSubjectFor("buyer-route@example.com");
  const sellerSubject = deterministicSubjectFor("seller-route@example.com");
  const authRepo = new InMemoryAuthRepository([
    {
      userAccountId: BUYER_USER_ID,
      email: "buyer-route@example.com",
      identityProvider: "deterministic",
      identitySubject: buyerSubject,
      memberships: [
        {
          workspaceId: BUYER_WORKSPACE_ID,
          slug: "buyer-route",
          name: "Buyer Route Workspace",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Buyer"],
        },
      ],
    },
    {
      userAccountId: SELLER_USER_ID,
      email: "seller-route@example.com",
      identityProvider: "deterministic",
      identitySubject: sellerSubject,
      memberships: [
        {
          workspaceId: SELLER_WORKSPACE_ID,
          slug: "seller-route",
          name: "Seller Route Workspace",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Seller"],
        },
      ],
    },
  ]);
  const authenticationService = new AuthenticationService({
    identityAdapter: adapter,
    authRepository: authRepo,
  });
  const workspaceAuthorizationService = new WorkspaceAuthorizationService({
    authRepository: authRepo,
  });

  const stubPrisma = new Proxy({} as never, {
    get() {
      throw new Error(
        "Prisma client was invoked; the route tests must use the in-memory auth repository.",
      );
    },
  });
  const { app } = buildApp({
    authenticationService,
    workspaceAuthorizationService,
    authRepository: authRepo,
    identityAdapter: adapter,
    prismaClient: stubPrisma,
  });

  test("POST /api/auth/magic-link returns the neutral envelope with the public correlation id (P0-001, P2-001)", async () => {
    const response = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "buyer-route@example.com" })
      .set("Content-Type", "application/json");
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.ok(response.body.requestId);
    // Per P0-001 / P2-001 the deterministic adapter's public
    // response is the correlation id; the private
    // verificationToken never crosses the route boundary and
    // the schema does not declare it.
    assert.equal("verificationToken" in response.body, false);
    // Per P1-002 the deployed deterministic fallback NEVER
    // exposes a usable login credential to any browser — even
    // when the deterministic adapter runs in operator mode, the
    // URL is logged to the operator's sink instead of crossing
    // the response boundary.
    assert.equal(response.body.devVerificationUrl, undefined);
  });

  test("POST /api/auth/magic-link never returns a devVerificationUrl regardless of operator mode (P1-002)", async () => {
    const restrictedAdapter = new DeterministicIdentityAdapter();
    const { app: restrictedApp } = buildApp({
      authenticationService: new AuthenticationService({
        identityAdapter: restrictedAdapter,
        authRepository: authRepo,
      }),
      workspaceAuthorizationService,
      authRepository: authRepo,
      identityAdapter: restrictedAdapter,
      prismaClient: stubPrisma,
    });
    const response = await request(restrictedApp)
      .post("/api/auth/magic-link")
      .send({ email: "buyer-route@example.com" })
      .set("Content-Type", "application/json");
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.ok(response.body.requestId);
    assert.equal(response.body.devVerificationUrl, undefined);
  });

  test("POST /api/auth/magic-link rejects malformed input with INVALID_AUTH_REQUEST", async () => {
    const response = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "not-an-email" })
      .set("Content-Type", "application/json");
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_AUTH_REQUEST");
  });

  test("POST /api/auth/verify-token rejects the public correlationId — the browser cannot become a demo identity (P0-001, P2-001)", async () => {
    const magic = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "buyer-route@example.com" })
      .set("Content-Type", "application/json");
    assert.equal(magic.status, 200);
    const correlationId = magic.body.requestId as string;
    // Submitting the public correlationId (envelope requestId)
    // to verify-token must NOT mint a session — per P2-001 the
    // accepted field is `verificationToken`, not the correlation
    // id, and the adapter's pending map is keyed by the private
    // verificationToken only.
    const verify = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: correlationId })
      .set("Content-Type", "application/json");
    assert.equal(verify.status, 500);
    assert.equal(verify.body.error.code, "AUTH_FAILED");
    const setCookie = verify.headers["set-cookie"];
    assert.equal(setCookie, undefined);
  });

  test("POST /api/auth/verify-token with the private verificationToken sets the session cookie and returns the public user (P0-001, P2-001)", async () => {
    const magic = await adapter.requestSignIn({ email: "buyer-route@example.com" });
    assert.ok(magic.verificationToken);
    const verify = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: magic.verificationToken })
      .set("Content-Type", "application/json");
    assert.equal(verify.status, 200);
    assert.equal(verify.body.ok, true);
    assert.equal(verify.body.user.email, "buyer-route@example.com");
    assert.deepEqual(verify.body.user.workspaces, [
      {
        workspaceId: BUYER_WORKSPACE_ID,
        slug: "buyer-route",
        name: "Buyer Route Workspace",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        capabilities: ["Buyer"],
      },
    ]);
    const setCookie = verify.headers["set-cookie"];
    assert.ok(Array.isArray(setCookie));
    const cookieHeader = setCookie.find((c: string) => c.startsWith("soundhub_session="));
    assert.ok(cookieHeader);
    assert.ok(cookieHeader.toLowerCase().includes("httponly"));
  });

  test("POST /api/auth/verify-token rejects a request body with the wrong field name (P2-001)", async () => {
    // The legacy `requestId` field is no longer accepted; the
    // shared contract is strict and uses `verificationToken`
    // (per ticket #59 P2-001). The route must reject the legacy
    // payload with INVALID_AUTH_REQUEST so a future drift
    // detector catches a client that still submits the public
    // correlation id.
    const verify = await request(app)
      .post("/api/auth/verify-token")
      .send({ requestId: "any-value" })
      .set("Content-Type", "application/json");
    assert.equal(verify.status, 400);
    assert.equal(verify.body.error.code, "INVALID_AUTH_REQUEST");
  });

  test("POST /api/auth/verify-token fails with AUTH_FAILED for an unknown verification token", async () => {
    const verify = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: "definitely-not-a-real-token" })
      .set("Content-Type", "application/json");
    assert.equal(verify.status, 500);
    assert.equal(verify.body.error.code, "AUTH_FAILED");
  });

  test("emitted magic-link URL → callback reads ?token= → verify-token succeeds (P0-001 round-trip)", async () => {
    // End-to-end regression for ticket #59 P0-001:
    //   1. requestSignIn returns a `correlationId` (public) and a
    //      `verificationToken` (private one-time credential).
    //   2. The deterministic adapter's dev verification URL is
    //      `<path>?token=<verificationToken>` — the credential is
    //      carried as `token`, NOT as `request_id`.
    //   3. The browser callback page reads `?token=<credential>`
    //      and POSTs it to `/api/auth/verify-token` as
    //      `verificationToken` — this is the round-trip.
    //   4. The POST must succeed and return the HttpOnly session
    //      cookie.
    const req = await adapter.requestSignIn({
      email: "buyer-route@example.com",
    });
    assert.ok(req.verificationToken);
    const captured = req.verificationToken;
    // Construct the URL the callback page would land on.
    const callbackUrl = new URL("/auth/verify", "http://localhost:3000");
    callbackUrl.searchParams.set("token", captured);
    // The browser would extract `token` (NOT `request_id`) and
    // POST it as `verificationToken` to the API.
    const extracted = callbackUrl.searchParams.get("token");
    assert.equal(extracted, captured, "callback page MUST read the credential from ?token=");
    assert.equal(
      callbackUrl.searchParams.get("request_id"),
      null,
      "the producer does NOT emit a 'request_id' query parameter",
    );
    const verify = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: extracted })
      .set("Content-Type", "application/json");
    assert.equal(verify.status, 200);
    assert.equal(verify.body.ok, true);
    assert.equal(verify.body.user.email, "buyer-route@example.com");
    const setCookie = verify.headers["set-cookie"];
    assert.ok(Array.isArray(setCookie));
    const cookieHeader = setCookie.find((c: string) => c.startsWith("soundhub_session="));
    assert.ok(cookieHeader, "round-trip MUST issue the HttpOnly session cookie");
  });

  test("GET /api/auth/me returns the authenticated user when the cookie is valid", async () => {
    const cookie = await signIn(app, adapter, "buyer-route@example.com");
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "buyer-route@example.com");
  });

  test("GET /api/auth/me returns null when no cookie is present", async () => {
    const me = await request(app).get("/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user, null);
  });

  test("verify-token and /me responses never include the provider subject or verificationToken (privacy boundary)", async () => {
    const cookie = await signIn(app, adapter, "buyer-route@example.com");
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    assert.equal(me.status, 200);
    assert.equal("identitySubject" in me.body.user, false);
    assert.equal("verificationToken" in me.body.user, false);
    const serialized = JSON.stringify(me.body);
    assert.equal(serialized.includes("buyer-route-subject"), false);

    const magic = await adapter.requestSignIn({ email: "buyer-route@example.com" });
    assert.ok(magic.verificationToken);
    const verify = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: magic.verificationToken })
      .set("Content-Type", "application/json");
    assert.equal(verify.status, 200);
    assert.equal("identitySubject" in verify.body.user, false);
    assert.equal("verificationToken" in verify.body.user, false);
    const verifySerialized = JSON.stringify(verify.body);
    assert.equal(verifySerialized.includes("buyer-route-subject"), false);
    assert.equal(verifySerialized.includes(magic.verificationToken ?? ""), false);
  });

  test("POST /api/auth/acting-workspace authorizes a current member (GS 4)", async () => {
    const cookie = await signIn(app, adapter, "buyer-route@example.com");
    const response = await request(app)
      .post("/api/auth/acting-workspace")
      .send({ actingWorkspaceId: BUYER_WORKSPACE_ID })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.actingWorkspace.workspaceId, BUYER_WORKSPACE_ID);
    assert.equal(response.body.membership.role, "Owner");
  });

  test("POST /api/auth/acting-workspace rejects a non-member with NOT_A_MEMBER (GS 4 / GS 5)", async () => {
    const cookie = await signIn(app, adapter, "buyer-route@example.com");
    const response = await request(app)
      .post("/api/auth/acting-workspace")
      .send({ actingWorkspaceId: SELLER_WORKSPACE_ID })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "NOT_A_MEMBER");
  });

  test("POST /api/auth/acting-workspace rejects an unauthenticated request with SESSION_INVALID", async () => {
    const response = await request(app)
      .post("/api/auth/acting-workspace")
      .send({ actingWorkspaceId: BUYER_WORKSPACE_ID })
      .set("Content-Type", "application/json");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "SESSION_INVALID");
  });

  test("POST /api/auth/sign-out revokes the session and clears the cookie", async () => {
    const cookie = await signIn(app, adapter, "buyer-route@example.com");
    const meBefore = await request(app).get("/api/auth/me").set("Cookie", cookie);
    assert.ok(meBefore.body.user);
    const signOut = await request(app).post("/api/auth/sign-out").set("Cookie", cookie);
    assert.equal(signOut.status, 200);
    assert.equal(signOut.body.ok, true);
    const meAfter = await request(app).get("/api/auth/me").set("Cookie", cookie);
    assert.equal(meAfter.body.user, null);
  });
});

async function signIn(
  app: import("express").Application,
  adapter: DeterministicIdentityAdapter,
  email: string,
): Promise<string> {
  const magic = await adapter.requestSignIn({ email });
  if (!magic.verificationToken) {
    throw new Error("verificationToken missing from adapter result");
  }
  const verify = await request(app)
    .post("/api/auth/verify-token")
    .send({ verificationToken: magic.verificationToken })
    .set("Content-Type", "application/json");
  return extractCookie(verify.headers["set-cookie"]);
}

function extractCookie(headers: string | string[] | undefined): string {
  if (!headers) return "";
  const list = Array.isArray(headers) ? headers : [headers];
  const cookie = list.find((c) => c.startsWith("soundhub_session="));
  if (!cookie) return "";
  return cookie.split(";")[0]!;
}

function deterministicSubjectFor(email: string): string {
  return createHash("sha256").update(`deterministic|${email.trim().toLowerCase()}`).digest("hex");
}

describe("BG1 auth routes (Prisma, disposable PostgreSQL)", () => {
  let skip = false;
  let prisma: ReturnType<typeof createPrismaClient> | null = null;
  before(() => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
      skip = true;
      return;
    }
    try {
      prisma = createPrismaClient(url);
    } catch {
      skip = true;
      prisma = null;
    }
  });

  test("the BG1 demo buyer + seller fixtures are persisted by the seed", async (t) => {
    if (skip || !prisma) {
      t.skip();
      return;
    }
    const buyer = await prisma.userAccount.findUnique({
      where: { email: "demo.buyer@soundhub.example" },
      include: { memberships: { include: { workspace: { include: { capabilities: true } } } } },
    });
    assert.ok(buyer, "demo buyer UserAccount must exist after seed");
    assert.equal(buyer.memberships.length, 1);
    assert.equal(buyer.memberships[0]!.workspace.slug, "bg1-demo-buyer");
    assert.equal(buyer.memberships[0]!.workspace.capabilities[0]!.capability, "Buyer");

    const seller = await prisma.userAccount.findUnique({
      where: { email: "marc.andre@creolebeats.example" },
      include: { memberships: { include: { workspace: { include: { capabilities: true } } } } },
    });
    assert.ok(seller);
    assert.ok(
      seller.memberships.some((m) =>
        m.workspace.capabilities.some((c) => c.capability === "Seller"),
      ),
    );

    const identityMappings = await prisma.identityProvider.findMany();
    assert.ok(
      identityMappings.some((m) => m.provider === "deterministic" && m.subject === "demo-buyer"),
      "demo-buyer identity provider mapping must be persisted",
    );
    assert.ok(
      identityMappings.some((m) => m.provider === "deterministic" && m.subject === "demo-seller"),
      "demo-seller identity provider mapping must be persisted",
    );
    await prisma.$disconnect();
  });
});
