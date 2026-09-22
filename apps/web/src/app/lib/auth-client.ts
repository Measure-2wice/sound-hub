// Auth client.
//
// Background: the browser interacts with the BG1 authentication API
// through a small set of typed helpers. Every call runs in the
// browser and includes `credentials: "include"` so the HttpOnly
// session cookie rides on the request. Responses are parsed against
// the shared Zod schemas from `@soundhub/types` so the browser cannot
// drift from the contract.
//
// Per ticket #59 P2-001 the request payload for `/api/auth/verify-token`
// carries the PRIVATE one-time `verificationToken` (the value the
// browser extracted from the magic-link callback URL). The PUBLIC
// correlation id returned by `/api/auth/magic-link` is NOT a
// verification credential and CANNOT be submitted here.
//
// Per ticket #59 P1-002 the deployed process never returns a
// `devVerificationUrl`. The field exists only for explicitly gated
// local browser tests; managed verification tokens arrive through
// the email callback.

import type {
  Bg1MagicLinkRequestV1,
  Bg1MagicLinkResponseV1,
  Bg1SessionInfoV1,
  Bg1VerifyTokenRequestV1,
  Bg1VerifyTokenResponseV1,
  IntentRequestV1,
  IntentResponseV1,
  MarketplaceCapabilityV1,
} from "@soundhub/types";

export type { Bg1VerifyTokenResponseV1, IntentResponseV1 };

/**
 * M2 (#82): server-derived recovery state. The convergence service
 * classifies the Personal Workspace state into "converged" or
 * "recovery" and surfaces it on the public user payload. The
 * browser reads `user.setupState` to decide whether to render the
 * dashboard or the recovery surface; it NEVER infers recovery from
 * the workspaces array.
 */
export interface VerifyTokenSuccess {
  readonly status: "ok";
  readonly user: Bg1VerifyTokenResponseV1["user"];
  readonly returnTo: string | null;
}
import {
  bg1MagicLinkResponseV1Schema,
  bg1SessionInfoV1Schema,
  bg1VerifyTokenResponseV1Schema,
  intentRequestV1Schema,
  intentResponseV1Schema,
} from "@soundhub/types";

export interface AuthClientError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
  /**
   * INTENT_CONFLICT surfaces the FRESH persisted capability set
   * on `error.freshCapabilities` so the UI can render an
   * actionable recovery affordance. Absent on every other
   * envelope.
   */
  readonly freshCapabilities: readonly MarketplaceCapabilityV1[] | null;
}

async function parseErrorResponse(response: Response): Promise<AuthClientError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // The server should always return a safe envelope, but a network
    // failure or empty body is reported with a generic code so the
    // UI can render an actionable message.
  }
  const candidate = body as {
    error?: {
      code?: string;
      message?: string;
      requestId?: string;
      freshCapabilities?: readonly MarketplaceCapabilityV1[];
    };
  } | null;
  return {
    status: response.status,
    code: candidate?.error?.code ?? "AUTH_FAILED",
    message: candidate?.error?.message ?? "Authentication request failed.",
    requestId: candidate?.error?.requestId ?? null,
    freshCapabilities: candidate?.error?.freshCapabilities ?? null,
  };
}

function ensureError(value: unknown, fallback: AuthClientError): Error {
  // Surface the safe envelope as a real Error so call-sites can use
  // standard error-handling primitives without losing the structured
  // fields. The fallback lets the parse-failure path throw something
  // meaningful rather than `throw { status, code, message }`.
  if (value instanceof Error) return value;
  const err = new Error(fallback.message);
  Object.assign(err, fallback);
  return err;
}

export async function requestMagicLink(
  input: Bg1MagicLinkRequestV1,
): Promise<Bg1MagicLinkResponseV1> {
  const response = await fetch("/api/auth/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return bg1MagicLinkResponseV1Schema.parse(raw);
}

/**
 * M2 (#82): read the validated return destination from the current
 * URL (`?return=<path>`). The server is the authoritative validator
 * — this client helper only forwards the raw query parameter so the
 * magic-link route can validate and set the return-context cookie.
 */
export function readReturnFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("return");
}

export async function verifyToken(
  input: Bg1VerifyTokenRequestV1,
): Promise<Bg1VerifyTokenResponseV1> {
  const response = await fetch("/api/auth/verify-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return bg1VerifyTokenResponseV1Schema.parse(raw);
}

/**
 * M2 (#82): read the validated `returnTo` from a verify-token
 * response. Returns `null` when no destination was preserved
 * (recovery override, missing cookie, invalid cookie).
 */
export function readReturnTo(result: Bg1VerifyTokenResponseV1): string | null {
  return result.returnTo;
}

export async function fetchSessionInfo(): Promise<Bg1SessionInfoV1> {
  const response = await fetch("/api/auth/me", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return bg1SessionInfoV1Schema.parse(raw);
}

export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
}

export async function selectActingWorkspace(input: {
  actingWorkspaceId: string;
}): Promise<{ readonly safeReturnTo: string | null }> {
  const response = await fetch("/api/auth/acting-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  // The server-resolved `safeReturnTo` represents CONTEXTUAL
  // authorization — the destination is reachable from the FRESH
  // post-commit acting Workspace. The browser consumes ONLY
  // this value; the raw `?return=` query parameter is never
  // honored client-side after a successful commit.
  const body = raw as { safeReturnTo?: unknown };
  return {
    safeReturnTo:
      typeof body.safeReturnTo === "string" && body.safeReturnTo.length > 0
        ? body.safeReturnTo
        : null,
  };
}

/**
 * M2 (#83): submit the user's intent choice (`Hire talent`,
 * `Offer services`, `Both`) to the server. The server validates
 * the request body, revalidates current membership on the acting
 * Workspace, and provisions the requested capability set. The
 * server's response carries the updated public user payload and
 * the validated `returnTo` (or `null`).
 *
 * The browser never reads raw query parameters to recover a return
 * destination — the response's `returnTo` is the only authoritative
 * value, validated by the existing internal-return validation rules.
 *
 * The intent surface carries no `sellerAcceptance` field — #83
 * does NOT collect a generic Seller participation/terms acceptance
 * at capability-provisioning time.
 */
export async function submitIntent(input: {
  workspaceId: string;
  intent: IntentRequestV1;
}): Promise<IntentResponseV1> {
  // The route layer validates the body against `intentRequestV1Schema`
  // before the service runs; the client re-validates so a stale UI
  // cannot produce a request that the server would reject. The
  // schema is the executable contract on both sides.
  const validated = intentRequestV1Schema.parse(input.intent);
  const response = await fetch(`/api/workspaces/${encodeURIComponent(input.workspaceId)}/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(validated),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return intentResponseV1Schema.parse(raw);
}
