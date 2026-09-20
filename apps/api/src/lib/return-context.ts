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
 *
 * Two-layer percent-encoding defense:
 *
 *   1. Submitted-syntax preflight: the raw submitted path must be
 *      syntactically valid percent encoding. Any malformed `%` (a
 *      bare `%`, a `%` followed by fewer than two hex digits, or a
 *      `%` followed by two non-hex characters) causes
 *      `decodeURIComponent` to throw `URIError`, and the validator
 *      fails closed with `false`. The preflight ONLY validates the
 *      submitted value — its decoded result is intentionally
 *      discarded so the iterative decoder still starts from the
 *      original raw input. This catches `/foo%`, `/foo%2`, `/foo%GG`,
 *      and `/foo%2G` before the iterative loop runs.
 *
 *   2. Iterative percent-decoding (bounded to 3 levels): the loop
 *      only advances another layer when the current string still
 *      contains a syntactically valid `%HH` percent-escape that
 *      decodes to a different string. After every decoded level the
 *      full structural, forbidden-character, and same-origin checks
 *      re-run, so an attacker cannot smuggle a payload by hiding it
 *      behind an extra `%25` layer. The percent-syntax check is
 *      intentionally NOT re-run on later decoded forms: a legitimate
 *      `%25` may decode to a literal `%` which is harmless.
 *
 * Together these preserve the documented defense against encoded
 * bypass attempts (`%2F%2Fevil.com`, `%252F%252Fevil.com`,
 * `%5C%5Cevil.com`, `%2e%2e/etc/passwd`) and reject malformed
 * submitted syntax, without over-decoding legitimate literal percent
 * sequences such as `/search?q=50%25`.
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

  // Normalize the configured origin ONCE so per-iteration revalidation
  // does not re-parse it. A malformed origin is a configuration error
  // and we fail closed (reject every destination).
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(allowedOrigin).origin;
  } catch {
    return false;
  }

  // Submitted-syntax preflight: the raw submitted path must be
  // syntactically valid percent encoding. Any malformed escape (`%`,
  // `%X`, `%GG`, `%2G`) makes `decodeURIComponent` throw `URIError`.
  // The decoded result is intentionally discarded — the iterative
  // decoder below still operates on the original raw input. This
  // preflight is the single owner of submitted-syntax validation;
  // the iterative loop must NOT re-validate percent syntax on later
  // decoded forms because a legitimate `%25` is allowed to decode
  // into a literal `%`.
  try {
    decodeURIComponent(path);
  } catch {
    return false;
  }

  // Iterative decoding. The loop advances one layer only when:
  //   1. the current string still contains a syntactically valid
  //      percent-escape (`%HH`), AND
  //   2. that layer decodes to a different string.
  // After every decoded layer, the full structural + forbidden-
  // character + same-origin revalidation runs so a hidden payload
  // cannot survive a multi-layer decode by being valid only at the
  // final layer.
  let decoded = path;
  for (let i = 0; i < 3; i++) {
    if (!containsPercentEscape(decoded)) break;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return false;
    }
    if (!passesStructuralChecks(decoded, normalizedOrigin)) {
      return false;
    }
  }

  // Final pass on the stable decoded form. The structural checks
  // were already re-applied after every decoded layer, so this is
  // a defense-in-depth re-check for the case where the loop exited
  // without any decode (the raw input was stable from the start).
  if (!passesStructuralChecks(decoded, normalizedOrigin)) {
    return false;
  }
  return true;
}

/**
 * Predicate for "this string still contains a syntactically valid
 * percent-escape that decodes to a non-trivial byte". Used to gate
 * the iterative decoder so a literal `%25` at the end of a legitimate
 * path does not force another decode that would throw `URIError` on
 * a trailing `%`. Anchored against `%` followed by exactly two
 * hex digits so a bare `%` (which `decodeURIComponent` rejects) does
 * not advance the loop.
 *
 * This predicate is intentionally strict: malformed escapes such as
 * `%`, `%2`, `%GG`, or `%2G` never advance the loop. The submitted-
 * syntax preflight in `isValidReturnPath` is the layer that rejects
 * those malformed escapes; this predicate is a loop-boundary guard
 * for subsequent decoded layers where a literal `%` is permitted.
 */
function containsPercentEscape(value: string): boolean {
  return /%[0-9A-Fa-f]{2}/.test(value);
}

/**
 * Single structural + forbidden-character + same-origin revalidation
 * used inside the iterative decoder. Returns true when `value` is a
 * safe same-origin http(s) application path; false otherwise.
 */
function passesStructuralChecks(decoded: string, normalizedOrigin: string): boolean {
  if (containsForbiddenCharacters(decoded)) return false;
  // Must start with a single "/" (not "//", not "/\", not "\").
  if (!decoded.startsWith("/")) return false;
  if (decoded.length >= 2 && (decoded[1] === "/" || decoded[1] === "\\")) return false;
  // No backslash anywhere in the path (encoded or decoded).
  if (decoded.includes("\\")) return false;
  // No path traversal segments.
  if (decoded.includes("..")) return false;
  // No protocol separator.
  if (decoded.includes("://")) return false;
  // Canonical URL parsing against the configured origin is the FINAL
  // authority. Catches anything the structural checks miss (e.g.,
  // encoded hostname tricks, unusual URL schemes that survive
  // `startsWith("/")`).
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
