// Return-context validator unit tests (M2 #82).
//
// Background: the validator is the single source of truth for
// accepting a return destination. It combines structural checks
// with canonical URL parsing against the configured application
// origin. The encoded / normalized bypass matrix below proves that
// every documented bypass attempt is rejected.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isValidReturnPath, resolveAllowedOrigin } from "./return-context.js";

const ALLOWED_ORIGIN = "https://soundhub.app";

const ACCEPTED: readonly string[] = [
  "/dashboard",
  "/matchmaker",
  "/deals/abc123?foo=bar",
  "/dashboard#hash",
  "/",
  "/foo/bar",
  // Legitimate literal-percent path: `/search?q=50%25` carries a
  // single-encoded `%` sign in the query value. The iterative
  // decoder stops at the first stable decode (no further `%HH`
  // remains), so the literal `%` survives and the path passes
  // structural + same-origin checks.
  "/search?q=50%25",
];

const REJECTED: readonly { readonly path: string; readonly reason: string }[] = [
  { path: "https://evil.com", reason: "absolute URL" },
  { path: "http://localhost:9999/x", reason: "absolute URL on different port" },
  { path: "//evil.com", reason: "protocol-relative" },
  { path: "///evil.com", reason: "triple-slash protocol-relative" },
  { path: "/\\evil.com", reason: "slash-backslash authority trick" },
  { path: "\\\\evil.com", reason: "double-backslash" },
  { path: "\\/evil.com", reason: "backslash-slash mixed" },
  { path: "/foo\\bar", reason: "backslash inside path" },
  { path: "javascript:alert(1)", reason: "javascript: protocol" },
  { path: "data:text/html,<script>alert(1)</script>", reason: "data: protocol" },
  { path: "file:///etc/passwd", reason: "file: protocol" },
  { path: "/dashboard/../etc/passwd", reason: "path traversal with .." },
  { path: "/dashboard/..", reason: "path traversal" },
  { path: "/..", reason: "traversal at root" },
  { path: "/foo/../bar", reason: "path traversal in middle" },
  { path: "%2F%2Fevil.com", reason: "encoded //" },
  { path: "%5C%5Cevil.com", reason: "encoded \\\\" },
  { path: "%2e%2e/etc/passwd", reason: "encoded .." },
  { path: "/%2e%2e/etc/passwd", reason: "encoded .. in path" },
  { path: "%252F%252Fevil.com", reason: "double-encoded //" },
  { path: "/%5c%5cevil.com", reason: "encoded backslash in path" },
  { path: "/dashboard%2F..%2Fetc", reason: "encoded slash + encoded .." },
  // Submitted-syntax preflight rejections: malformed percent escapes
  // on the raw input. `decodeURIComponent` throws `URIError` on a
  // bare `%`, a `%` followed by fewer than two characters, or a `%`
  // followed by two non-hex characters. The preflight rejects these
  // before the iterative decoder runs; the iterative decoder alone
  // would let them through because `containsPercentEscape` only
  // matches valid `%HH` and would break the loop before
  // `decodeURIComponent` could throw.
  { path: "/foo%", reason: "bare percent at end" },
  { path: "/foo%2", reason: "percent followed by one hex digit" },
  { path: "/foo%GG", reason: "percent followed by two non-hex chars" },
  { path: "/foo%2G", reason: "percent followed by one hex + one non-hex" },
  // The decoded form `/foo bar` contains a literal space, which is
  // whitespace and is rejected by `containsForbiddenCharacters` on
  // the stable decoded form. The rejection is the literal space,
  // NOT the iterative decoding itself — `decodeURIComponent` runs
  // cleanly on `%20`. This is distinct from the `%25` bug class:
  // here the path is genuinely unsafe (whitespace) and the
  // rejection is the intended outcome.
  { path: "/foo%20bar", reason: "decoded literal space (whitespace rejection)" },
  { path: "", reason: "empty string" },
  { path: "/" + "x".repeat(256), reason: "too long (257 chars)" },
  { path: "/dashboard\n", reason: "newline" },
  { path: "/dashboard\0", reason: "null byte" },
  { path: "/dashboard\r\nfoo", reason: "CRLF" },
  { path: "/dashboard\t", reason: "tab" },
  { path: "dashboard", reason: "no leading slash" },
  { path: "foo/bar", reason: "no leading slash, looks relative" },
  { path: "://evil.com", reason: "no scheme" },
];

describe("resolveAllowedOrigin", () => {
  test("normalizes a bare origin", () => {
    assert.equal(resolveAllowedOrigin("https://soundhub.app"), "https://soundhub.app");
  });

  test("normalizes a trailing-slash origin to the bare origin", () => {
    assert.equal(resolveAllowedOrigin("https://soundhub.app/"), "https://soundhub.app");
  });

  test("rejects non-http(s) origins", () => {
    assert.throws(() => resolveAllowedOrigin("ftp://soundhub.app"), /http\(s\)/);
  });
});

describe("isValidReturnPath", () => {
  test("accepts every documented internal path", () => {
    for (const path of ACCEPTED) {
      assert.equal(
        isValidReturnPath(path, ALLOWED_ORIGIN),
        true,
        `expected ${path} to be accepted`,
      );
    }
  });

  test("accepts a 256-character path (boundary)", () => {
    assert.equal(isValidReturnPath("/" + "x".repeat(255), ALLOWED_ORIGIN), true);
  });

  test("rejects every documented bypass attempt", () => {
    for (const { path, reason } of REJECTED) {
      assert.equal(
        isValidReturnPath(path, ALLOWED_ORIGIN),
        false,
        `expected ${path} (${reason}) to be rejected`,
      );
    }
  });

  test("normalizes the configured origin so harmless formatting does not invalidate every destination", () => {
    // Trailing slash on the allowed origin must not cause every
    // internal destination to be rejected.
    assert.equal(isValidReturnPath("/dashboard", "https://soundhub.app/"), true);
  });

  test("rejects paths whose canonical URL origin is not the configured origin", () => {
    // When the path's canonical URL origin differs from the
    // configured origin, reject. `//evil.com` parses to
    // `https://evil.com/`, which has origin `https://evil.com`,
    // not the configured origin `https://soundhub.app`.
    assert.equal(isValidReturnPath("//evil.com", ALLOWED_ORIGIN), false);
  });

  test("returns false on non-string input", () => {
    // The validator must defend against values that bypass the
    // schema boundary. Each call passes a non-string value
    // through the validator's runtime guard.
    assert.equal(isValidReturnPath(undefined, ALLOWED_ORIGIN), false);
    assert.equal(isValidReturnPath(null, ALLOWED_ORIGIN), false);
    assert.equal(isValidReturnPath(42, ALLOWED_ORIGIN), false);
    assert.equal(isValidReturnPath({}, ALLOWED_ORIGIN), false);
  });
});
