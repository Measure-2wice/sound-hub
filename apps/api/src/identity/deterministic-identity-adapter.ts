// Deterministic identity adapter.
//
// Background: BG1 requires a deterministic local authentication
// adapter for two purposes:
//
//   1. Automated tests, where waiting on real email delivery and
//      signing in through the Supabase SSR callback would be
//      prohibitive. Tests opt in to the dev verification URL via
//      the `allowDevVerificationUrl` constructor option and
//      drive `verifySignIn` directly with the adapter's
//      `verificationToken` return value.
//   2. The approved emergency fallback path: if managed email
//      delivery, callback/session integration, or deployment
//      configuration cannot pass the bounded provider smoke, this
//      adapter is the deployed fallback. Per the ticket this
//      fallback changes credential verification only and requires
//      no redesign or relaxation of Workspace authorization —
//      every other layer (session store, authorization service,
//      route handler) is identical to the managed path.
//
// Per ticket #59 P2-001, the deterministic adapter splits its
// pending request into two opaque identifiers with distinct names
// and semantics:
//
//   - `correlationId`: the PUBLIC handle returned on
//     `SignInRequestResult.correlationId`. Safe to expose; cannot
//     verify. Surfaces in logs and observability.
//   - `verificationToken`: the PRIVATE one-time credential the
//     pending request is stored under. Returned on the adapter's
//     `SignInRequestResult.verificationToken` so test harnesses can
//     drive `verifySignIn` directly, and logged to the operator
//     sink in operator mode so the deployed recovery path can
//     complete sign-in through the same application boundary the
//     managed path uses. Never returned in any public DTO.
//
// Per ADR 0004 the adapter never touches UserAccount, Workspace, or
// membership tables — those live in `PrismaAuthRepository`.

import { randomUUID, createHash } from "node:crypto";
import type { Bg1IdentityProviderV1 } from "@soundhub/types";
import { deriveDeterministicSubject } from "@soundhub/types";
import {
  type IdentityAdapter,
  type SignInRequestResult,
  type VerifiedIdentity,
} from "./identity-adapter.js";

interface PendingRequest {
  readonly email: string;
  readonly subject: string;
  readonly expiresAt: number;
  readonly consumed: boolean;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes per the managed provider norm

export interface DeterministicIdentityAdapterOptions {
  /**
   * Optional explicit clock for deterministic tests. Defaults to
   * `Date.now`. The adapter never advances the clock; callers that
   * need to assert expiry behaviour construct a new instance with a
   * fixed clock or use {@link DeterministicIdentityAdapter.expireAll}.
   */
  readonly now?: () => number;
  /**
   * Optional time-to-live for a generated request, in milliseconds.
   * Defaults to 15 minutes to match a typical managed provider's
   * magic-link lifetime. Tests that exercise expiry pass a smaller
   * value.
   */
  readonly ttlMs?: number;
  /**
   * Operator-controlled escape hatch. When `true`, the adapter
   * returns a `devVerificationUrl` that an operator-driven UI
   * (or a test harness) can follow to verify without email
   * delivery. Defaults to `false` so the deployed process never
   * exposes a usable login credential to an unauthenticated
   * browser that merely supplies an email. Tests pass `true`
   * explicitly; the operator enables the allow-listed recovery
   * mode by setting `BG1_DETERMINISTIC_OPERATOR_MODE=1` in the
   * deployed process.
   */
  readonly allowDevVerificationUrl?: boolean;
  /**
   * Optional override of the path the returned dev verification URL
   * points at. Defaults to `/auth/verify`. Tests can override this
   * to assert the contract independently from the Next.js route
   * placement. Only honoured when `allowDevVerificationUrl` is
   * `true`.
   */
  readonly verificationPathPrefix?: string;
}

/**
 * The deterministic adapter is the test + emergency fallback path.
 * It must still establish server-validated identity — the contract is
 * identical to the managed adapter so every higher layer is shared.
 */
export class DeterministicIdentityAdapter implements IdentityAdapter {
  readonly providerKey: Bg1IdentityProviderV1 = "deterministic";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly allowDevVerificationUrl: boolean;
  private readonly verificationPathPrefix: string;

  constructor(options: DeterministicIdentityAdapterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.allowDevVerificationUrl = options.allowDevVerificationUrl ?? false;
    this.verificationPathPrefix = options.verificationPathPrefix ?? "/auth/verify";
  }

