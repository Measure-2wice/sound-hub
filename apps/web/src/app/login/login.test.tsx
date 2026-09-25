/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/unbound-method */
// Several test seams intentionally use async stubs that resolve
// without awaiting (`async () => value`) so the typed contract
// matches the real `verifyAndRefresh` / `requestMagicLink`
// signatures without forcing the stub to perform an async dance.
// `act(async () => ...)` is also called in places where the
// callback has no internal await — the `act` wrapper itself is the
// required async context, and removing the `async` keyword would
// skip React's commit phase. The native input setter is read via
// `Object.getPrototypeOf(...)` to bypass React's controlled-input
// value tracking; the result is typed as `HTMLInputElement`'s
// prototype at the call site. `submitCalls.push(input)` captures
// the stub's argument by reference (the input object identity is
// the assertion target, not its inner fields), so the `any`
// assignment is bounded to a test-local capture array.
// Login page dev-verification navigation regression (M2 #82 Tenki
// remediation, Codex re-review).
//
// Background: Tenki rated the previous `handleDevVerification`
// implementation as Medium because the handler hard-coded
// `router.push("/dashboard")` after `verifyAndRefresh` resolved,
// ignoring two pieces of authoritative server output:
//
//   1. `response.user.setupState === "recovery"` — the convergence
//      service classified the user as recovery-bound (multiple
//      Owner Personal Workspaces, NULL pointer, etc.). The
//      dashboard renders a recovery surface when `?recovery=1` is
//      present, so the route must carry that flag.
//
//   2. `response.returnTo` — the validated internal return
//      destination the magic-link route set via the return-context
//      cookie. The MagicLinkVerifier (callback page) already honors
//      `response.returnTo`; the dev-verification handler must do
//      the same so the two paths converge on identical navigation
//      rules.
//
// Source-level regex tests were not enough: a regression that
// executes the correct recovery push and then an unconditional
// `/dashboard` push would still pass a "source contains the right
// branch" assertion. These tests mount the real React component
// via JSDOM, drive the dev-verification click, capture the full
// `router.push` call array, and assert it exactly — so an
// accidental second unconditional navigation fails the suite
// immediately.
//
// What these tests pin:
//
//   - The converged navigation contract (recovery overrides
//     non-null `returnTo`, validated `returnTo` navigates to the
//     destination, null `returnTo` falls back to `/dashboard`).
//   - The single-navigation invariant: the dev-verification
//     handler issues exactly ONE `router.push(...)` per
//     successful verification — never two.
//   - The failed-verification invariant: a thrown
//     `verifyAndRefresh` does not navigate at all and renders the
//     in-page error surface.
//   - The no-token invariant: a missing `verificationToken` in the
//     dev verification URL renders the in-page error and never
//     calls `verifyAndRefresh`.
//   - The no-url invariant: a null `devVerificationUrl` (the
//     default state before a submit) renders nothing and never
//     calls `verifyAndRefresh`.
//
// `navigateAfterVerify` is the shared helper that pins the
// recovery-vs-returnTo precedence at one call site for both this
// page and the MagicLinkVerifier. The unit tests against that
// helper pin the precedence in isolation; the JSDOM tests pin the
// end-to-end behaviour (handler → helper → `router.push`).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Bg1VerifyTokenRequestV1, Bg1VerifyTokenResponseV1 } from "@soundhub/types";
import {
  LoginPageContent,
  type LoginMagicLinkClient,
  type LoginRouter,
  type LoginSession,
} from "./page-content";
import { navigateAfterVerify } from "./navigate-after-verify";

// ---------- Shared fixtures ----------

function buildConvergedUser(): Bg1VerifyTokenResponseV1["user"] {
  return {
    userAccountId: "user-converged-1",
    email: "demo.buyer@soundhub.test",
    displayName: "BG1 Demo Buyer",
    identityProvider: "deterministic",
    workspaces: [
      {
        workspaceId: "ws-buyer-1",
        slug: "bg1-demo-buyer",
        name: "BG1 Demo Buyer",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        capabilities: ["Buyer"],
      },
    ],
    setupState: "converged",
  };
}

function buildRecoveryUser(): Bg1VerifyTokenResponseV1["user"] {
  return {
    userAccountId: "user-recovery-1",
    email: "demo.buyer@soundhub.test",
    displayName: "BG1 Demo Buyer",
    identityProvider: "deterministic",
    workspaces: [
      {
        workspaceId: "ws-buyer-1",
        slug: "bg1-demo-buyer",
        name: "BG1 Demo Buyer",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        capabilities: ["Buyer"],
      },
      {
        workspaceId: "ws-buyer-2",
        slug: "bg1-demo-buyer-2",
        name: "BG1 Demo Buyer 2",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        capabilities: ["Buyer"],
      },
    ],
    setupState: "recovery",
  };
}

