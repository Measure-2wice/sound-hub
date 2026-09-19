// Authentication service.
//
// Background: BG1 requires that managed and deterministic adapters
// funnel through one application boundary that maps the
// (provider, subject) tuple to a persisted UserAccount and issues a
// server-validated session. This service is that boundary.
//
// The service owns no state of its own; the IdentityAdapter owns the
// pending magic-link request, the AuthRepository owns the identity
// mapping and the session table, and this service threads the two
// together. Errors raised here are mapped to safe envelope codes by
// the route layer (AUTH_PROVIDER_UNAVAILABLE for adapter outages,
// AUTH_FAILED for verification rejections, etc.).
//
// Per ADR 0004 the service never reads `Workspace.ownerUserId` — that
// column exists for M1.1 backward compatibility only and is not part
// of the Golden Slice authority path.
//
// Per ticket #59 P2-001 the service accepts a private
// `verificationToken` (the one-time credential from the magic-link
// callback) — NOT the public `correlationId` — so the provider-
// neutral seam cannot accidentally substitute one for the other.
//
// M2 (#82): after identity resolution, the service invokes the
// Personal Workspace convergence service to classify and (if
// needed) create or link the Personal Workspace + Owner membership.
// The session is ALWAYS issued (recovery preserves identity), and
// the public user payload carries `setupState: "converged" |
// "recovery"`.

import { randomUUID } from "node:crypto";
import type { Bg1IdentityProviderV1, Bg1PublicUserV1, Bg1SetupStateV1 } from "@soundhub/types";
import type { IdentityAdapter, SignInRequestResult } from "../identity/identity-adapter.js";
import type {
  AuthRepository,
  PublicUserView,
  SessionRecord,
} from "../auth-repository/auth-repository.js";
import { toPublicUser } from "../dto/public-mappers.js";
import type { PersonalWorkspaceConvergenceService } from "./personal-workspace-convergence.service.js";

// Default session lifetime for the Buildathon Golden Slice. The ticket
// explicitly excludes production session-lifetime policy from this
// scope; 24 hours is a long enough window for the integrated browser
// journey and short enough to limit replay risk if a session id ever
// leaks. Real production session lifetime, inactivity policy, and
// all-device revocation are owned by later Milestones.
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "AUTH_PROVIDER_UNAVAILABLE"
      | "AUTH_FAILED"
      | "AUTH_RATE_LIMITED"
      | "INVALID_AUTH_REQUEST",
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface AuthenticationServiceDeps {
  readonly identityAdapter: IdentityAdapter;
  readonly authRepository: AuthRepository;
  /**
   * M2 (#82): Personal Workspace convergence service. The auth
   * service delegates the convergence decision + orchestration to
   * this collaborator and reads back the resulting `setupState`.
   */
  readonly personalWorkspaceConvergenceService: PersonalWorkspaceConvergenceService;
  /**
   * Override for `Date.now()`; tests pass a controlled clock so
   * session-lifetime assertions are deterministic.
   */
  readonly now?: () => number;
  /**
   * Override for the default 24h session lifetime. Tests pass a
   * smaller value to assert expiry semantics without sleeping.
   */
  readonly sessionLifetimeMs?: number;
}

export interface RequestSignInResult {
  /**
   * Neutral envelope returned to the browser. Identical regardless of
   * whether the email is registered, so the public surface cannot be
   * used to enumerate accounts. The `requestId` is the PUBLIC
   * correlation id (managed: SoundHub UUID; deterministic:
   * correlation id) and is required by the BG1 shared contract; it
   * is NOT a verification credential (per ticket #59 P2-001). The
   * `devVerificationUrl` is set only when the deterministic adapter
   * runs in explicitly gated local test mode. Deployed and
   * production-like processes cannot enable this field.
   */
  readonly envelope: {
    readonly ok: true;
    readonly requestId: string;
    readonly devVerificationUrl?: string;
  };
}

export interface VerifySignInResult {
  readonly session: SessionRecord;
  readonly publicUser: Bg1PublicUserV1;
}

