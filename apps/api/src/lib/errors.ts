// Standard safe error envelope for the v1 search contract.
//
// The API surface uses the shared Zod schema `apiErrorResponseV1Schema` from
// @soundhub/types. This module produces the response body and HTTP status and
// centralises the request-ID generation that flows through the
// response headers. Internal exception text never enters the response.

import { randomUUID } from "node:crypto";
import type { Response } from "express";
import {
  apiErrorResponseV1Schema,
  type ApiErrorCodeV1,
  type ApiErrorResponseV1,
  type ApiFieldErrorV1,
} from "@soundhub/types";

export const REQUEST_ID_HEADER = "x-request-id";

export interface SafeErrorResponse {
  readonly status: number;
  readonly body: ApiErrorResponseV1;
}

export function buildFieldErrors(
  issues: ReadonlyArray<{ path: readonly (string | number)[]; code: string; message: string }>,
): readonly ApiFieldErrorV1[] {
  return issues.map((issue) => ({
    path: issue.path.length === 0 ? "<root>" : issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
}

export function buildSafeError(
  code: ApiErrorCodeV1,
  message: string,
  fields: readonly ApiFieldErrorV1[] | undefined,
  requestId: string,
): SafeErrorResponse {
  const body: ApiErrorResponseV1 = {
    error: {
      code,
      message,
      ...(fields ? { fields: [...fields] } : {}),
      requestId,
    },
  };
  const status = mapStatus(code);
  return { status, body };
}

function mapStatus(code: ApiErrorCodeV1): number {
  switch (code) {
    case "INVALID_JSON":
    case "INVALID_SEARCH_CRITERIA":
    case "INVALID_AUTH_REQUEST":
      return 400;
    case "UNSUPPORTED_MEDIA_TYPE":
      return 415;
    case "SEARCH_RATE_LIMITED":
    case "AUTH_RATE_LIMITED":
      return 429;
    case "SEARCH_FAILED":
    case "AUTH_FAILED":
      return 500;
    case "SEARCH_UNAVAILABLE":
    case "AUTH_PROVIDER_UNAVAILABLE":
      return 503;
    // GS 4 / GS 5 authorization rejections. The standard safe envelope
    // does not include 401/403 by default, so we map the new
    // authorization codes to status codes that respect the spirit of
    // those HTTP semantics while preserving the shared envelope
    // contract (every error response carries the same shape).
    case "SESSION_INVALID":
    case "SESSION_EXPIRED":
      return 401;
    case "WORKSPACE_NOT_FOUND":
      return 404;
    case "WORKSPACE_INELIGIBLE":
    case "NOT_A_MEMBER":
    case "MISSING_CAPABILITY":
      return 403;
  }
}

export function generateRequestId(): string {
  return randomUUID();
}

export function writeSafeError(res: Response, response: SafeErrorResponse): void {
  res.setHeader(REQUEST_ID_HEADER, response.body.error.requestId);
  // Validate our own envelope before sending it; this catches drift between
  // the shared schema and our construction here.
  const parsed = apiErrorResponseV1Schema.safeParse(response.body);
  if (!parsed.success) {
    // Last-resort fallback that is itself schema-valid.
    const fallback = apiErrorResponseV1Schema.parse({
      error: {
        code: "SEARCH_FAILED" as const,
        message: "An internal error occurred.",
        requestId: response.body.error.requestId,
      },
    });
    res.status(500).json(fallback);
    return;
  }
  res.status(response.status).json(parsed.data);
}