function buildVerifyResponse(override: {
  user?: Bg1VerifyTokenResponseV1["user"];
  returnTo?: string | null;
}): Bg1VerifyTokenResponseV1 {
  return {
    ok: true,
    user: override.user ?? buildConvergedUser(),
    returnTo: override.returnTo === undefined ? null : override.returnTo,
  };
}

// ---------- JSDOM/React mount harness ----------

interface MountHarness {
  readonly pushCalls: string[];
  readonly replaceCalls: string[];
  readonly verifyCalls: Bg1VerifyTokenRequestV1[];
  readonly submitCalls: { email: string; return?: string }[];
  readonly root: Root;
  readonly router: LoginRouter;
  cleanup(): void;
}

interface MountOptions {
  readonly setupState: "converged" | "recovery";
  readonly returnTo: string | null;
  readonly verifyAndRefresh?: (input: Bg1VerifyTokenRequestV1) => Promise<Bg1VerifyTokenResponseV1>;
  /**
   * The dev verification URL the submit handler should set. The
   * page only renders the dev-verification button after a
   * successful submit (`status === "sent"`), so the test exercises
   * the same production path: drive the form submit with a
   * controlled `requestMagicLink`, observe the button render, then
   * click it. Defaults to a synthetic URL with `?token=token-stub-1`.
   */
  readonly devVerificationUrl?: string;
  /**
   * If set, the controlled `requestMagicLink` rejects with this
   * Error. Used by the submit-failure test.
   */
  readonly submitError?: Error;
}

