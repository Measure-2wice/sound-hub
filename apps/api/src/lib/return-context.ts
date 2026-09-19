// Validated return-context foundation (M2 #82).
//
// Background: the magic-link authentication flow may preserve a
// validated internal navigation destination. The destination is
// passed through a short-lived HttpOnly cookie from `/api/auth/magic-
// link` to `/api/auth/verify-token`, then surfaced to the browser as
// the `returnTo` field on the verify-token response. The destination is
// UI convenience only and never grants membership, Buyer/Seller
// capability, `DealApprover`, or acting-Workspace authority — every
// scoped request revalidates authority at the destination page.
//
// Validation rules (defense in depth):
//
//   1. Length: 1–256 characters (rejects empty and oversized values).
//   2. Control characters and whitespace are rejected in the raw
//      input and in every iteratively-decoded form.
//   3. Iterative percent-decoding (up to 3 levels) catches encoded
//      bypass attempts such as %2F%2Fevil.com, %252F%252Fevil.com,
//      %5C%5Cevil.com, %2e%2e/etc/passwd.
//   4. Structural checks on the decoded path: must start with a single
//      "/" (not "//", not "/\", not "\"); no backslash anywhere; no
//      ".." segments; no "://" protocol separator.
//   5. Canonical URL parsing against the configured application origin
//      is the FINAL authority: same-origin check, http/https protocol,
//      pathname starts with "/". The configured origin is normalized
//      via `new URL(origin).origin` so harmless formatting (trailing
//      slash, default ports, etc.) cannot invalidate every return
//      destination.
//
// Recovery overrides return context: when the convergence service
// returns a recovery state, the auth route clears the cookie and sets
// `returnTo` to `null` in the verify-token response. The browser
// navigates to `/dashboard?recovery=1` regardless of the cookie.

import type { Response } from "express";

export const RETURN_CONTEXT_COOKIE = "soundhub_return_context";
export const RETURN_CONTEXT_MAX_AGE_SECONDS = 1800;

/**
 * Resolve and normalize the configured allowed origin. Accepts either
 * a full URL ("https://soundhub.app") or a bare origin
 * ("https://soundhub.app"). Throws on invalid input so a
 * misconfiguration fails closed at composition time rather than
 * silently invalidating every return destination.
 */
export function resolveAllowedOrigin(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("resolveAllowedOrigin: empty origin");
  }
  // WHATWG URL accepts both "https://host" and "https://host/" and
  // normalizes them to the same `.origin`.
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`resolveAllowedOrigin: origin must use http(s) (got ${parsed.protocol})`);
  }
  return parsed.origin;
}

/**
 * Validate that a candidate return path is exactly a same-origin,
 * http(s) application path. Combines structural checks with canonical
 * URL parsing. Returns false for any bypass attempt; never throws so
 * it is safe to use on every request.
 */
export function isValidReturnPath(path: unknown, allowedOrigin: string): boolean {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > 256) return false;

  // Reject control characters and whitespace in the raw input. This
  // catches obvious junk before the iterative decoder runs. Use
  // explicit NUL + control-character + whitespace tests rather than
  // a control-character regex (the linter rejects the latter for
  // safety). Control characters are 0x00–0x1F (excluding whitespace
  // tab/newline/CR which we reject explicitly) and 0x7F (DEL).
  if (containsForbiddenCharacters(path)) return false;

  // Decode percent-encoding iteratively (up to 3 levels) to catch
  // encoded bypass attempts (e.g., %2F%2Fevil.com, %252F%252Fevil.com,
  // %5C%5Cevil.com, %2e%2e/etc/passwd).
  let decoded = path;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return false;
    }
  }

  // Reject control characters and whitespace in any decoded form.
  if (containsForbiddenCharacters(decoded)) return false;

  // Structural checks on the decoded path:
  //   - Must start with a single "/" (not "//", not "/\", not "\").
  if (!decoded.startsWith("/")) return false;
  if (decoded.length >= 2 && (decoded[1] === "/" || decoded[1] === "\\")) return false;
  //   - No backslash anywhere in the path (encoded or decoded).
  if (decoded.includes("\\")) return false;
  //   - No path traversal segments.
  if (decoded.includes("..")) return false;
  //   - No protocol separator.
  if (decoded.includes("://")) return false;

  // Canonical URL parsing against the configured origin is the FINAL
  // authority. Catches anything the regex misses (e.g., encoded host-
  // name tricks, unusual URL schemes that survive `startsWith("/")`).
  // The configured origin is normalized via `new URL(origin).origin`
  // so harmless formatting (trailing slash, default ports) cannot
  // invalidate every return destination.
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(allowedOrigin).origin;
  } catch {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(decoded, normalizedOrigin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.origin !== normalizedOrigin) return false;
  if (!parsed.pathname.startsWith("/")) return false;
  return true;
}

