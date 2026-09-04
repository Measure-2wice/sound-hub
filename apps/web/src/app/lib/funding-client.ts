// Funding client (BG6).
//
// Background: the browser interacts with the BG6 PaymentIntent +
// activation endpoint through a single typed helper. The wrapper
// carries `credentials: "include"` so the HttpOnly session cookie
// rides on the request. The response is parsed against the shared
// `bg6FundDealResponseV1Schema` so the browser cannot drift from the
// contract. The minimal public funding-status DTO carries no
// internal identifiers — paymentIntentId, correlationId,
// providerReference, raw failureDetail, and the internal
// `providerState` field are explicitly NOT present on the response.
//
// Per refinement feedback this PR does NOT extract a shared client
// error helper; `parseErrorResponse` / `ensureError` are duplicated
// from `deal-terms-client.ts` (with the BG6 fallback code) to keep
// BG6's diff isolated.

import {
  bg6FundDealRequestV1Schema,
  bg6FundDealResponseV1Schema,
  type Bg6FundDealRequestV1,
  type Bg6FundDealResponseV1,
} from "@soundhub/types";

export interface FundingClientError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

async function parseErrorResponse(response: Response): Promise<FundingClientError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Network or empty body — fall through to a generic error.
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
    code: candidate?.error?.code ?? "BG6_FUNDING_INTERNAL_FAILED",
    message: candidate?.error?.message ?? "Funding request failed. Please try again in a moment.",
    requestId: candidate?.error?.requestId ?? null,
  };
}

function ensureError(value: unknown, fallback: FundingClientError): Error {
  if (value instanceof Error) return value;
  const err = new Error(fallback.message);
  Object.assign(err, fallback);
  return err;
}

export async function fundDeal(
  dealId: string,
  input: Bg6FundDealRequestV1,
): Promise<Bg6FundDealResponseV1> {
  bg6FundDealRequestV1Schema.parse(input); // throw before the network call
  const response = await fetch(`/api/deals/${encodeURIComponent(dealId)}/funding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return bg6FundDealResponseV1Schema.parse(raw);
}
