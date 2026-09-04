// Shared route helpers for the BG6 PaymentIntent + activation router.
//
// Per refinement feedback this PR does NOT extract a shared helper
// module; the BG5 helpers are reused by direct import. The BG6
// translation table (FundingServiceError → BG6_* codes) lives here
// because it is BG6-specific; the BG5 code path is unaffected.

import type { Request, Response } from "express";
import type { ZodSchema } from "zod";
import { buildFieldErrors, buildSafeError, writeSafeError } from "../lib/errors.js";
import { SESSION_COOKIE } from "../lib/session-cookie.js";
import { FundingServiceError } from "../funding/funding.service.js";
import {
  resolveDealTermsRequestId,
  resolveSessionForDealTerms,
  readDealTermsPathParam,
  readDealTermsJsonBody,
} from "./deal-terms-route-helpers.js";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;

export function resolveFundingRequestId(req: Request): string {
  return resolveDealTermsRequestId(req);
}

export async function resolveSessionForFunding(
  req: Request,
  res: Response,
  authenticationService: { resolveSession(id: string | undefined): Promise<unknown> },
  actionLabel: string,
): Promise<{
  readonly session: { readonly userAccountId: string };
  readonly requestId: string;
} | null> {
  return resolveSessionForDealTerms(req, res, authenticationService, actionLabel);
}

export function readFundingPathParam(
  res: Response,
  req: Request,
  name: string,
  requestId: string,
): string | null {
  return readDealTermsPathParam(res, req, name, requestId);
}

export async function readFundingJsonBody(
  req: Request,
  res: Response,
  requestId: string,
): Promise<unknown> {
  return readDealTermsJsonBody(req, res, requestId);
}

export function readFundingSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
      const raw = trimmed.slice(SESSION_COOKIE.length + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Validate the request body against the supplied Zod schema. On
 * success, returns the parsed value. On failure, writes a
 * BG6_FUNDING_INVALID envelope and returns null.
 */
export function validateFundingRequestBody<TSchema extends ZodSchema>(
  res: Response,
  schema: TSchema,
  rawBody: unknown,
  requestId: string,
  actionLabel: string,
): ReturnType<TSchema["parse"]> | null {
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    writeSafeError(
      res,
      buildSafeError(
        "BG6_FUNDING_INVALID",
        `${actionLabel} failed schema validation.`,
        buildFieldErrors(
          parsed.error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
        ),
        requestId,
      ),
    );
    return null;
  }
  return parsed.data as ReturnType<TSchema["parse"]>;
}

/**
 * Validate the response shape against the supplied Zod schema before
 * writing JSON. On failure, writes a BG6_FUNDING_INTERNAL_FAILED
 * envelope (server-side drift between the contract and our
 * construction). On success, writes the validated payload with the
 * supplied HTTP status.
 */
export function validateFundingResponse<TSchema extends ZodSchema>(
  res: Response,
  status: number,
  schema: TSchema,
  payload: unknown,
  requestId: string,
  actionLabel: string,
): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    writeSafeError(
      res,
      buildSafeError(
        "BG6_FUNDING_INTERNAL_FAILED",
        `${actionLabel} response drift detected.`,
        buildFieldErrors(
          parsed.error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
        ),
        requestId,
      ),
    );
    return;
  }
  res.setHeader("x-request-id", requestId);
  res.status(status).json(parsed.data);
}

const MAX_BODY_CAP = MAX_REQUEST_BODY_BYTES;

export { MAX_BODY_CAP };

/**
 * Translate a FundingServiceError into the safe envelope. Returns
 * true when the error was handled (and the response written), false
 * otherwise (caller should treat as BG6_FUNDING_INTERNAL_FAILED).
 */
export function translateFundingServiceError(
  res: Response,
  err: unknown,
  requestId: string,
): boolean {
  if (!(err instanceof FundingServiceError)) return false;
  // Safe envelope: do NOT echo raw exception text. The
  // FundingServiceError constructor accepts a message but the
  // persisted provider detail lives only in PaymentIntent.failureDetail
  // (server-only) and never crosses any DTO surface.
  writeSafeError(res, buildSafeError(err.code, err.message, undefined, requestId));
  return true;
}

export function writeFundingInternalError(
  res: Response,
  err: unknown,
  requestId: string,
  actionLabel: string,
): void {
  // Server-side log; safe envelope to the client.
  console.error(`[funding] ${actionLabel} unexpected error:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "BG6_FUNDING_INTERNAL_FAILED",
      "An internal error occurred.",
      undefined,
      requestId,
    ),
  );
}
