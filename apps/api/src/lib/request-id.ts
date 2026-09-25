// Shared request-id allow-list + canonical accessor
// (M2 #83 CodeQL hardening, round-7 correlation-IDs).
//
// The `x-request-id` HTTP header is an untrusted client-supplied
// value. It ends up in three places on the response path:
//   1. The `console.error` sink in the global error middleware
//      (`apps/api/src/index.ts`). Node's `console.error` passes
//      its first argument through `util.format`, which
//      interprets `%s`, `%d`, `%o`, `%j`, etc. as format
//      specifiers — leaving an attacker-supplied `%s` in that
//      position lets the attacker steer format substitution.
//   2. The `console.error` sink in route handlers (e.g.,
//      `apps/api/src/routes/intent.ts`). Same hazard.
//   3. `buildSafeError(...)` -> JSON response body and
//      `res.setHeader("x-request-id", ...)`. JSON.stringify
//      escapes `<>"`, but log/header hygiene for control bytes
//      is still desirable.
//
// Two-step design:
//
//   (a) `resolveRequestId(req)` — the SANITIZER. Reads the
//       raw `x-request-id` header and returns a value in
//       `[A-Za-z0-9._-]{1,128}` (the original when it conforms,
//       a freshly generated UUID otherwise). ONLY the boundary
//       middleware (`apps/api/src/index.ts`) calls this — it is
//       the canonical writer. After the boundary writes
//       `req.requestId`, every downstream reader MUST go
//       through (b).
//
//   (b) `getRequestId(req)` — the CANONICAL READER. Returns
//       the boundary-stored `req.requestId` if present (the
//       common case); if for some reason the boundary did not
//       run (e.g., a test app that mounts a route directly),
//       falls back to `resolveRequestId(req)` so the value is
//       still sanitized.
//
// Every downstream sink — route handlers, the 404 fallback,
// the global error middleware — MUST consume (b). Re-sanitizing
// the raw header downstream would generate a fresh UUID on
// invalid inputs and break the end-to-end correlation invariant
// (response header vs error envelope vs log line).
//
// The allow-list covers SoundHub's UUID/ULID shape plus common
// separator characters used by upstream tracing systems
// (`.`, `_`, `-`). Anything outside the allow-list, plus
// empty / over-length / non-string / array-valued values,
// falls back to `generateRequestId()`. CR/LF/NUL are not
// reachable via `setHeader` on the wire (Node throws
// `ERR_INVALID_CHAR`) but the function-level belt still
// rejects them so a future transport that loosens that
// restriction cannot bypass the sanitization.
import type { Request } from "express";
import { generateRequestId } from "./errors.js";

export const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const SAFE_REQUEST_ID_MAX_LENGTH = 128;

/**
 * Express `Request` augmented with the canonical correlation-id
 * slot set by the application-boundary middleware. Module-local
 * so the boundary writer and every downstream reader see the
 * same shape.
 */
export type RequestWithRequestId = Request & { requestId?: string };

/**
 * Sanitize the untrusted `x-request-id` header. ALWAYS returns
 * a value in `[A-Za-z0-9._-]{1,128}`. The boundary middleware
 * is the canonical writer; do NOT call this from a downstream
 * reader (use `getRequestId(req)` instead — re-sanitizing the
 * raw header would generate a fresh UUID on invalid inputs).
 */
export function resolveRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming !== "string") {
    return generateRequestId();
  }
  if (incoming.length === 0 || incoming.length > SAFE_REQUEST_ID_MAX_LENGTH) {
    return generateRequestId();
  }
  if (!SAFE_REQUEST_ID_PATTERN.test(incoming)) {
    return generateRequestId();
  }
  return incoming;
}

/**
 * Canonical reader for the boundary-stored correlation id.
 * Returns the stored value if the boundary middleware has run
 * (the common case); otherwise resolves a fresh sanitized id,
 * MEMOIZES it on `req.requestId`, and returns it.
 *
 * Memoization matters: a directly mounted router (e.g., a
 * route-only test application where the boundary middleware
 * has not run) can call `getRequestId` from multiple sinks —
 * e.g., a body parser and a handler — and without memoization
 * each call would generate a fresh UUID, recreating the
 * correlation divergence the canonical reader is supposed to
 * prevent. Storing the fallback on `req.requestId` makes
 * subsequent calls return the SAME id.
 *
 * Downstream sinks MUST consume this — never `resolveRequestId`
 * — to preserve the end-to-end correlation invariant.
 */
export function getRequestId(req: RequestWithRequestId): string {
  if (req.requestId !== undefined) {
    return req.requestId;
  }
  const generated = resolveRequestId(req);
  req.requestId = generated;
  return generated;
}

/**
 * Canonical writer used by the application-boundary middleware
 * to store the sanitized id on the request. Stores the value
 * and returns it (callers can use the return value directly).
 */
export function storeRequestId(req: RequestWithRequestId): string {
  const requestId = resolveRequestId(req);
  req.requestId = requestId;
  return requestId;
}