export class AuthenticationService {
  private readonly identityAdapter: IdentityAdapter;
  private readonly authRepository: AuthRepository;
  private readonly personalWorkspaceConvergenceService: PersonalWorkspaceConvergenceService;
  private readonly now: () => number;
  private readonly sessionLifetimeMs: number;

  constructor(deps: AuthenticationServiceDeps) {
    this.identityAdapter = deps.identityAdapter;
    this.authRepository = deps.authRepository;
    this.personalWorkspaceConvergenceService = deps.personalWorkspaceConvergenceService;
    this.now = deps.now ?? (() => Date.now());
    this.sessionLifetimeMs = deps.sessionLifetimeMs ?? SESSION_LIFETIME_MS;
  }

  /**
   * Begin a magic-link sign-in. Returns the neutral envelope the
   * route writes back. The adapter decides whether to send real
   * email (managed) or to store locally (deterministic).
   */
  async requestSignIn(input: { readonly email: string }): Promise<RequestSignInResult> {
    const result = await this.dispatch(() =>
      this.identityAdapter.requestSignIn({ email: input.email }),
    );
    return {
      envelope: withRequestIdAndOptionalDevUrl(result),
    };
  }

  /**
   * Verify a magic-link verification credential, find-or-create the
   * UserAccount, converge the Personal Workspace (or detect
   * recovery), and issue a server-validated session. Returns
   * the session record (the route maps it to an HttpOnly cookie) and
   * the public user view for the post-sign-in render.
   *
   * Per ticket #59 P2-001 the input field is named
   * `verificationToken`: the private, one-time credential the
   * browser extracted from the magic-link callback URL. The
   * PUBLIC `correlationId` from `requestSignIn` is NOT accepted
   * here — presenting it is rejected as an unknown credential.
   *
   * The Personal Workspace convergence service handles the create /
   * attach / recovery classification atomically. The session is
   * ALWAYS issued — recovery preserves identity but withholds
   * Personal Workspace authority. The public user payload carries
   * `setupState: "converged" | "recovery"`.
   */
  async verifySignIn(input: { readonly verificationToken: string }): Promise<VerifySignInResult> {
    const verified = await this.dispatch(() =>
      this.identityAdapter.verifySignIn({ verificationToken: input.verificationToken }),
    );
    if (!verified) {
      throw new AuthenticationError(
        "Magic link is invalid, expired, or already used.",
        "AUTH_FAILED",
      );
    }

    const mapping = await this.resolveOrCreateUser({
      provider: verified.provider,
      subject: verified.subject,
      providerEmail: verified.providerEmail,
    });

    // M2 (#82): converge the Personal Workspace + Owner membership.
    // The convergence service classifies and (if needed) creates /
    // links atomically. Recovery surfaces via `setupState` on the
    // public user payload, not via an exception here.
    await this.convergePersonalWorkspace(mapping.userAccountId);

    const session = await this.authRepository.createSession({
      userAccountId: mapping.userAccountId,
      expiresAt: new Date(this.now() + this.sessionLifetimeMs),
    });

    const publicUserView = await this.authRepository.getPublicUser(mapping.userAccountId);
    if (!publicUserView) {
      throw new AuthenticationError(
        "User account is not available for this session.",
        "AUTH_FAILED",
      );
    }

    const setupState = await this.resolveSetupState(mapping.userAccountId);
    return {
      session,
      publicUser: toPublicUser(publicUserView, setupState),
    };
  }

  /**
   * Resolve the current session from a session cookie id. Returns
   * `null` when no valid session exists (expired, revoked, or
   * unknown).
   */
  async resolveSession(sessionId: string | undefined): Promise<PublicUserView | null> {
    if (!sessionId) return null;
    const session = await this.authRepository.getActiveSession(sessionId);
    if (!session) return null;
    return this.authRepository.getPublicUser(session.userAccountId);
  }

