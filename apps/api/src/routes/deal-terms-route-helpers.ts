// Shared route helpers for the Deal / TermsVersion / DealApproval router.
//
// Background: the three BG5 endpoints (draft terms, approve terms,
// read deal view) share the same primitives as BG4 — session
// resolution, body parsing, path / query-param reading, Zod
// validation of the request body, Zod validation of the response
// shape, and translation of the typed `DealTermsError` into the safe
// envelope. These helpers are intentionally THIN: they reuse the
// same body-reading pattern as the BG4 router without copying its
// file verbatim, and they add only the BG5-specific envelope
// translation. The route layer still owns untrusted JSON parsing and
// the safe error envelope; nothing here leaks Prisma models.

import type { Request, Response } from "express";
import { ZodError, type ZodSchema } from "zod";
import {
  buildFieldErrors,
  buildSafeError,
  generateRequestId,
  writeSafeError,
  type SafeErrorResponse,
} from "../lib/errors.js";
import { DealTermsError } from "../deal-terms/deal-terms.service.js";
import { SESSION_COOKIE } from "../lib/session-cookie.js";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_PATH_PARAM_LENGTH = 128;

export function resolveDealTermsRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return generateRequestId();
}

export function readDealTermsSessionCookie(req: Request): string | undefined {
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
 * Resolve the authenticated session and the request id in one step.
 * Returns the single request id alongside the session so the handler
 * can reuse it for envelope writes and log correlation. Writes the
 * SESSION_INVALID envelope and returns `null` when the caller is not
 * signed in.
 */
export async function resolveSessionForDealTerms(
  req: Request,
  res: Response,
  authenticationService: { resolveSession(id: string | undefined): Promise<unknown> },
  actionLabel: string,
): Promise<{
  readonly session: { readonly userAccountId: string };
  readonly requestId: string;
} | null> {
  const requestId = resolveDealTermsRequestId(req);
  res.setHeader("x-request-id", requestId);
  const sessionId = readDealTermsSessionCookie(req);
  const session = await authenticationService.resolveSession(sessionId);
  if (!session || typeof (session as { userAccountId?: unknown }).userAccountId !== "string") {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        `Sign in is required to ${actionLabel}.`,
        undefined,
        requestId,
      ),
    );
    return null;
  }
  return {
    session: { userAccountId: (session as { userAccountId: string }).userAccountId },
    requestId,
  };
}

export function readDealTermsPathParam(
  res: Response,
  req: Request,
  name: string,
  requestId: string,
): string | null {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_PARAM_LENGTH) {
    writeSafeError(
      res,
      buildSafeError(
        "BG5_DEAL_NOT_FOUND",
        `${name} is missing or malformed.`,
        undefined,
        requestId,
      ),
    );
    return null;
  }
  return value;
}

export function readDealTermsQueryParam(
  res: Response,
  req: Request,
  name: string,
  requestId: string,
): string | null {
  const value = req.query[name];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_PARAM_LENGTH) {
    writeSafeError(
      res,
      buildSafeError(
        "BG5_TERMS_DRAFT_INVALID",
        `${name} is required.`,
        undefined,
        requestId,
      ),
    );
    return null;
  }
  return value;
}

/**
 * Read the JSON request body and return it, or `null` after writing
 * the appropriate safe envelope. Same Node-stream shape as the BG4
 * helper; the only BG5-specific difference is the
 * `BG5_TERMS_DRAFT_INVALID` envelope on malformed JSON (BG4 uses
 * `PROJECT_REQUEST_INVALID`).
 */
export async function readDealTermsJsonBody(
  req: Request,
  res: Response,
  requestId: string,
): Promise<unknown> {
  const existing: unknown = req.body;
  if (existing !== undefined && existing !== null) return existing;

  const chunks: Buffer[] = [];
  let total = 0;
  const limit = MAX_REQUEST_BODY_BYTES;
  let drainingAfterCap = false;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        if (drainingAfterCap) return;
        total += chunk.length;
        if (total > limit) {
          drainingAfterCap = true;
          req.pause();
          writeSafeError(
            res,
            buildSafeError(
              "BG5_TERMS_DRAFT_INVALID",
              `Request body exceeds the ${limit}-byte limit.`,
              undefined,
              requestId,
            ),
          );
          req.resume();
          reject(new DealTermsBodyReadError("payload-too-large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", (err: Error) => reject(err));
    });
  } catch (err) {
    if (err instanceof Error && err.message === "payload-too-large") {
      return null;
    }
    throw err;
  }
  if (res.writableEnded) return null;
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    writeSafeError(
      res,
      buildSafeError(
        "BG5_TERMS_DRAFT_INVALID",
        "Request body is not valid JSON.",
        undefined,
        requestId,
      ),
    );
    return null;
  }
}

class DealTermsBodyReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DealTermsBodyReadError";
  }
}

export function validateDealTermsBody<T>(
  res: Response,
  schema: ZodSchema<T>,
  rawBody: unknown,
  requestId: string,
  failureLabel: string,
): T | null {
  try {
    return schema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      writeSafeError(
        res,
        buildSafeError(
          "BG5_TERMS_DRAFT_INVALID",
          `${failureLabel} failed schema validation.`,
          buildFieldErrors(err.issues),
          requestId,
        ),
      );
      return null;
    }
    throw err;
  }
}

export function validateDealTermsResponse<T>(
  res: Response,
  status: number,
  schema: ZodSchema<T>,
  body: T,
  requestId: string,
  contextLabel: string,
): boolean {
  const validated = schema.safeParse(body);
  if (!validated.success) {
    writeDealTermsInternalError(
      res,
      validated.error,
      requestId,
      `${contextLabel}-response-schema-drift`,
    );
    return false;
  }
  res.status(status).json(validated.data);
  return true;
}

/**
 * Translate a DealTermsError into the safe envelope. Returns true if
 * the envelope was written so the handler can stop.
 */
export function translateDealTermsServiceError(
  res: Response,
  err: unknown,
  requestId: string,
): boolean {
  if (err instanceof DealTermsError) {
    const safe: SafeErrorResponse = buildSafeError(err.code, err.message, undefined, requestId);
    console.error(`[deal-terms] requestId=${requestId} code=${err.code}:`, err);
    writeSafeError(res, safe);
    return true;
  }
  return false;
}

export function writeDealTermsInternalError(
  res: Response,
  err: unknown,
  requestId: string,
  contextLabel: string,
): void {
  console.error(`[deal-terms] requestId=${requestId} ${contextLabel} unhandled:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "BG5_DEAL_INTERNAL_FAILED",
      `An unexpected error occurred while ${contextLabel}.`,
      undefined,
      requestId,
    ),
  );
}

// Suppress unused-export warnings for the internal body-read error class.
void (DealTermsBodyReadError as unknown);