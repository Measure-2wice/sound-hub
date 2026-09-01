// ProjectRequest client.
//
// Background: the browser interacts with the BG4 ProjectRequest API
// through a small set of typed helpers. Every call includes
// `credentials: "include"` so the HttpOnly session cookie rides on
// the request. Responses are parsed against the shared Zod schemas
// from `@soundhub/types` so the browser cannot drift from the
// contract.

import type {
  CreateProjectRequestRequestV1,
  CreateProjectRequestResponseV1,
  GetProjectRequestResponseV1,
  ListProjectRequestsResponseV1,
  AcceptProjectRequestResponseV1,
  DeclineProjectRequestResponseV1,
  RespondProjectRequestRequestV1,
  ProjectRequestStatusV1,
} from "@soundhub/types";
import {
  acceptProjectRequestResponseV1Schema,
  createProjectRequestResponseV1Schema,
  declineProjectRequestResponseV1Schema,
  getProjectRequestResponseV1Schema,
  listProjectRequestsResponseV1Schema,
} from "@soundhub/types";

export interface ProjectRequestClientError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

async function parseErrorResponse(response: Response): Promise<ProjectRequestClientError> {
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
    code: candidate?.error?.code ?? "PROJECT_REQUEST_INVALID",
    message:
      candidate?.error?.message ?? "ProjectRequest request failed. Please try again in a moment.",
    requestId: candidate?.error?.requestId ?? null,
  };
}

function ensureError(value: unknown, fallback: ProjectRequestClientError): Error {
  if (value instanceof Error) return value;
  const err = new Error(fallback.message);
  Object.assign(err, fallback);
  return err;
}

export async function createProjectRequest(
  input: CreateProjectRequestRequestV1,
): Promise<CreateProjectRequestResponseV1> {
  const response = await fetch("/api/project-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return createProjectRequestResponseV1Schema.parse(raw);
}

export async function fetchProjectRequest(
  projectRequestId: string,
  actingWorkspaceId: string,
): Promise<GetProjectRequestResponseV1> {
  const response = await fetch(
    `/api/project-requests/${encodeURIComponent(projectRequestId)}?actingWorkspaceId=${encodeURIComponent(actingWorkspaceId)}`,
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
  return getProjectRequestResponseV1Schema.parse(raw);
}

export interface ListProjectRequestsInput {
  readonly actingWorkspaceId: string;
  readonly statusFilter?: ProjectRequestStatusV1;
}

export async function listProjectRequests(
  input: ListProjectRequestsInput,
): Promise<ListProjectRequestsResponseV1> {
  const params = new URLSearchParams();
  params.set("actingWorkspaceId", input.actingWorkspaceId);
  if (input.statusFilter) {
    // Match the shared `listProjectRequestsRequestV1Schema` field name
    // exactly. The TypeScript input already exposes this as
    // `statusFilter`; sending it as `status` would produce a 400
    // PROJECT_REQUEST_INVALID envelope from the API and a confusing
    // failure on the seller inbox. The web must mirror the contract
    // verbatim — no alias.
    params.set("statusFilter", input.statusFilter);
  }
  const response = await fetch(`/api/project-requests?${params.toString()}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return listProjectRequestsResponseV1Schema.parse(raw);
}

export async function acceptProjectRequest(
  projectRequestId: string,
  input: RespondProjectRequestRequestV1,
): Promise<AcceptProjectRequestResponseV1> {
  const response = await fetch(
    `/api/project-requests/${encodeURIComponent(projectRequestId)}/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return acceptProjectRequestResponseV1Schema.parse(raw);
}

export async function declineProjectRequest(
  projectRequestId: string,
  input: RespondProjectRequestRequestV1,
): Promise<DeclineProjectRequestResponseV1> {
  const response = await fetch(
    `/api/project-requests/${encodeURIComponent(projectRequestId)}/decline`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    throw ensureError(null, await parseErrorResponse(response));
  }
  const raw: unknown = await response.json();
  return declineProjectRequestResponseV1Schema.parse(raw);
}