  /**
   * Resolve the current session + setup state. Used by `/me` so the
   * browser can render recovery based solely on `setupState`.
   *
   * Tenki PR #91 hardening: the public user view is re-fetched
   * AFTER `resolveSetupState` runs, not before. The previous
   * implementation read the user view first, then ran the
   * convergence service — so a user whose classification was
   * `none` or `attachable` (no Personal Workspace pointer yet)
   * was reported on `/me` with `setupState: "converged"` but
   * an empty `workspaces` array. Reading the view AFTER
   * convergence guarantees the response is internally
   * consistent: `setupState: "converged"` implies exactly one
   * Personal Workspace on the public user view.
   */
  async resolveSessionWithSetupState(
    sessionId: string | undefined,
  ): Promise<{ readonly user: PublicUserView; readonly setupState: Bg1SetupStateV1 } | null> {
    if (!sessionId) return null;
    const session = await this.authRepository.getActiveSession(sessionId);
    if (!session) return null;
    const setupState = await this.resolveSetupState(session.userAccountId);
    const view = await this.authRepository.getPublicUser(session.userAccountId);
    if (!view) return null;
    return { user: view, setupState };
  }

  /**
   * Revoke the current session. Idempotent. Returns whether a
   * session row was actually updated (true on first revoke, false
   * on already-revoked or unknown session ids).
   */
  async signOut(sessionId: string | undefined): Promise<boolean> {
    if (!sessionId) return false;
    return this.authRepository.revokeSession(sessionId);
  }

  private async resolveOrCreateUser(input: {
    readonly provider: Bg1IdentityProviderV1;
    readonly subject: string;
    readonly providerEmail: string | null;
  }) {
    const existing = await this.authRepository.findUserByIdentity({
      provider: input.provider,
      subject: input.subject,
    });
    if (existing) return existing;
    return this.authRepository.createUserForIdentity(input);
  }

  /**
   * M2 (#82): run the convergence service to classify and (if
   * needed) create or attach the Personal Workspace + Owner
   * membership. Recovery is observed via `setupState` on the
   * public user; the convergence service itself is the only
   * orchestrator and the only owner of the CAS-retry budget.
   */
  private async convergePersonalWorkspace(userAccountId: string): Promise<void> {
    const kind = await this.personalWorkspaceConvergenceService.resolveConvergence({
      userAccountId,
    });
    switch (kind.kind) {
      case "converged":
        return;
      case "none":
        await this.personalWorkspaceConvergenceService.createInitialConvergence({
          userAccountId,
        });
        return;
      case "attachable":
        await this.personalWorkspaceConvergenceService.attachExistingConvergence({
          userAccountId,
          workspaceId: kind.workspaceId,
        });
        return;
      case "recovery":
        // Recovery preserves identity (session is still issued).
        // The public user payload carries `setupState: "recovery"`
        // so the browser renders the recovery surface.
        return;
      default: {
        const _exhaustive: never = kind;
        void _exhaustive;
        return;
      }
    }
  }

  /**
   * Resolve the current setup state by classifying the Personal
   * Workspace convergence. Always returns `"converged"` or
   * `"recovery"` (the public DTO never surfaces the internal
   * recovery reason and never surfaces `"none"` / `"attachable"`).
   *
   * Tenki PR #91 hardening: the previous implementation collapsed
   * every non-recovery kind into `"converged"`, which meant a
   * session-holding user whose `personalWorkspaceId` pointer was
   * NULL (a `none` or `attachable` classification) was reported
   * as converged and the recovery surface was never shown on
   * `/api/auth/me`. This method now runs the convergence flow
   * before emitting `"converged"`, and handles the final
   * classification exhaustively — no default-to-converged branch.
   *
   * - `converged` → public `"converged"`.
   * - `recovery` → public `"recovery"`.
   * - `none` → run `createInitialConvergence`, then re-classify.
   * - `attachable` → run `attachExistingConvergence`, then
   *   re-classify.
   *
   * After the flow runs, the re-classification must produce
   * `converged` or `recovery`. Anything else (a stuck `none` /
   * `attachable`) is a contract violation and throws — the public
   * DTO MUST NOT be allowed to fabricate `"converged"`.
   */
  private async resolveSetupState(userAccountId: string): Promise<Bg1SetupStateV1> {
    const kind = await this.personalWorkspaceConvergenceService.resolveConvergence({
      userAccountId,
    });
    switch (kind.kind) {
      case "converged":
        return "converged";
      case "recovery":
        return "recovery";
      case "none":
        await this.personalWorkspaceConvergenceService.createInitialConvergence({
          userAccountId,
        });
        break;
      case "attachable":
        await this.personalWorkspaceConvergenceService.attachExistingConvergence({
          userAccountId,
          workspaceId: kind.workspaceId,
        });
        break;
      default: {
        // Compile-time exhaustiveness. Reaching this branch means
        // a new ConvergenceKind variant was added without
        // updating this boundary; fail closed so we never emit a
        // fabricated setupState.
        const _exhaustive: never = kind;
        void _exhaustive;
        throw new AuthenticationError(
          "Personal Workspace convergence classification produced an unrecognised variant.",
          "AUTH_FAILED",
        );
      }
    }
    // Re-classify after the convergence flow ran. The result MUST
    // be "converged" or "recovery" — anything else (a stuck
    // `none` / `attachable`) is a contract violation and must
    // NOT be silently collapsed to "converged".
    const finalKind = await this.personalWorkspaceConvergenceService.resolveConvergence({
      userAccountId,
    });
    switch (finalKind.kind) {
      case "converged":
        return "converged";
      case "recovery":
        return "recovery";
      case "none":
      case "attachable":
        throw new AuthenticationError(
          "Personal Workspace convergence could not be settled to a public state.",
          "AUTH_FAILED",
        );
      default: {
        const _exhaustive: never = finalKind;
        void _exhaustive;
        throw new AuthenticationError(
          "Personal Workspace convergence produced an unrecognised variant after re-classification.",
          "AUTH_FAILED",
        );
      }
    }
  }

