// Matchmaker client.
//
// Background: the browser interacts with the BG3 Matchmaker API
// through a small set of typed helpers. Every call includes
// `credentials: "include"` so the HttpOnly session cookie rides on
// the request. Responses are parsed against the shared Zod schemas
// from `@soundhub/types` so the browser cannot drift from the
// contract.

import type {
  Bg3SubmitBriefRequestV1,
  Bg3SubmitBriefResponseV1,
  Bg3GetBriefResponseV1,
} from "@soundhub/types";
import { bg3GetBriefResponseV1Schema, bg3SubmitBriefResponseV1Schema } from "@soundhub/types";

export interface MatchmakerClientError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

async function parseErrorResponse(response: Response): Promise<MatchmakerClientError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Network or empty body — fall through to a generic error so the
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
    code: candidate?.error?.code ?? "MATCHMAKER_FAILED",
    message:
      candidate?.error?.message ?? "Matchmaker request failed. Please try again in a moment.",
    requestId: candidate?.error?.requestId ?? null,
  };
}

function ensureError(value: unknown, fallback: MatchmakerClientError): Error {
  if (value instanceof Error) return value;
  const err = new Error(fallback.message);
  Object.assign(err, fallback);
  return err;
}

export async function submitBrief(
  input: Bg3SubmitBriefRequestV1,
): Promise<Bg3SubmitBriefResponseV1> {
  const response = await fetch("/api/matchmaker/brief", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return bg3SubmitBriefResponseV1Schema.parse(raw);
}

export async function fetchBrief(briefId: string): Promise<Bg3GetBriefResponseV1> {
  const response = await fetch(`/api/matchmaker/brief/${encodeURIComponent(briefId)}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return bg3GetBriefResponseV1Schema.parse(raw);
}
