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

import { z } from "zod";
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

/**
 * Translate a Zod parse failure into the shared `ApiFieldErrorV1`
 * shape so the review surface's ErrorSummary and the editor's
 * per-control anchor map can highlight every offending field.
 *
 * The publish/update STRICT schema rejects empty `professionalName`,
 * `bio`, or absent `countryCode` at the trust boundary BEFORE any
 * request is sent; without this translation those rejections would
 * surface as a generic "Couldn't publish" string with no linked
 * guidance. Each Zod issue becomes one `ApiFieldErrorV1` with the
 * dotted path the editor's anchor map already understands. The
 * `message` is rewritten in human-friendly terms for the well-known
 * #84 required fields so the linked summary reads naturally; any
 * other path keeps the verbatim Zod message as a fallback.
 */
function zodErrorToFieldErrors(zerr: z.ZodError): readonly ApiFieldErrorV1[] {
  return zerr.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    let code = "invalid_field";
    let message = issue.message;
    if (path === "identity.professionalName") {
      code = "professional_name_required";
      message = "Professional name is required to publish.";
    } else if (path === "identity.bio") {
      code = "bio_required";
      message = "Biography is required to publish.";
    } else if (path === "basedIn.countryCode") {
      code = "country_required";
      message = "Country is required to publish.";
    } else if (path === "disciplines.specialtyKeys") {
      code = "specialty_required";
      message = "At least one controlled specialty is required to publish.";
    } else if (path === "disciplines.caribbeanAffiliationCodes") {
      code = "caribbean_affiliation_required";
      message = "At least one Caribbean affiliation is required to publish.";
    }
    return {
      path,
      code,
      message,
    };
  });
}

/**
 * Wrap a Zod parse so a STRICT publish/update payload that fails
 * locally (empty `professionalName`, missing `countryCode`, etc.)
 * is thrown as a typed `SellerProfileClientError` carrying
 * `fieldErrors`, instead of a raw `ZodError` the review surface
 * does not understand. A fresh `Error` instance is used (rather
 * than mutating the ZodError) so the typed properties survive
 * downstream checks like `asSellerProfileClientError`.
 */
function ensureParsedStrict<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof z.ZodError) {
      const fieldErrors = zodErrorToFieldErrors(err);
      const firstMessage =
        fieldErrors[0]?.message ??
        "Your Professional Profile is missing required fields. Use the linked summary to correct them.";
      const wrapped = new Error(firstMessage);
      // Constructed typed-error with side-effect of attaching the
      // seller-profile-client error shape to a vanilla `Error` so
      // `asSellerProfileClientError` recognizes the thrown value.
      // `Error` allows extra own properties at runtime; assign
      // them here and re-throw.
      const typed = wrapped as Error & {
        status: number;
        code: string;
        requestId: string | null;
        fieldErrors: readonly ApiFieldErrorV1[];
      };
      typed.status = 0;
      typed.code = "SELLER_PROFILE_INCOMPLETE";
      typed.requestId = null;
      typed.fieldErrors = fieldErrors;
      throw typed;
    }
    throw err;
  }
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
  const payload = ensureParsedStrict(() => sellerProfilePublishRequestV1Schema.parse(input.publish));
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
  const payload = ensureParsedStrict(() => sellerProfileUpdateRequestV1Schema.parse(input.update));
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