  /**
   * Wrap an adapter call so the contract's
   * `IdentityProviderUnavailableError` and
   * `IdentityVerificationFailedError` are translated into the safe
   * envelope's error codes without leaking adapter internals into the
   * response body. The message text is intentionally generic so the
   * caller cannot infer whether the provider is misconfigured,
   * offline, or denying the request — every transient cause maps to
   * the same AUTH_PROVIDER_UNAVAILABLE response.
   */
  private async dispatch<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof Error && err.name === "IdentityProviderUnavailableError") {
        throw new AuthenticationError(
          "Authentication provider is currently unavailable.",
          "AUTH_PROVIDER_UNAVAILABLE",
        );
      }
      if (err instanceof Error && err.name === "IdentityVerificationFailedError") {
        throw new AuthenticationError("Magic link verification failed.", "AUTH_FAILED");
      }
      throw new AuthenticationError(
        "Authentication request could not be processed.",
        "AUTH_FAILED",
      );
    }
  }
}

// ---------- Mapping helpers (DTO boundary) ----------

/**
 * The magic-link envelope forwards the adapter's PUBLIC
 * `correlationId` (as `requestId` for backward compatibility with
 * the BG1 magic-link response schema) plus the optional
 * `devVerificationUrl`. The `requestId` is NOT a verify
 * credential. The deterministic adapter additionally returns a
 * private `verificationToken` on the adapter's return value —
 * that field is intentionally NOT forwarded here. It is kept
 * inside the adapter boundary so the public route layer can never
 * expose it (the BG1 magic-link response schema is `.strict()`
 * and does not declare a `verificationToken` field). The
 * `devVerificationUrl` is local/test-only and absent outside the
 * local test verification path so an unauthenticated browser cannot
 * pick a demo identity by email.
 */
function withRequestIdAndOptionalDevUrl(result: SignInRequestResult): {
  ok: true;
  requestId: string;
  devVerificationUrl?: string;
} {
  if (result.devVerificationUrl === undefined) {
    return { ok: true, requestId: result.correlationId };
  }
  return {
    ok: true,
    requestId: result.correlationId,
    devVerificationUrl: result.devVerificationUrl,
  };
}

// Re-export the shared mapper for callers that imported it from this
// module before the move to `dto/public-mappers.ts`. The internal
// implementation lives in one module so the route, the authentication
// service, and the authorization service cannot drift.
export { toPublicUser };

// Re-export a helper for tests that need to mint a session id
// without exercising the full sign-in flow. The id is opaque; the
// only place it is meaningful is `resolveSession`.
export function generateTestSessionId(): string {
  return randomUUID();
}
