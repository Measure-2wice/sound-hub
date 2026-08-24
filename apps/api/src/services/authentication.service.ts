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

import { randomUUID } from "node:crypto";
import type { Bg1IdentityProviderV1, Bg1PublicUserV1, Bg1PublicWorkspaceV1 } from "@soundhub/types";
import type { IdentityAdapter, SignInRequestResult } from "../identity/identity-adapter.js";
import type {
  AuthRepository,
  PublicUserView,
  SessionRecord,
  WorkspaceMembershipView,
} from "../auth-repository/auth-repository.js";

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
   * used to enumerate accounts. The `devVerificationUrl` is set only
   * when the active adapter is the deterministic adapter (test +
   * emergency fallback path).
   */
  readonly envelope: {
    readonly ok: true;
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
  private readonly now: () => number;
  private readonly sessionLifetimeMs: number;

  constructor(deps: AuthenticationServiceDeps) {
    this.identityAdapter = deps.identityAdapter;
    this.authRepository = deps.authRepository;
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
      envelope: withOptionalDevUrl(result),
    };
  }

  /**
   * Verify a magic-link token, find-or-create the UserAccount, and
   * issue a server-validated session. Returns the session record
   * (the route maps it to an HttpOnly cookie) and the public user
   * view for the post-sign-in render.
   *
   * The function is structured so the verify-token call and the
   * session creation are not transactional in PostgreSQL but the
   * single-use verification token + the lookup-or-create mapping
   * give the equivalent guarantee: the same request id cannot issue
   * two sessions, and a stale token cannot claim an existing user.
   */
  async verifySignIn(input: { readonly requestId: string }): Promise<VerifySignInResult> {
    const verified = await this.dispatch(() =>
      this.identityAdapter.verifySignIn({ requestId: input.requestId }),
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

    return {
      session,
      publicUser: toPublicUser(publicUserView),
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
 * The verify-token response carries only allow-listed identity and
 * membership facts; provider subjects live in the public user view
 * but never cross the buyer-facing seller DTO. This helper is the
 * single source of truth for the mapping so route handlers and
 * future server-side consumers cannot drift.
 */
export function toPublicUser(user: PublicUserView): Bg1PublicUserV1 {
  return {
    userAccountId: user.userAccountId,
    email: user.email,
    displayName: user.displayName,
    identityProvider: user.identityProvider,
    identitySubject: user.identitySubject,
    workspaces: user.workspaces.map(toPublicWorkspace),
  };
}

export function toPublicWorkspace(view: WorkspaceMembershipView): Bg1PublicWorkspaceV1 {
  return {
    workspaceId: view.workspaceId,
    slug: view.slug,
    name: view.name,
    workspaceType: view.workspaceType,
    workspaceStatus: view.workspaceStatus,
    capabilities: [...view.capabilities],
  };
}

function withOptionalDevUrl(result: SignInRequestResult): {
  ok: true;
  devVerificationUrl?: string;
} {
  if (result.devVerificationUrl === undefined) {
    return { ok: true };
  }
  return { ok: true, devVerificationUrl: result.devVerificationUrl };
}

// Re-export a helper for tests that need to mint a session id
// without exercising the full sign-in flow. The id is opaque; the
// only place it is meaningful is `resolveSession`.
export function generateTestSessionId(): string {
  return randomUUID();
}