/**
 * Set the return-context cookie on a response. Validates the path
 * first; silently drops the cookie if the path fails validation so the
 * caller never has to handle a partial cookie set. The cookie is
 * `Secure; HttpOnly; SameSite=Lax; Path=/` and bounded by
 * `RETURN_CONTEXT_MAX_AGE_SECONDS`.
 */
export function setReturnContextCookie(
  res: Response,
  path: string,
  allowedOrigin: string,
): boolean {
  if (!isValidReturnPath(path, allowedOrigin)) return false;
  // SameSite=Lax so the cookie survives the magic-link email round-trip
  // when the browser follows the link. HttpOnly so the browser's
  // JavaScript cannot read it; the server reads it on verify-token.
  const parts = [
    `${RETURN_CONTEXT_COOKIE}=${encodeURIComponent(path)}`,
    "Path=/",
    `Max-Age=${RETURN_CONTEXT_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  // Only attach Secure when serving over https so local HTTP
  // development does not silently fail to send the cookie.
  try {
    const origin = new URL(allowedOrigin);
    if (origin.protocol === "https:") parts.push("Secure");
  } catch {
    /* ignore — origin was validated above */
  }
  res.setHeader("Set-Cookie", parts.join("; "));
  return true;
}

/**
 * Clear the return-context cookie. Always succeeds; safe to call on
 * every verify-token response so a recovery or invalid path never
 * persists across sessions. Uses `appendHeader` (not `setHeader`) so
 * the session cookie set on the same response is preserved — the
 * verify-token route issues both a session cookie AND this clear
 * cookie, and Express's `setHeader("Set-Cookie", ...)` would
 * overwrite the first one. This is the single owner of the
 * return-context clearing serialization; the route must call it
 * (rather than hand-build the literal) to avoid duplicating the
 * cookie format.
 */
export function clearReturnContextCookie(res: Response): void {
  res.appendHeader(
    "Set-Cookie",
    `${RETURN_CONTEXT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
}

/**
 * Read and validate the return-context cookie value from a request's
 * raw `Cookie` header. Returns null when absent, malformed, or
 * invalid (per `isValidReturnPath`). The server is the only reader —
 * the cookie is HttpOnly.
 */
export function readReturnContextCookie(
  cookieHeader: string | undefined,
  allowedOrigin: string,
): string | null {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${RETURN_CONTEXT_COOKIE}=`)) continue;
    const raw = trimmed.slice(RETURN_CONTEXT_COOKIE.length + 1);
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!isValidReturnPath(decoded, allowedOrigin)) return null;
    return decoded;
  }
  return null;
}

/**
 * Single forbidden-character predicate shared by the raw-input scan
 * and the post-decode scan in `isValidReturnPath`. Returns true when
 * the value contains a NUL byte, a tab/newline/CR whitespace
 * character, or any 0x00–0x1F / 0x7F control byte. Explicit
 * character checks are used (rather than a control-character regex)
 * because the project's lint policy rejects control-character regex
 * patterns.
 */
function containsForbiddenCharacters(value: string): boolean {
  if (value.includes("\0")) return true;
  for (const ch of value) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return true;
    const code = ch.charCodeAt(0);
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) return true;
  }
  return false;
}
