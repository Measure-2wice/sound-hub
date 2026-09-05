// Deal-list client (ticket #74).
//
// Background: the /deals discovery page reads the Workspace-scoped
// Deal list through this helper. It follows the same conventions as
// `deal-terms-client.ts`: `credentials: "include"` so the HttpOnly
// session cookie rides on the request, and the response is parsed
// against the shared Zod schema so the browser cannot drift from the
// contract.
//
// The list DTO is deliberately slim (ticket #74): human-readable
// context, Deal status, derived approval state, and a derived funding
// status enum. Amounts, provider metadata, payment identifiers, and
// workspace ids are not part of the contract and never reach here.

import { listDealsResponseV1Schema, type ListDealsResponseV1 } from "@soundhub/types";

export interface DealListClientError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

async function parseErrorResponse(response: Response): Promise<DealListClientError> {
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
    code: candidate?.error?.code ?? "DEAL_LIST_FAILED",
    message:
      candidate?.error?.message ?? "Could not load your Deals. Please try again in a moment.",
    requestId: candidate?.error?.requestId ?? null,
  };
}

/**
 * Build an Error carrying the safe envelope's code, status, and
 * requestId so call sites can branch on `code` (e.g. to refresh a
 * stale session) rather than on message text.
 */
function toClientError(fallback: DealListClientError): Error {
  const err = new Error(fallback.message);
  Object.assign(err, fallback);
  return err;
}

/**
 * Read the Deals discoverable through the acting Workspace.
 *
 * Authorization is entirely server-side: the API revalidates current
 * membership for the exact (session user, actingWorkspaceId) tuple
 * inside the same transaction that reads the Deals. A revoked member
 * receives DEAL_LIST_FORBIDDEN, never a partial list.
 */
export async function listDeals(actingWorkspaceId: string): Promise<ListDealsResponseV1> {
  const params = new URLSearchParams();
  params.set("actingWorkspaceId", actingWorkspaceId);
  const response = await fetch(`/api/deals?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw toClientError(await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return listDealsResponseV1Schema.parse(raw);
}
