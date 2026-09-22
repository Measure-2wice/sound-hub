// Same-origin return-path shape validator.
//
// Background: the browser may carry a `?return=<path>` query
// parameter through onboarding flows (intent selection, Workspace
// switching, just-in-time authority setup). The browser needs to
// pre-filter the value so a user does not submit a junk string
// that the server would silently drop. The SERVER is the
// authoritative validator (`isValidReturnPath` in
// `apps/api/src/lib/return-context.ts`); this client helper
// pre-filters obvious bypass attempts so the round trip is
// predictable.
//
// Mirrored rules (defense in depth — the server is authoritative):
//
//   1. Length: 1–256 characters.
//   2. Must start with a single `/` (not `//`, not `/\`, not `\`).
//   3. No backslash anywhere.
//   4. No `..` segments.
//   5. No `://` protocol separator.
//   6. No whitespace / control characters.
//   7. No `/api/` (action endpoints).
//   8. No protocol-relative (`//host/path`) prefix.

const MAX_RETURN_PATH_LENGTH = 256;

/**
 * Lightweight client-side pre-filter for `?return=` values. Returns
 * the input unchanged when it is a safe same-origin path shape;
 * returns `false` for anything that would be dropped server-side.
 *
 * The SERVER's `isValidReturnPath` (with the configured
 * `allowedOrigin`) is the final authority; this helper exists so
 * the browser does not round-trip a value that would obviously be
 * rejected.
 */
export function isLocallyValidReturnPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH) return false;
  // Must start with a single "/" (not "//", not "/\", not "\").
  if (!value.startsWith("/")) return false;
  if (value.length >= 2 && (value[1] === "/" || value[1] === "\\")) return false;
  // No backslash anywhere.
  if (value.includes("\\")) return false;
  // No path traversal segments.
  if (value.includes("..")) return false;
  // No protocol separator.
  if (value.includes("://")) return false;
  // No whitespace / control characters.
  for (const ch of value) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return false;
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  // Reject action endpoints — the post-command destination
  // resolver rejects them too.
  if (value.startsWith("/api/")) return false;
  return true;
}
