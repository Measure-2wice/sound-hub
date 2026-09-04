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
// `devVerificationUrl`; the operator-driven recovery workflow reads
// it from server logs. The browser uses the opaque
// `verificationToken` (managed: Supabase-issued token from the email
// link; deterministic: operator-side credential from the log sink)
// to drive verify-token when the magic-link callback URL is
// configured to route through the deterministic fallback.

import type {
  Bg1MagicLinkRequestV1,
  Bg1MagicLinkResponseV1,
  Bg1SessionInfoV1,
  Bg1VerifyTokenRequestV1,
  Bg1VerifyTokenResponseV1,
} from "@soundhub/types";
import {
  bg1MagicLinkResponseV1Schema,
  bg1SessionInfoV1Schema,
  bg1VerifyTokenResponseV1Schema,
} from "@soundhub/types";

export interface AuthClientError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
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
    };
  } | null;
  return {
    status: response.status,
    code: candidate?.error?.code ?? "AUTH_FAILED",
    message: candidate?.error?.message ?? "Authentication request failed.",
    requestId: candidate?.error?.requestId ?? null,
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

export async function selectActingWorkspace(input: { actingWorkspaceId: string }): Promise<void> {
  const response = await fetch("/api/auth/acting-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
}
