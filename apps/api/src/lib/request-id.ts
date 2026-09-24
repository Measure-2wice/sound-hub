// Shared request-id allow-list (M2 #83 CodeQL hardening).
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
//      `apps/api/src/routes/intent.ts:278`). Same hazard.
//   3. `buildSafeError(...)` -> JSON response body and
//      `res.setHeader("x-request-id", ...)`. JSON.stringify
//      escapes `<>"`, but log/header hygiene for control bytes
//      is still desirable.
//
// Both the global middleware and the route-local sanitize
// function now consume THIS helper as the single source of
// truth. The allow-list is the second line of defense (the
// route-local `console.error` already uses a constant format
// string with the requestId as a substitution arg, but the
// global middleware previously did not).
//
// The allow-list covers SoundHub's UUID/ULID shape plus common
// separator characters used by upstream tracing systems
// (`.`, `_`, `-`). Anything outside the allow-list, plus
// empty / over-length / non-string / array-valued values,
// falls back to `generateRequestId()` — the same UUID the
// route produces when the header is absent. CR/LF/NUL are
// not reachable via `setHeader` on the wire (Node throws
// `ERR_INVALID_CHAR`) but the function-level belt still
// rejects them so a future transport that loosens that
// restriction cannot bypass the sanitization.
import type { Request } from "express";
import { generateRequestId } from "./errors.js";

export const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const SAFE_REQUEST_ID_MAX_LENGTH = 128;

/**
 * Resolve a safe correlation id from the untrusted
 * `x-request-id` header. Always returns a value in
 * `[A-Za-z0-9._-]{1,128}` — either the original header (when
 * it already conforms) or a freshly generated UUID.
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
