// SellerProfile client (M2 #84).
//
// Background: the browser interacts with the seller-profile API
// through a small set of typed helpers. Every call runs in the
// browser and includes `credentials: "include"` so the HttpOnly
// session cookie rides on the request. Responses are parsed
// against the shared Zod schemas from `@soundhub/types` so the
// browser cannot drift from the contract.
//
// Per #84 lifecycle the editor and review surfaces issue five
// commands against the SellerProfile slice:
//
//   - GET /api/workspaces/:workspaceId/seller-profile
//   - PUT /api/workspaces/:workspaceId/seller-profile/draft
//   - POST /api/workspaces/:workspaceId/seller-profile/publish
//   - PUT /api/workspaces/:workspaceId/seller-profile
//
// The client generates one `idempotencyKey` per new
// publication/update attempt. The key is RETAINED across any
// uncertain transport outcome and explicit Retry actions. It is
// cleared only on definitive success or on payload change /
// abandonment. This is the approved retry-identity lifecycle.

import {
  sellerProfileDraftRequestV1Schema,
  sellerProfileDraftResponseV1Schema,
  sellerProfileGetResponseV1Schema,
  sellerProfilePublicationResponseV1Schema,
  sellerProfilePublishRequestV1Schema,
  sellerProfileUpdateRequestV1Schema,
  sellerProfileTaxonomyResponseV1Schema,
  type ApiFieldErrorV1,
  type SellerProfileDraftRequestV1,
  type SellerProfileDraftResponseV1,
  type SellerProfileGetResponseV1,
  type SellerProfilePublicationResponseV1,
  type SellerProfilePublishRequestV1,
  type SellerProfileTaxonomyResponseV1,
  type SellerProfileUpdateRequestV1,
} from "@soundhub/types";

export type {
  SellerProfileDraftResponseV1,
  SellerProfileGetResponseV1,
  SellerProfilePublicationResponseV1,
  SellerProfileTaxonomyResponseV1,
};

export interface SellerProfileClientError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
  readonly fieldErrors: readonly ApiFieldErrorV1[];
}

async function parseErrorResponse(response: Response): Promise<SellerProfileClientError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Network or empty body — fall through to a generic error
    // so the UI can render an actionable message.
  }
  const candidate = body as {
    error?: {
      code?: string;
      message?: string;
      requestId?: string;
      fields?: readonly ApiFieldErrorV1[];
    };
  } | null;
  return {
    status: response.status,
    code: candidate?.error?.code ?? "SELLER_PROFILE_INTERNAL_FAILED",
    message:
      candidate?.error?.message ?? "Seller profile request failed. Please try again in a moment.",
    requestId: candidate?.error?.requestId ?? null,
    fieldErrors: candidate?.error?.fields ?? [],
  };
}

function ensureError(value: unknown, fallback: SellerProfileClientError): Error {
  if (value instanceof Error) {
    Object.assign(value, fallback);
    return value;
  }
  const err = new Error(fallback.message);
  Object.assign(err, fallback);
  return err;
}

function actionPath(workspaceId: string, action: "draft" | "publish" | ""): string {
  const tail = action ? `/${action}` : "";
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/seller-profile${tail}`;
}

/**
 * Generate a fresh idempotencyKey. Called when a new
 * publication/update attempt begins. The caller MUST retain
 * the key across transport retries — only generate a new one
 * when the user changes the payload or abandons the attempt.
 */
export function generateSellerProfileIdempotencyKey(): string {
  // crypto.randomUUID is supported in all modern browsers and
  // matches the Zod `z.string().uuid()` schema.
  return crypto.randomUUID();
}

export async function fetchSellerProfile(input: {
  readonly workspaceId: string;
}): Promise<SellerProfileGetResponseV1> {
  const response = await fetch(actionPath(input.workspaceId, ""), {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const body: unknown = await response.json();
  return sellerProfileGetResponseV1Schema.parse(body);
}

export async function fetchSellerProfileTaxonomy(): Promise<SellerProfileTaxonomyResponseV1> {
  const response = await fetch("/api/metadata/seller-profile-taxonomy", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const body: unknown = await response.json();
  return sellerProfileTaxonomyResponseV1Schema.parse(body);
}

export async function saveSellerProfileDraft(input: {
  readonly workspaceId: string;
  readonly draft: SellerProfileDraftRequestV1;
}): Promise<SellerProfileDraftResponseV1> {
  const payload = sellerProfileDraftRequestV1Schema.parse(input.draft);
  const response = await fetch(actionPath(input.workspaceId, "draft"), {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const body: unknown = await response.json();
  return sellerProfileDraftResponseV1Schema.parse(body);
}

export async function publishSellerProfile(input: {
  readonly workspaceId: string;
  readonly publish: SellerProfilePublishRequestV1;
}): Promise<SellerProfilePublicationResponseV1> {
  const payload = sellerProfilePublishRequestV1Schema.parse(input.publish);
  const response = await fetch(actionPath(input.workspaceId, "publish"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const body: unknown = await response.json();
  return sellerProfilePublicationResponseV1Schema.parse(body);
}

export async function updatePublishedSellerProfile(input: {
  readonly workspaceId: string;
  readonly update: SellerProfileUpdateRequestV1;
}): Promise<SellerProfilePublicationResponseV1> {
  const payload = sellerProfileUpdateRequestV1Schema.parse(input.update);
  const response = await fetch(actionPath(input.workspaceId, ""), {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const body: unknown = await response.json();
  return sellerProfilePublicationResponseV1Schema.parse(body);
}

/**
 * Extract a typed `SellerProfileClientError` from a thrown value,
 * or `null` if the value is not a SellerProfile client error.
 * The editor and review pages use this to render `role="alert"`
 * `Alert`s with the structured fields surfaced from the safe
 * envelope.
 */
export function asSellerProfileClientError(err: unknown): SellerProfileClientError | null {
  if (err instanceof Error && typeof (err as { code?: unknown }).code === "string") {
    const candidate = err as unknown as Partial<SellerProfileClientError> & Error;
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string" &&
      typeof candidate.status === "number"
    ) {
      return {
        status: candidate.status,
        code: candidate.code,
        message: candidate.message,
        requestId: candidate.requestId ?? null,
        fieldErrors: candidate.fieldErrors ?? [],
      };
    }
  }
  return null;
}