  /**
   * Reset internal state. Used by tests that share an instance across
   * cases. Production code never calls this; the adapter is a long-
   * lived singleton in the API composition root.
   */
  reset(): void {
    this.pending.clear();
  }

  /**
   * Mark every pending request as expired by advancing the clock
   * past their TTL. Used by tests that need to assert the
   * single-use + expiry semantics without sleeping.
   */
  expireAll(): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.set(id, { ...entry, expiresAt: 0 });
    }
  }

  /**
   * Count of currently pending (un-consumed, un-expired) requests.
   * Used by tests that need to confirm the adapter tracks requests.
   */
  pendingCount(): number {
    this.gc();
    let count = 0;
    for (const entry of this.pending.values()) {
      if (!entry.consumed) count += 1;
    }
    return count;
  }

  /**
   * Begin a deterministic magic-link sign-in. Returns:
   *
   *   - `correlationId` — public, observability-only handle. Safe
   *     to expose; the browser MAY see this value but MUST NOT be
   *     able to round-trip it through `verifySignIn`.
   *   - `verificationToken` — private one-time credential. The
   *     pending request is stored under this value (not the
   *     `correlationId`), so a browser that submits the
   *     correlation id to `/api/auth/verify-token` is rejected as
   *     an unknown credential. Test harnesses drive
   *     `verifySignIn` with this value directly; the deployed
   *     operator recovery workflow reads it from the operator log
   *     sink.
   *
   * The `devVerificationUrl` is NEVER returned on the adapter's
   * `SignInRequestResult`. When `allowDevVerificationUrl` is
   * `true` the URL is emitted to the operator's log sink so the
   * operator-driven recovery workflow can drive verifySignIn
   * through the same application boundary the managed path uses,
   * but without any usable value ever crossing the public
   * response.
   */
  async requestSignIn(input: { readonly email: string }): Promise<SignInRequestResult> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const verificationToken = randomUUID();
    const correlationId = randomUUID();
    const subject = deriveDeterministicSubject(normalizedEmail, sha256Hex);
    this.pending.set(verificationToken, {
      email: normalizedEmail,
      subject,
      expiresAt: this.now() + this.ttlMs,
      consumed: false,
    });
    if (this.allowDevVerificationUrl) {
      const url = `${this.verificationPathPrefix}?token=${encodeURIComponent(verificationToken)}`;
      // Operator-mode log sink: the URL is recorded so the
      // operator can drive the recovery flow. The browser MUST
      // NEVER receive the URL — the response carries only the
      // opaque public correlationId. The verificationToken in
      // the URL is the same value the adapter returned on the
      // SignInRequestResult for test harnesses.
      console.log(
        `[bg1-deterministic] operator-mode verification URL for ${normalizedEmail} ` +
          `(correlation=${correlationId}): ${url}`,
      );
    }
    return Promise.resolve({ correlationId, verificationToken });
  }

  /**
   * Exchange a one-time magic-link verification credential for the
   * deterministic identity. The pending request is keyed by the
   * `verificationToken` (NOT the public `correlationId`), so a
   * browser that submits the correlation id is rejected as an
   * unknown credential.
   */
  async verifySignIn(input: {
    readonly verificationToken: string;
  }): Promise<VerifiedIdentity | null> {
    this.gc();
    const credential = input.verificationToken;
    if (typeof credential !== "string" || credential.length === 0) return null;
    const entry = this.pending.get(credential);
    if (!entry) return null;
    if (entry.consumed) return null;
    if (entry.expiresAt <= this.now()) return null;
    // Single-use: mark consumed before returning so a concurrent
    // verify cannot double-issue.
    this.pending.set(credential, { ...entry, consumed: true });
    return Promise.resolve({
      provider: this.providerKey,
      subject: entry.subject,
      providerEmail: entry.email,
    });
  }

  private gc(): void {
    const cutoff = this.now();
    for (const [id, entry] of this.pending.entries()) {
      if (entry.consumed || entry.expiresAt <= cutoff) {
        this.pending.delete(id);
      }
    }
  }
}

/**
 * SHA-256 hex digest shared between the deterministic adapter and the
 * seed. Both use Node's `crypto.createHash` so the digest matches
 * exactly; the contract in `@soundhub/types` only specifies the
 * string format, not the algorithm, so a future migration can swap
 * the hash without breaking the lookup.
 */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
