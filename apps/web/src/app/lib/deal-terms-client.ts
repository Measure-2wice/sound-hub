// DealTerms client.
//
// Background: the browser interacts with the BG5 Deal / TermsVersion
// API through a small set of typed helpers. Every call includes
// `credentials: "include"` so the HttpOnly session cookie rides on
// the request. Responses are parsed against the shared Zod schemas
// from `@soundhub/types` so the browser cannot drift from the
// contract.
//
// Per ticket #63 the public DTOs expose only the minimum browser-
// safe evidence (Workspace, TermsVersion, timestamp). Private audit
// identifiers (draftedByUserId, approvedByUserId, dealApproverId) are
// never serialized into the response and never appear in this
// client.

import {
  bg5ApproveTermsRequestV1Schema,
  bg5ApproveTermsResponseV1Schema,
  bg5DraftTermsRequestV1Schema,
  bg5DraftTermsResponseV1Schema,
  bg5GetDealResponseV1Schema,
  type Bg5ApproveTermsRequestV1,
  type Bg5ApproveTermsResponseV1,
  type Bg5DraftTermsRequestV1,
  type Bg5DraftTermsResponseV1,
  type Bg5GetDealResponseV1,
} from "@soundhub/types";

export interface DealTermsClientError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

async function parseErrorResponse(response: Response): Promise<DealTermsClientError> {
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
    code: candidate?.error?.code ?? "BG5_DEAL_INTERNAL_FAILED",
    message: candidate?.error?.message ?? "Deal terms request failed. Please try again in a moment.",
    requestId: candidate?.error?.requestId ?? null,
  };
}

function ensureError(value: unknown, fallback: DealTermsClientError): Error {
  if (value instanceof Error) return value;
  const err = new Error(fallback.message);
  Object.assign(err, fallback);
  return err;
}

export async function fetchDeal(
  dealId: string,
  actingWorkspaceId: string,
): Promise<Bg5GetDealResponseV1> {
  const params = new URLSearchParams();
  params.set("actingWorkspaceId", actingWorkspaceId);
  const response = await fetch(
    `/api/deals/${encodeURIComponent(dealId)}?${params.toString()}`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return bg5GetDealResponseV1Schema.parse(raw);
}

export async function draftTerms(
  dealId: string,
  input: Bg5DraftTermsRequestV1,
): Promise<Bg5DraftTermsResponseV1> {
  bg5DraftTermsRequestV1Schema.parse(input); // throw before the network call
  const response = await fetch(`/api/deals/${encodeURIComponent(dealId)}/terms-draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return bg5DraftTermsResponseV1Schema.parse(raw);
}

export async function approveTerms(
  dealId: string,
  input: Bg5ApproveTermsRequestV1,
): Promise<Bg5ApproveTermsResponseV1> {
  bg5ApproveTermsRequestV1Schema.parse(input); // throw before the network call
  const response = await fetch(`/api/deals/${encodeURIComponent(dealId)}/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return bg5ApproveTermsResponseV1Schema.parse(raw);
}