function mountLoginPage(options: MountOptions): MountHarness {
  const pushCalls: string[] = [];
  const replaceCalls: string[] = [];
  const verifyCalls: Bg1VerifyTokenRequestV1[] = [];
  const submitCalls: { email: string; return?: string }[] = [];
  const router: LoginRouter = {
    push: (href) => {
      pushCalls.push(href);
    },
    replace: (href) => {
      replaceCalls.push(href);
    },
  };
  const verifyAndRefresh =
    options.verifyAndRefresh ??
    (async (input: Bg1VerifyTokenRequestV1) => {
      verifyCalls.push(input);
      return buildVerifyResponse({
        user: options.setupState === "recovery" ? buildRecoveryUser() : buildConvergedUser(),
        returnTo: options.returnTo,
      });
    });
  const session: LoginSession = { verifyAndRefresh };
  const devVerificationUrl =
    options.devVerificationUrl ?? "http://localhost:3000/auth/verify?token=token-stub-1";
  const magicLinkClient: LoginMagicLinkClient = {
    requestMagicLink: async (input) => {
      submitCalls.push(input);
      if (options.submitError) {
        throw options.submitError;
      }
      return { devVerificationUrl };
    },
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(LoginPageContent, {
        router,
        session,
        magicLinkClient,
        returnTo: null,
      }),
    );
  });

  return {
    pushCalls,
    replaceCalls,
    verifyCalls,
    submitCalls,
    root,
    router,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Drive the form submit (controlled `requestMagicLink` resolves
 * with the test's `devVerificationUrl`), then click the now-
 * rendered dev-verification button. Returns the captured
 * `router.push` calls. Mirrors the production flow: the user
 * submits the email, the deterministic adapter returns a dev
 * verification URL, the user clicks the dev-verification button.
 */
async function submitThenClickDevVerify(): Promise<void> {
  const emailInput = document.querySelector('[data-testid="login-email"]');
  assert.ok(
    emailInput instanceof window.HTMLInputElement,
    "the email input must render on first paint",
  );
  await act(async () => {
    // Set the value via the native setter so React's onChange
    // handler observes the change. Without this React keeps the
    // initial empty string.
    const proto = Object.getPrototypeOf(emailInput);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(emailInput, "demo.buyer@soundhub.test");
    emailInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const submitButton = document.querySelector('[data-testid="login-submit"]');
  assert.ok(
    submitButton instanceof window.HTMLButtonElement,
    "the submit button must render on first paint",
  );
  await act(async () => {
    submitButton.click();
    // Allow the async submit + the dev-verification handler to
    // resolve before the next assertion. The submit handler
    // awaits `requestMagicLink`; the dev-verification handler
    // awaits `verifyAndRefresh` then calls `navigateAfterVerify`.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  const devButton = document.querySelector('[data-testid="login-dev-verify"]');
  assert.ok(
    devButton instanceof window.HTMLButtonElement,
    "the dev-verification button must render after a successful submit",
  );
  await act(async () => {
    devButton.click();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

let mounted: MountHarness | null = null;

beforeEach(() => {
  // Each test starts from a clean DOM body so the previous mount
  // does not leak buttons across cases.
  document.body.innerHTML = "";
});

afterEach(() => {
  if (mounted) {
    mounted.cleanup();
    mounted = null;
  }
});

// ---------- Behavioural coverage ----------

describe("login page dev-verification handler — converged navigation contract (M2 #82 Tenki remediation, Codex re-review)", () => {
  test("recovery + non-null returnTo → exactly [router.push('/dashboard?recovery=1')], no /dashboard fallback push", async () => {
    // The Tenki Medium finding: recovery-bound sign-ins must land
    // on the dashboard's recovery surface. A regression that
    // executes the recovery push AND then an unconditional
    // /dashboard push would still pass a "source contains the
    // recovery branch" assertion — this test asserts the FULL
    // push-call array, so the second push fails the suite.
    mounted = mountLoginPage({
      setupState: "recovery",
      returnTo: "/buyer/bg1-demo-buyer/matchmaker",
    });
    await submitThenClickDevVerify();

    assert.deepEqual(
      mounted.pushCalls,
      ["/dashboard?recovery=1"],
      "the recovery push must be the SOLE navigation — a second unconditional push (the original Tenki bug) would fail here",
    );
    assert.deepEqual(
      mounted.replaceCalls,
      [],
      "the dev-verification path must not call router.replace; only router.push",
    );
    assert.equal(
      mounted.submitCalls.length,
      1,
      "requestMagicLink must be called exactly once per form submit",
    );
    assert.equal(
      mounted.verifyCalls.length,
      1,
      "verifyAndRefresh must be called exactly once per dev-verification click",
    );
    assert.equal(
      mounted.verifyCalls[0]?.verificationToken,
      "token-stub-1",
      "the verification credential must round-trip from the dev verification URL's ?token= parameter",
    );
  });

  test("converged + non-null returnTo → exactly [router.push(returnTo)]", async () => {
    mounted = mountLoginPage({
      setupState: "converged",
      returnTo: "/buyer/bg1-demo-buyer/matchmaker",
    });
    await submitThenClickDevVerify();

    assert.deepEqual(
      mounted.pushCalls,
      ["/buyer/bg1-demo-buyer/matchmaker"],
      "converged + non-null returnTo must navigate exactly to the validated destination — no recovery push, no dashboard push",
    );
    assert.deepEqual(mounted.replaceCalls, []);
  });

  test("converged + null returnTo → exactly [router.push('/dashboard')]", async () => {
    mounted = mountLoginPage({
      setupState: "converged",
      returnTo: null,
    });
    await submitThenClickDevVerify();

    assert.deepEqual(
      mounted.pushCalls,
      ["/dashboard"],
      "converged + null returnTo must navigate exactly to the canonical dashboard — no returnTo push, no recovery push",
    );
    assert.deepEqual(mounted.replaceCalls, []);
  });

  test("verification failure → no navigation, in-page error surface is rendered", async () => {
    // The handler's catch branch must surface an in-page error
    // and MUST NOT navigate — a failed verification cannot sign
    // the user in. The behavioural assertion is the empty
    // pushCalls array (a regression that pushes /dashboard on
    // failure would fail here) plus the rendered error Alert.
    mounted = mountLoginPage({
      setupState: "converged",
      returnTo: null,
      verifyAndRefresh: async () => {
        throw new Error("Magic link is invalid, expired, or already used.");
      },
    });
    await submitThenClickDevVerify();

    assert.deepEqual(
      mounted.pushCalls,
      [],
      "a failed verification must NOT navigate — pushing /dashboard would silently sign the user in",
    );
    assert.deepEqual(mounted.replaceCalls, []);
    const error = document.querySelector('[data-testid="login-error"]');
    assert.ok(
      error,
      "the in-page error Alert must render with its login-error testid after a failed verification",
    );
    assert.match(
      error?.textContent ?? "",
      /Magic link is invalid, expired, or already used\./,
      "the in-page Alert must carry the structured error message from verifyAndRefresh",
    );
  });

  test("missing ?token= in the dev verification URL → no verify call, in-page error, no navigation", async () => {
    mounted = mountLoginPage({
      setupState: "converged",
      returnTo: null,
      devVerificationUrl: "http://localhost:3000/auth/verify",
    });
    await submitThenClickDevVerify();

    assert.deepEqual(mounted.pushCalls, []);
    assert.deepEqual(mounted.replaceCalls, []);
    assert.equal(
      mounted.verifyCalls.length,
      0,
      "verifyAndRefresh must NOT be called when the dev verification URL has no ?token= parameter",
    );
    const error = document.querySelector('[data-testid="login-error"]');
    assert.ok(
      error,
      "the in-page error Alert must render when the dev verification URL is missing the verification token",
    );
  });

  test("before any submit, the dev-verification button does not render", async () => {
    // The button only appears once `status === "sent"`. Before
    // a successful submit, no URL is set and no button renders —
    // clicking is impossible, so no verify call can fire. This
    // pins the empty state so a regression that renders the
    // button before the user submits fails this assertion.
    mounted = mountLoginPage({
      setupState: "converged",
      returnTo: null,
    });
    const button = document.querySelector('[data-testid="login-dev-verify"]');
    assert.equal(
      button,
      null,
      "the dev-verification button must NOT render before a successful submit",
    );
  });
});

// ---------- Shared helper coverage ----------

describe("navigateAfterVerify — shared navigation contract (M2 #82 Tenki remediation)", () => {
  test("recovery + non-null returnTo → '/dashboard?recovery=1' (recovery overrides)", () => {
    const router = createRecordingRouter();
    navigateAfterVerify({
      router,
      response: buildVerifyResponse({
        user: buildRecoveryUser(),
        returnTo: "/buyer/bg1-demo-buyer/matchmaker",
      }),
    });
    assert.deepEqual(router.pushCalls, ["/dashboard?recovery=1"]);
    assert.deepEqual(router.replaceCalls, []);
  });

  test("converged + non-null returnTo → response.returnTo destination", () => {
    const router = createRecordingRouter();
    navigateAfterVerify({
      router,
      response: buildVerifyResponse({
        user: buildConvergedUser(),
        returnTo: "/buyer/bg1-demo-buyer/matchmaker",
      }),
    });
    assert.deepEqual(router.pushCalls, ["/buyer/bg1-demo-buyer/matchmaker"]);
    assert.deepEqual(router.replaceCalls, []);
  });

  test("converged + null returnTo → '/dashboard' fallback", () => {
    const router = createRecordingRouter();
    navigateAfterVerify({
      router,
      response: buildVerifyResponse({
        user: buildConvergedUser(),
        returnTo: null,
      }),
    });
    assert.deepEqual(router.pushCalls, ["/dashboard"]);
    assert.deepEqual(router.replaceCalls, []);
  });

  test("method: 'replace' calls router.replace (used by MagicLinkVerifier so the verification surface does not stay in history)", () => {
    const router = createRecordingRouter();
    navigateAfterVerify({
      router,
      response: buildVerifyResponse({
        user: buildConvergedUser(),
        returnTo: "/buyer/bg1-demo-buyer/matchmaker",
      }),
      method: "replace",
    });
    assert.deepEqual(router.pushCalls, []);
    assert.deepEqual(router.replaceCalls, ["/buyer/bg1-demo-buyer/matchmaker"]);
  });

  test("the helper issues exactly ONE navigation per call — no unconditional second push", () => {
    // The original Tenki Medium bug was a router.push("/dashboard")
    // after the conditional branches. The helper now lives in one
    // place and emits exactly one router call — if a future change
    // re-introduces an unconditional second push, this assertion
    // fails.
    const router = createRecordingRouter();
    navigateAfterVerify({
      router,
      response: buildVerifyResponse({
        user: buildRecoveryUser(),
        returnTo: "/buyer/bg1-demo-buyer/matchmaker",
      }),
    });
    const totalCalls = router.pushCalls.length + router.replaceCalls.length;
    assert.equal(totalCalls, 1, "navigateAfterVerify must emit exactly ONE navigation per call");
  });
});

function createRecordingRouter(): LoginRouter & {
  pushCalls: string[];
  replaceCalls: string[];
} {
  const pushCalls: string[] = [];
  const replaceCalls: string[] = [];
  return {
    pushCalls,
    replaceCalls,
    push: (href: string) => {
      pushCalls.push(href);
    },
    replace: (href: string) => {
      replaceCalls.push(href);
    },
  };
}
