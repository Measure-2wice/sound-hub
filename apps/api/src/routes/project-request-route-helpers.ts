// Shared route helpers for the ProjectRequest router.
//
// Background: the five route handlers (create, get, list, accept,
// decline) repeat the same primitives — request-id resolution,
// session resolution, body parsing, path / query-param reading,
// Zod validation of the request body, Zod validation of the
// response shape, and translation of the typed
// `ProjectRequestError` into the safe envelope. Per P2-001 these
// primitives live here once so the handlers stay focused on their
// endpoint-specific flow. The route layer still owns untrusted JSON
// parsing and the safe error envelope; nothing here leaks Prisma
// models.

import type { Request, Response } from "express";
import { ZodError, type ZodSchema } from "zod";
import {
  buildFieldErrors,
  buildSafeError,
  generateRequestId,
  writeSafeError,
  type SafeErrorResponse,
} from "../lib/errors.js";
import { SESSION_COOKIE } from "../lib/session-cookie.js";
import { ProjectRequestError } from "../project-request/project-request.service.js";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_PATH_PARAM_LENGTH = 128;

export function resolveRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return generateRequestId();
}

/**
 * Resolve the authenticated session and the request id in one step.
 * Returns the single request id alongside the session so the handler
 * can reuse it for envelope writes and log correlation without
 * resolving a second id (P1-003). Writes the SESSION_INVALID
 * envelope and returns `null` when the caller is not signed in.
 * The handler MUST bail out when this returns null.
 */
export async function resolveSessionForProjectRequest(
  req: Request,
  res: Response,
  authenticationService: { resolveSession(id: string | undefined): Promise<unknown> },
  actionLabel: string,
): Promise<{
  readonly session: { readonly userAccountId: string };
  readonly requestId: string;
} | null> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);
  const sessionId = readSessionCookie(req);
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

export function readSessionCookie(req: Request): string | undefined {
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

export function readPathParamForProjectRequest(
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
        "PROJECT_REQUEST_INVALID",
        `${name} is missing or malformed.`,
        undefined,
        requestId,
      ),
    );
    return null;
  }
  return value;
}

export function readActingWorkspaceIdFromQuery(
  res: Response,
  req: Request,
  requestId: string,
): string | null {
  const value = req.query["actingWorkspaceId"];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_PARAM_LENGTH) {
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "actingWorkspaceId is required.",
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
 * the appropriate safe envelope (PROJECT_REQUEST_INVALID on
 * payload-too-large or malformed JSON). The handler MUST bail out
 * when this returns null.
 */
export async function readJsonBodyForProjectRequest(
  req: Request,
  res: Response,
  requestId: string,
): Promise<unknown> {
  const existing: unknown = req.body;
  if (existing !== undefined && existing !== null) return existing;

  const chunks: Buffer[] = [];
  let total = 0;
  const limit = MAX_REQUEST_BODY_BYTES;
  // After the size cap fires we must not leave the request stream
  // paused indefinitely — a paused readable holds the underlying
  // connection open and prevents Node from closing the socket. We
  // switch the data handler into a drain mode (skip accumulation)
  // and call req.resume() so the remaining bytes flow through the
  // handler (and are dropped) until the stream emits 'end' /
  // 'close'. This is the smallest correct Node behaviour
  // consistent with this codebase; we deliberately do NOT call
  // req.destroy() so the client can finish sending the oversized
  // body and the connection can close cleanly.
  let drainingAfterCap = false;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        if (drainingAfterCap) {
          // The body has already been rejected as too large; keep
          // consuming so the stream emits 'end' / 'close' and the
          // underlying connection can close. We never accumulate
          // or interpret these chunks.
          return;
        }
        total += chunk.length;
        if (total > limit) {
          drainingAfterCap = true;
          req.pause();
          writeSafeError(
            res,
            buildSafeError(
              "PROJECT_REQUEST_INVALID",
              `Request body exceeds the ${limit}-byte limit.`,
              undefined,
              requestId,
            ),
          );
          // Resume the stream so the remaining bytes drain and
          // the stream can emit 'end' / 'close'. Without this the
          // stream would remain paused indefinitely and keep the
          // connection open.
          req.resume();
          reject(new BodyReadError("payload-too-large"));
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
        "PROJECT_REQUEST_INVALID",
        "Request body is not valid JSON.",
        undefined,
        requestId,
      ),
    );
    return null;
  }
}

class BodyReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyReadError";
  }
}

/**
 * Validate the parsed body against a Zod schema and return the
 * parsed value, or `null` after writing the safe envelope. The
 * caller-supplied `failureLabel` is interpolated into the field
 * error so the buyer can identify which schema run failed.
 */
export function validateProjectRequestBody<T>(
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
          "PROJECT_REQUEST_INVALID",
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

/**
 * Validate the assembled response against a Zod schema and write it.
 * On drift the safe envelope is written instead so the contract is
 * never violated in production. Response-schema drift is an internal
 * server failure, not a malformed request from the buyer / seller,
 * so the fallback is the PROJECT_REQUEST_FAILED / 500 envelope (NOT
 * PROJECT_REQUEST_INVALID / 400). The Zod error is logged
 * server-side; the safe envelope never echoes internal validation
 * detail. Returns `true` if the response was written, `false` if
 * the envelope fallback was used.
 */
export function validateProjectRequestResponse<T>(
  res: Response,
  status: number,
  schema: ZodSchema<T>,
  body: T,
  requestId: string,
  contextLabel: string,
): boolean {
  const validated = schema.safeParse(body);
  if (!validated.success) {
    writeProjectRequestInternalError(
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
 * Translate a service / authorization error into the safe envelope
 * and write it. Returns `true` if the envelope was written so the
 * handler can stop.
 */
export function translateProjectRequestServiceError(
  res: Response,
  err: unknown,
  requestId: string,
): boolean {
  if (err instanceof ProjectRequestError) {
    const safe: SafeErrorResponse = buildSafeError(err.code, err.message, undefined, requestId);
    console.error(`[project-requests] requestId=${requestId} code=${err.code}:`, err);
    writeSafeError(res, safe);
    return true;
  }
  return false;
}

/**
 * Write a generic 500 fallback safe envelope for an unexpected
 * exception that escaped the typed ProjectRequestError surface. The
 * underlying exception is logged server-side so production can debug
 * without leaking it; the envelope carries the generic
 * `PROJECT_REQUEST_FAILED` message and the request id only.
 */
export function writeProjectRequestInternalError(
  res: Response,
  err: unknown,
  requestId: string,
  contextLabel: string,
): void {
  console.error(`[project-requests] requestId=${requestId} ${contextLabel} unhandled:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "PROJECT_REQUEST_FAILED",
      `An unexpected error occurred while ${contextLabel}.`,
      undefined,
      requestId,
    ),
  );
}

/**
 * Write a generic safe envelope for a query-string validation
 * failure. The list handler uses this when the `status` filter is
 * outside the allow-list.
 */
export function writeProjectRequestQueryError(
  res: Response,
  requestId: string,
  message: string,
): void {
  writeSafeError(res, buildSafeError("PROJECT_REQUEST_INVALID", message, undefined, requestId));
}

// Suppress unused-export warnings for the internal `BodyReadError`
// class. The helpers surface is the only public API.
void (BodyReadError as unknown);
