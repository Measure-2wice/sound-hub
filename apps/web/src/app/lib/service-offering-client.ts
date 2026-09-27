// ServiceOffering client (M2 #85).
//
// Background: the browser interacts with the service-offering API
// through a small set of typed helpers. Every call runs in the
// browser and includes `credentials: "include"` so the HttpOnly
// session cookie rides on the request. Responses are parsed against
// the shared Zod schemas from `@soundhub/types` so the browser
// cannot drift from the contract.
//
// The editor issues five commands against the ServiceOffering slice:
//
//   - GET    /api/workspaces/:workspaceId/service-offerings
//   - GET    /api/workspaces/:workspaceId/service-offerings/:offeringId
//   - PUT    /api/workspaces/:workspaceId/service-offerings/:offeringId/draft
//   - POST   /api/workspaces/:workspaceId/service-offerings/:offeringId/activate
//
// The client generates one `idempotencyKey` per new activation
// attempt. The key is RETAINED across any uncertain transport
// outcome and explicit Retry actions. It is cleared only on
// definitive success or on payload change / abandonment. This is
// the approved retry-identity lifecycle.

import {
  serviceOfferingActivateRequestV1Schema,
  serviceOfferingActivationResponseV1Schema,
  serviceOfferingDraftRequestV1Schema,
  serviceOfferingDraftResponseV1Schema,
  serviceOfferingGetResponseV1Schema,
  serviceOfferingOwnerListResponseV1Schema,
  serviceOfferingTaxonomyResponseV1Schema,
  type ApiFieldErrorV1,
  type ServiceOfferingActivateRequestV1,
  type ServiceOfferingActivationResponseV1,
  type ServiceOfferingDraftRequestV1,
  type ServiceOfferingDraftResponseV1,
  type ServiceOfferingGetResponseV1,
  type ServiceOfferingOwnerListResponseV1,
  type ServiceOfferingTaxonomyResponseV1,
} from "@soundhub/types";

export type {
  ServiceOfferingDraftResponseV1,
  ServiceOfferingGetResponseV1,
  ServiceOfferingActivationResponseV1,
  ServiceOfferingOwnerListResponseV1,
  ServiceOfferingTaxonomyResponseV1,
};

export interface ServiceOfferingClientError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
  readonly fieldErrors: readonly ApiFieldErrorV1[];
}

async function parseErrorResponse(response: Response): Promise<ServiceOfferingClientError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Empty or non-JSON bodies are reported with a generic code so
    // the UI can render an actionable message.
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
    code: candidate?.error?.code ?? "SERVICE_OFFERING_INTERNAL_FAILED",
    message:
      candidate?.error?.message ?? "Service offering request failed. Please try again in a moment.",
    requestId: candidate?.error?.requestId ?? null,
    fieldErrors: candidate?.error?.fields ?? [],
  };
}

function ensureError(value: unknown, fallback: ServiceOfferingClientError): Error {
  if (value instanceof Error) {
    Object.assign(value, fallback);
    return value;
  }
  const err = new Error(fallback.message);
  Object.assign(err, fallback);
  return err;
}

function offeringPath(workspaceId: string, offeringId: string, tail: string): string {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/service-offerings/${encodeURIComponent(offeringId)}`;
  return tail ? `${base}${tail}` : base;
}

/**
 * Generate a fresh idempotencyKey. Called when a new activation
 * attempt begins. The caller MUST retain the key across transport
 * retries — only generate a new one when the user changes the
 * payload or abandons the attempt.
 */
export function generateServiceOfferingIdempotencyKey(): string {
  // crypto.randomUUID is supported in all modern browsers and
  // matches the Zod `z.string().uuid()` schema on activate.
  return crypto.randomUUID();
}

export async function fetchServiceOfferingTaxonomy(): Promise<ServiceOfferingTaxonomyResponseV1> {
  const response = await fetch("/api/metadata/service-offering-taxonomy", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const body: unknown = await response.json();
  return serviceOfferingTaxonomyResponseV1Schema.parse(body);
}

export async function fetchServiceOffering(input: {
  readonly workspaceId: string;
  readonly offeringId: string;
}): Promise<ServiceOfferingGetResponseV1> {
  const response = await fetch(offeringPath(input.workspaceId, input.offeringId, ""), {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const body: unknown = await response.json();
  return serviceOfferingGetResponseV1Schema.parse(body);
}

export async function listServiceOfferings(input: {
  readonly workspaceId: string;
}): Promise<ServiceOfferingOwnerListResponseV1> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/service-offerings`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const body: unknown = await response.json();
  return serviceOfferingOwnerListResponseV1Schema.parse(body);
}

export async function saveServiceOfferingDraft(input: {
  readonly workspaceId: string;
  readonly offeringId: string;
  readonly draft: ServiceOfferingDraftRequestV1;
}): Promise<ServiceOfferingDraftResponseV1> {
  const payload = serviceOfferingDraftRequestV1Schema.parse(input.draft);
  const response = await fetch(offeringPath(input.workspaceId, input.offeringId, "/draft"), {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const body: unknown = await response.json();
  return serviceOfferingDraftResponseV1Schema.parse(body);
}

export async function activateServiceOffering(input: {
  readonly workspaceId: string;
  readonly offeringId: string;
  readonly activation: ServiceOfferingActivateRequestV1;
}): Promise<ServiceOfferingActivationResponseV1> {
  const payload = serviceOfferingActivateRequestV1Schema.parse(input.activation);
  const response = await fetch(offeringPath(input.workspaceId, input.offeringId, "/activate"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const body: unknown = await response.json();
  return serviceOfferingActivationResponseV1Schema.parse(body);
}

/**
 * Extract a typed `ServiceOfferingClientError` from a thrown value,
 * or `null` if the value is not a ServiceOffering client error.
 */
export function asServiceOfferingClientError(err: unknown): ServiceOfferingClientError | null {
  if (err instanceof Error && typeof (err as { code?: unknown }).code === "string") {
    const candidate = err as unknown as Partial<ServiceOfferingClientError> & Error;
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
