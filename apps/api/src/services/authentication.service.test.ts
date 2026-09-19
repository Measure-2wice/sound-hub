// AuthenticationService tests.
//
// Background: BG1 requires the (provider, subject) → UserAccount
// mapping to live behind one application boundary. These tests
// pin the service's contract behaviour against an in-memory auth
// repository and the deterministic identity adapter. Per ticket
// #59 P0-001 the deterministic adapter returns a private
// `verificationToken` that the service's `verifySignIn` consumes
// — tests drive the adapter through the same seam the local
// test-only E2E flow uses. Per ticket #59 P2-001 the input
// field is named `verificationToken` (private) and the magic-
// link envelope field is named `requestId` (public correlation).

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/require-await */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { AuthenticationService, AuthenticationError } from "./authentication.service.js";
import { PersonalWorkspaceConvergenceService } from "./personal-workspace-convergence.service.js";
import { DeterministicIdentityAdapter } from "../identity/deterministic-identity-adapter.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";

describe("AuthenticationService", () => {
  let now: number;
  let adapter: DeterministicIdentityAdapter;
  let authRepo: InMemoryAuthRepository;
  let convergenceService: PersonalWorkspaceConvergenceService;
  let service: AuthenticationService;

  beforeEach(() => {
    now = 1_700_000_000_000;
    adapter = new DeterministicIdentityAdapter({ now: () => now });
    authRepo = new InMemoryAuthRepository([], () => now);
    convergenceService = new PersonalWorkspaceConvergenceService({
      authRepository: authRepo,
    });
    service = new AuthenticationService({
      identityAdapter: adapter,
      authRepository: authRepo,
      personalWorkspaceConvergenceService: convergenceService,
      now: () => now,
      sessionLifetimeMs: 60 * 60 * 1000,
    });
  });

  test("requestSignIn returns a neutral envelope on every well-formed input", async () => {
    const a = await service.requestSignIn({ email: "buyer@example.com" });
    const b = await service.requestSignIn({ email: "buyer@example.com" });
    assert.equal(a.envelope.ok, true);
    assert.equal(b.envelope.ok, true);
    // Per P2-001 the envelope's `requestId` is the PUBLIC
    // correlation id (mapped from the adapter's
    // `correlationId`). It is NOT a verification credential —
    // the service never accepts it as input to `verifySignIn`.
    assert.ok(a.envelope.requestId.length > 0);
    assert.ok(b.envelope.requestId.length > 0);
    assert.notEqual(a.envelope.requestId, b.envelope.requestId);
    assert.equal(a.envelope.devVerificationUrl, undefined);
    assert.equal(b.envelope.devVerificationUrl, undefined);
  });

  test("the envelope never exposes the private verificationToken (P0-001, P2-001)", async () => {
    // Direct adapter call: the verificationToken is the
    // local-test-only credential; the envelope the service
    // produces MUST NOT carry it. The deterministic adapter only
    // emits it on the adapter's return value (where the test
    // harness can read it). The service explicitly forwards only
    // `correlationId` (renamed `requestId` on the envelope) and
    // the optional `devVerificationUrl` into the envelope.
    const raw = await adapter.requestSignIn({ email: "buyer@example.com" });
    assert.ok(raw.verificationToken);
    const envelope = (await service.requestSignIn({ email: "buyer@example.com" })).envelope;
    assert.ok(envelope);
    assert.equal("verificationToken" in envelope, false);
    assert.equal(envelope.requestId === raw.verificationToken, false);
  });

  test("local-test allowDevVerificationUrl surfaces devVerificationUrl on the envelope and in the adapter log (P1-002)", async () => {
    // The deterministic adapter's local-test escape hatch is the
    // ONLY path that yields a usable `devVerificationUrl`. The
    // composition root gates the flag to NODE_ENV=test; production
    // always fails closed so this response field is absent in
    // deployed processes. The local Playwright journey uses the
    // surfaced URL to complete sign-in without parsing logs.
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => {
      logs.push(msg);
    };
    try {
      const localTestAdapter = new DeterministicIdentityAdapter({
        now: () => now,
        allowDevVerificationUrl: true,
      });
      const localTestService = new AuthenticationService({
        identityAdapter: localTestAdapter,
        authRepository: authRepo,
        personalWorkspaceConvergenceService: convergenceService,
        now: () => now,
      });
      const result = await localTestService.requestSignIn({ email: "buyer@example.com" });
      const envelope = result.envelope;
      assert.ok(envelope, "envelope must be defined");
      assert.ok(envelope.requestId, "envelope.requestId must be defined");
      assert.ok(envelope.requestId.length > 0);
      // The local-test envelope surfaces the devVerificationUrl so
      // the buildathon browser journey can complete sign-in
      // without parsing logs. Production behavior (managed, or
      // deterministic with allowDevVerificationUrl=false) is
      // unchanged: the field is absent.
      assert.ok(envelope.devVerificationUrl);
      assert.match(envelope.devVerificationUrl, /\/auth\/verify\?token=/);
      const adapterResult = await localTestAdapter.requestSignIn({
        email: "buyer2@example.com",
      });
      assert.ok(adapterResult.verificationToken);
      assert.ok(
        logs.some(
          (line) =>
            line.includes("local-test verification URL") &&
            line.includes(adapterResult.verificationToken ?? ""),
        ),
      );
    } finally {
      console.log = originalLog;
    }
  });

  test("verifySignIn returns a server session and resolves the UserAccount", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const result = await service.verifySignIn({
      verificationToken: request.verificationToken ?? "",
    });
    assert.equal(result.publicUser.identityProvider, "deterministic");
    assert.equal(result.publicUser.email, "buyer@example.com");
    assert.equal(result.publicUser.setupState, "converged");
    assert.equal(result.publicUser.workspaces.length, 1);
    assert.equal(result.publicUser.workspaces[0]!.name, "My Workspace");
    assert.equal(result.publicUser.workspaces[0]!.workspaceType, "Personal");
    assert.equal(result.publicUser.workspaces[0]!.capabilities.length, 0);
    assert.ok(result.session.sessionId.length > 0);
    assert.equal(result.session.revokedAt, null);
  });

  test("verifySignIn rejects the public correlationId so a browser cannot become a demo identity (P0-001, P2-001)", async () => {
    const envelope = (await service.requestSignIn({ email: "demo.buyer@soundhub.example" }))
      .envelope;
    assert.ok(envelope);
    // The browser has only the public correlationId (envelope
    // requestId) from the magic-link response; presenting it to
    // verifySignIn must NOT mint a session. The adapter's pending
    // map is keyed by the private verificationToken, not the
    // correlationId.
    await assert.rejects(
      () => service.verifySignIn({ verificationToken: envelope.requestId }),
      (err: unknown) => err instanceof AuthenticationError && err.code === "AUTH_FAILED",
    );
  });

  test("verifySignIn is single-use (a successful verify cannot issue a second session)", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    await service.verifySignIn({ verificationToken: request.verificationToken ?? "" });
    await assert.rejects(
      () => service.verifySignIn({ verificationToken: request.verificationToken ?? "" }),
      (err: unknown) => err instanceof AuthenticationError && err.code === "AUTH_FAILED",
    );
  });

  test("verifySignIn returns AUTH_FAILED for an unknown verification token", async () => {
    await assert.rejects(
      () => service.verifySignIn({ verificationToken: "never-issued" }),
      (err: unknown) => err instanceof AuthenticationError && err.code === "AUTH_FAILED",
    );
  });

  test("verifySignIn returns AUTH_FAILED when the adapter returns null", async () => {
    const failingAdapter = {
      providerKey: "deterministic" as const,
      requestSignIn: async () => ({ correlationId: "x", verificationToken: "x" }),
      verifySignIn: async () => null,
    };
    const brokenService = new AuthenticationService({
      identityAdapter: failingAdapter,
      authRepository: authRepo,
      personalWorkspaceConvergenceService: convergenceService,
    });
    await assert.rejects(
      () => brokenService.verifySignIn({ verificationToken: "x" }),
      (err: unknown) => err instanceof AuthenticationError && err.code === "AUTH_FAILED",
    );
  });

  test("resolveSession returns null for an unknown or missing session id", async () => {
    assert.equal(await service.resolveSession(undefined), null);
    assert.equal(await service.resolveSession(""), null);
    assert.equal(await service.resolveSession("not-a-real-session"), null);
  });

  test("resolveSession returns the public user for an active session", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const { session } = await service.verifySignIn({
      verificationToken: request.verificationToken ?? "",
    });
    const user = await service.resolveSession(session.sessionId);
    assert.ok(user);
    assert.equal(user.email, "buyer@example.com");
  });

  test("signOut revokes the current session", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const { session } = await service.verifySignIn({
      verificationToken: request.verificationToken ?? "",
    });
    const revoked = await service.signOut(session.sessionId);
    assert.equal(revoked, true);
    const user = await service.resolveSession(session.sessionId);
    assert.equal(user, null);
  });

  test("signOut is idempotent (revoking an already-revoked session returns false)", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const { session } = await service.verifySignIn({
      verificationToken: request.verificationToken ?? "",
    });
    assert.equal(await service.signOut(session.sessionId), true);
    assert.equal(await service.signOut(session.sessionId), false);
  });

  test("an expired session is rejected by resolveSession without throwing", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const { session } = await service.verifySignIn({
      verificationToken: request.verificationToken ?? "",
    });
    now += 60 * 60 * 1000 + 1;
    const user = await service.resolveSession(session.sessionId);
    assert.equal(user, null);
  });

  test("a UserAccount is created only on first sign-in and reused thereafter", async () => {
    const request1 = await adapter.requestSignIn({ email: "buyer@example.com" });
    const first = await service.verifySignIn({
      verificationToken: request1.verificationToken ?? "",
    });
    const request2 = await adapter.requestSignIn({ email: "buyer@example.com" });
    const second = await service.verifySignIn({
      verificationToken: request2.verificationToken ?? "",
    });
    assert.equal(first.publicUser.userAccountId, second.publicUser.userAccountId);
  });

  test("two different emails produce two different UserAccounts", async () => {
    const a = await adapter.requestSignIn({ email: "a@example.com" });
    const b = await adapter.requestSignIn({ email: "b@example.com" });
    const aResult = await service.verifySignIn({ verificationToken: a.verificationToken ?? "" });
    const bResult = await service.verifySignIn({ verificationToken: b.verificationToken ?? "" });
    assert.notEqual(aResult.publicUser.userAccountId, bResult.publicUser.userAccountId);
  });

  test("verifySignIn links the existing Personal Workspace for an `attachable` user (no duplicate created)", async () => {
    // Tenki PR #91 hardening: the convergence flow must settle
    // an `attachable` user by linking the existing Personal
    // Workspace via `attachExistingConvergence`. The repository
    // must end with EXACTLY one Owner Personal membership — no
    // duplicate created.
    const EXISTING_WORKSPACE_ID = "ws-attachable-existing-personal";
    const repo = new InMemoryAuthRepository(
      [
        {
          userAccountId: "user-svc-verify-attachable",
          email: "tenki-svc-verify-attachable@example.com",
          identityProvider: "deterministic",
          identitySubject: "tenki-svc-verify-attachable-subject",
          memberships: [
            {
              workspaceId: EXISTING_WORKSPACE_ID,
              slug: "personal-ws-attachable-existing-personal",
              name: "Existing Personal",
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
    const convergence = new PersonalWorkspaceConvergenceService({
      authRepository: repo,
    });
    const auth = new AuthenticationService({
      identityAdapter: adapter,
      authRepository: repo,
      personalWorkspaceConvergenceService: convergence,
      now: () => now,
      sessionLifetimeMs: 60 * 60 * 1000,
    });
    // Sanity: the user starts in the `attachable` state.
    const before = await repo.findPersonalWorkspaceState({
      userAccountId: "user-svc-verify-attachable",
    });
    assert.equal(before.personalWorkspaceId, null);
    assert.equal(before.ownerPersonalMemberships.length, 1);

    const request = await adapter.requestSignIn({
      email: "tenki-svc-verify-attachable@example.com",
    });
    assert.ok(request.verificationToken);
    const result = await auth.verifySignIn({
      verificationToken: request.verificationToken,
    });
    assert.equal(result.publicUser.setupState, "converged");
    const after = await repo.findPersonalWorkspaceState({
      userAccountId: "user-svc-verify-attachable",
    });
    assert.equal(after.personalWorkspaceId, EXISTING_WORKSPACE_ID);
    assert.equal(after.ownerPersonalMemberships.length, 1);
    assert.equal(after.ownerPersonalMemberships[0]!.workspaceId, EXISTING_WORKSPACE_ID);
  });

  test("verifySignIn is idempotent across repeated sign-ins for the same identity (Tenki PR #91)", async () => {
    // Idempotency pin: a user who signs in repeatedly must end
    // up with EXACTLY one Personal Workspace and EXACTLY one
    // Owner membership. Convergence is owned by `verifySignIn`,
    // so each new sign-in is expected to either no-op
    // (already converged) or settle from `none` to `converged`.
    // It must never produce a duplicate.
    const FRESH_EMAIL = "tenki-svc-idempotent@example.com";

    const request1 = await adapter.requestSignIn({ email: FRESH_EMAIL });
    assert.ok(request1.verificationToken);
    const first = await service.verifySignIn({
      verificationToken: request1.verificationToken,
    });
    assert.equal(first.publicUser.setupState, "converged");
    const afterFirst = await authRepo.findPersonalWorkspaceState({
      userAccountId: first.publicUser.userAccountId,
    });
    assert.notEqual(afterFirst.personalWorkspaceId, null);
    const firstPointer = afterFirst.personalWorkspaceId;
    assert.equal(afterFirst.ownerPersonalMemberships.length, 1);

    const request2 = await adapter.requestSignIn({ email: FRESH_EMAIL });
    assert.ok(request2.verificationToken);
    const second = await service.verifySignIn({
      verificationToken: request2.verificationToken,
    });
    assert.equal(second.publicUser.setupState, "converged");
    assert.equal(second.publicUser.userAccountId, first.publicUser.userAccountId);

    const afterSecond = await authRepo.findPersonalWorkspaceState({
      userAccountId: first.publicUser.userAccountId,
    });
    assert.equal(afterSecond.personalWorkspaceId, firstPointer);
    assert.equal(afterSecond.ownerPersonalMemberships.length, 1);
    assert.equal(
      afterSecond.ownerPersonalMemberships[0]!.workspaceId,
      firstPointer,
    );
  });

  // ---------- Tenki PR #91: resolveSessionWithSetupState is strictly read-only ----------
  //
  // These tests pin the corrected contract: `resolveSessionWithSetupState`
  // (which feeds `GET /api/auth/me`) MUST be strictly read-only. It
  // may classify current persisted state into `"converged" |
  // "recovery"`; it MUST NOT invoke `createInitialConvergence`,
  // `attachExistingConvergence`, or any repository mutation primitive.
  // Convergence creation / attachment is owned exclusively by
  // `verifySignIn` (mutation boundary: `POST /api/auth/verify-token`).
  //
  // The earlier Tenki PR #91 round asserted that
  // `resolveSessionWithSetupState + none` produced `"converged"` after
  // `resolveSetupState` ran the convergence flow. That was the wrong
  // direction: a read path used by a `GET` route must not mutate.
  // The corrected contract:
  //
  //   - internal `converged`  → public `"converged"`
  //   - internal `recovery`   → public `"recovery"`
  //   - internal `none`       → public `"recovery"` (no mutation)
  //   - internal `attachable` → public `"recovery"` (no mutation)
  //
  // Each test below asserts both the public DTO classification AND
  // the absence of mutation in the repository's persisted state.

  describe("resolveSessionWithSetupState is strictly read-only (Tenki PR #91)", () => {
    function buildAuthService(repo: InMemoryAuthRepository): AuthenticationService {
      const convergence = new PersonalWorkspaceConvergenceService({
        authRepository: repo,
      });
      return new AuthenticationService({
        identityAdapter: adapter,
        authRepository: repo,
        personalWorkspaceConvergenceService: convergence,
        now: () => now,
        sessionLifetimeMs: 60 * 60 * 1000,
      });
    }

    async function mintSession(
      repo: InMemoryAuthRepository,
      userAccountId: string,
    ): Promise<string> {
      const session = await repo.createSession({
        userAccountId,
        expiresAt: new Date(now + 60 * 60 * 1000),
      });
      return session.sessionId;
    }

    test('classifies `none` as public "recovery" without mutating (no createInitialConvergence)', async () => {
      const repo = new InMemoryAuthRepository([], () => now);
      const auth = buildAuthService(repo);
      const mapping = await repo.createUserForIdentity({
        provider: "deterministic",
        subject: "tenki-svc-none-subject",
        providerEmail: "tenki-svc-none@example.com",
      });
      const before = await repo.findPersonalWorkspaceState({
        userAccountId: mapping.userAccountId,
      });
      assert.equal(before.personalWorkspaceId, null);
      assert.equal(before.ownerPersonalMemberships.length, 0);

      const sessionId = await mintSession(repo, mapping.userAccountId);
      const resolved = await auth.resolveSessionWithSetupState(sessionId);
      assert.ok(resolved);
      assert.equal(resolved.setupState, "recovery");
      // No mutation: pointer still NULL, zero Owner memberships.
      const after = await repo.findPersonalWorkspaceState({
        userAccountId: mapping.userAccountId,
      });
      assert.equal(after.personalWorkspaceId, null);
      assert.equal(after.ownerPersonalMemberships.length, 0);
    });

    test('classifies `attachable` as public "recovery" without mutating (no attachExistingConvergence)', async () => {
      const EXISTING_WORKSPACE_ID = "ws-svc-existing-personal";
      const repo = new InMemoryAuthRepository(
        [
          {
            userAccountId: "user-svc-attachable",
            email: "tenki-svc-attachable@example.com",
            identityProvider: "deterministic",
            identitySubject: "tenki-svc-attachable-subject",
            memberships: [
              {
                workspaceId: EXISTING_WORKSPACE_ID,
                slug: "personal-ws-svc-existing-personal",
                name: "Existing Personal",
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
      const auth = buildAuthService(repo);
      const before = await repo.findPersonalWorkspaceState({
        userAccountId: "user-svc-attachable",
      });
      assert.equal(before.personalWorkspaceId, null);
      assert.equal(before.ownerPersonalMemberships.length, 1);

      const sessionId = await mintSession(repo, "user-svc-attachable");
      const resolved = await auth.resolveSessionWithSetupState(sessionId);
      assert.ok(resolved);
      assert.equal(resolved.setupState, "recovery");
      // No mutation: pointer still NULL, EXACTLY one Owner
      // membership on the pre-existing workspace — no duplicate
      // created.
      const after = await repo.findPersonalWorkspaceState({
        userAccountId: "user-svc-attachable",
      });
      assert.equal(after.personalWorkspaceId, null);
      assert.equal(after.ownerPersonalMemberships.length, 1);
      assert.equal(after.ownerPersonalMemberships[0]!.workspaceId, EXISTING_WORKSPACE_ID);
    });

    test('classifies `recovery` (multiple Owner Personal memberships) as public "recovery" without mutating', async () => {
      const repo = new InMemoryAuthRepository(
        [
          {
            userAccountId: "user-svc-recovery",
            email: "tenki-svc-recovery@example.com",
            identityProvider: "deterministic",
            identitySubject: "tenki-svc-recovery-subject",
            memberships: [
              {
                workspaceId: "ws-svc-personal-a",
                slug: "personal-ws-svc-personal-a",
                name: "Personal A",
                workspaceType: "Personal",
                workspaceStatus: "Active",
                role: "Owner",
                capabilities: [],
              },
              {
                workspaceId: "ws-svc-personal-b",
                slug: "personal-ws-svc-personal-b",
                name: "Personal B",
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
      const auth = buildAuthService(repo);
      const before = await repo.findPersonalWorkspaceState({
        userAccountId: "user-svc-recovery",
      });
      assert.equal(before.ownerPersonalMemberships.length, 2);

      const sessionId = await mintSession(repo, "user-svc-recovery");
      const resolved = await auth.resolveSessionWithSetupState(sessionId);
      assert.ok(resolved);
      assert.equal(resolved.setupState, "recovery");
      // Recovery does not auto-link: pointer still NULL, both
      // Owner memberships intact. Recovery resolution beyond
      // re-authentication is explicitly out of scope for #82.
      const after = await repo.findPersonalWorkspaceState({
        userAccountId: "user-svc-recovery",
      });
      assert.equal(after.personalWorkspaceId, null);
      assert.equal(after.ownerPersonalMemberships.length, 2);
    });

    test('classifies `converged` as public "converged" without mutating', async () => {
      const CONVERGED_WORKSPACE_ID = "ws-svc-converged";
      const repo = new InMemoryAuthRepository(
        [
          {
            userAccountId: "user-svc-converged",
            email: "tenki-svc-converged@example.com",
            identityProvider: "deterministic",
            identitySubject: "tenki-svc-converged-subject",
            memberships: [
              {
                workspaceId: CONVERGED_WORKSPACE_ID,
                slug: "personal-ws-svc-converged",
                name: "Converged Personal",
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
      // Stage the converged state by linking the existing workspace.
      await repo.attachExistingPersonalWorkspace({
        userAccountId: "user-svc-converged",
        workspaceId: CONVERGED_WORKSPACE_ID,
      });
      const auth = buildAuthService(repo);
      const sessionId = await mintSession(repo, "user-svc-converged");
      const resolved = await auth.resolveSessionWithSetupState(sessionId);
      assert.ok(resolved);
      assert.equal(resolved.setupState, "converged");
      const after = await repo.findPersonalWorkspaceState({
        userAccountId: "user-svc-converged",
      });
      assert.equal(after.personalWorkspaceId, CONVERGED_WORKSPACE_ID);
      assert.equal(after.ownerPersonalMemberships.length, 1);
    });
  });
});
