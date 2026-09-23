/* eslint-disable @typescript-eslint/no-floating-promises */
// Workspace-switch page source-pattern tests (M2 #83 P1-003).
//
// Background: the cross-Workspace continuation finding on
// `/workspace/switch` requires the browser to round-trip the
// validated `?return=` value through:
//   1. the server-side resolver, which URL-encodes the original
//      `returnTo` into the switch path so the post-switch server
//      can re-resolve it under the new actor
//   2. the switch page itself, which reads `?return=` from the
//      URL and forwards it into `commitPendingTarget(...)` on
//      "Switch and continue" so the SERVER resolves the
//      continuation against the FRESH post-commit user
// and, critically, requires Cancel to ignore `?return=`
// entirely so a customer who opts out of the switch is NOT
// silently dropped onto a cross-Workspace destination they are
// no longer acting as. The source-pattern tests pin both
// halves of the round-trip so a regression on either side
// fails the suite before reaching the runtime layer.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const REPO_ROOT = `${new URL("../../../../../../", import.meta.url).pathname}`;
const SWITCH_PAGE_SOURCE = readFileSync(
  `${REPO_ROOT}/apps/web/src/app/workspace/switch/page.tsx`,
  "utf8",
);
const POST_COMMAND_RESOLVER_SOURCE = readFileSync(
  `${REPO_ROOT}/apps/api/src/lib/post-command-return-destination.ts`,
  "utf8",
);

describe("workspace/switch page — server-side resolver preserves the cross-Workspace continuation (P1-003)", () => {
  test("the server-side resolver URL-encodes the original returnTo into the switch path", () => {
    // The server-side resolver MUST emit the switch path with
    // a `&return=<encodeURIComponent(input.returnTo)>` segment
    // so the switch page can read the continuation back from the
    // URL's `?return=` parameter and forward it to the
    // post-switch acting-workspace commit.
    assert.match(
      POST_COMMAND_RESOLVER_SOURCE,
      /encodeURIComponent\(input\.returnTo\)/,
      "the resolver MUST URL-encode the original returnTo into the switch path",
    );
  });

  test("the switch page reads ?return= via useSearchParams and validates via isLocallyValidReturnPath", () => {
    // The switch page MUST consult the URL `?return=` value
    // (verbatim, post-URLSearchParams auto-decode) and gate it
    // through the same locally-valid shape the rest of the
    // client uses.
    assert.match(
      SWITCH_PAGE_SOURCE,
      /searchParams\.get\(\s*["']return["']\s*\)/,
      "the switch page MUST read the ?return= URL parameter",
    );
    assert.match(
      SWITCH_PAGE_SOURCE,
      /isLocallyValidReturnPath\(\s*raw\s*\)/,
      "the switch page MUST validate the captured ?return= via isLocallyValidReturnPath",
    );
  });

  test("the switch page forwards the validated returnTo into commitPendingTarget on Switch and continue", () => {
    // The Switch and continue handler MUST forward the
    // captured ?return= into commitPendingTarget(...) so the
    // server resolver can re-resolve the continuation against
    // the FRESH post-commit acting Workspace context.
    const handlerMatch = SWITCH_PAGE_SOURCE.match(
      /const\s+handleSwitch\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?\n\s*\};/,
    );
    assert.ok(handlerMatch, "expected a handleSwitch handler body");
    const body = handlerMatch[0];
    assert.match(
      body,
      /commitPendingTarget\(\s*queryReturnTo\s*\)/,
      "handleSwitch MUST call commitPendingTarget(queryReturnTo) so the server can re-resolve the continuation",
    );
    // The handler MUST consume ONLY the server-returned
    // safeReturnTo from the commit — never the raw `?return=`
    // value. The raw value is the input to the resolver; the
    // resolved value is the only authoritative destination.
    assert.match(
      body,
      /await\s+commitPendingTarget/,
      "handleSwitch MUST await commitPendingTarget so it can consume the server-resolved safeReturnTo",
    );
    assert.match(
      body,
      /toTypedSwitchRoute\(\s*safeReturnTo\s*\)/,
      "handleSwitch MUST narrow the server-returned safeReturnTo through toTypedSwitchRoute before navigating",
    );
  });
});

describe("workspace/switch page — Cancel ignores ?return= (P1-003)", () => {
  // Cancel does not consume the cross-Workspace continuation.
  // The customer opted out of the switch — they MUST land on
  // a safe current-Workspace surface, never on a destination
  // owned by a Workspace they have explicitly NOT chosen to
  // act as. Cancel's job is to clear pending and stay where
  // the user already is logically.
  test("handleCancel does not consume queryReturnTo and does NOT navigate to a cross-Workspace destination", () => {
    const handlerMatch = SWITCH_PAGE_SOURCE.match(
      /const\s+handleCancel\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?\n\s*\};/,
    );
    assert.ok(handlerMatch, "expected a handleCancel handler body");
    const body = handlerMatch[0];
    // handleCancel MUST call cancelPendingTarget (the
    // in-memory-only state change).
    assert.match(
      body,
      /cancelPendingTarget\(\s*\)/,
      "handleCancel MUST clear the pending target so it does not leak past the cancel",
    );
    // handleCancel MUST navigate to a safe current-Workspace
    // surface. The accepted landing for Cancel is /dashboard.
    assert.match(
      body,
      /router\.replace\(\s*["']\/dashboard["']\s*\)/,
      "handleCancel MUST navigate to /dashboard (the safe current-Workspace surface)",
    );
    // handleCancel MUST NOT reference queryReturnTo at all —
    // the cross-Workspace continuation is a post-commit
    // concern, not a Cancel concern. Forwarding it would land
    // the customer on a destination owned by a Workspace they
    // have not chosen to act as.
    assert.equal(
      /queryReturnTo/.test(body),
      false,
      "handleCancel MUST NOT touch queryReturnTo — Cancel ignores the cross-Workspace continuation entirely",
    );
    // handleCancel MUST NOT reference safeReturnTo / the
    // server-resolved destination. The server-resolved path is
    // produced only by a successful acting-workspace commit,
    // which Cancel explicitly skips.
    assert.equal(
      /safeReturnTo|toTypedSwitchRoute/.test(body),
      false,
      "handleCancel MUST NOT consult the server-resolved safeReturnTo — Cancel does not change the acting Workspace",
    );
  });

  test("handleCancel does not issue a commitPendingTarget call (the only consumer of safeReturnTo)", () => {
    const handlerMatch = SWITCH_PAGE_SOURCE.match(
      /const\s+handleCancel\s*=\s*\(\s*\)\s*=>\s*\{[\s\S]*?\n\s*\};/,
    );
    assert.ok(handlerMatch, "expected a handleCancel handler body");
    assert.equal(
      /commitPendingTarget/.test(handlerMatch[0]),
      false,
      "handleCancel MUST NOT call commitPendingTarget — Cancel never commits a Workspace switch",
    );
  });
});
