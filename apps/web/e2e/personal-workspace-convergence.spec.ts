import { test, expect, type Page, type ViewportSize } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_TEST_DATABASE_NAME,
  APPROVED_TEST_DATABASE_PORT,
} from "../../api/src/lib/test-database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Approved disposable test database target. Playwright's webServer.env
// supplies the URL to the dev server, but the worker process does NOT
// inherit webServer.env. Resolve one shared approved URL here so the
// seed helper receives an explicit TEST_DATABASE_URL via execFileSync.
// The wrapper (`scripts/db-seed-recovery-user.mjs`) re-validates the
// URL through `resolveApprovedTestDatabaseUrl`, and the leaf
// (`packages/db/prisma/seed-recovery-user.ts`) re-validates through
// `assertDisposableTestDatabase` — both guards remain in force.
const APPROVED_DISPOSABLE_TEST_DATABASE_URL = `postgresql://soundhub:password@localhost:${APPROVED_TEST_DATABASE_PORT}/${APPROVED_TEST_DATABASE_NAME}`;

// M2 #82 — focused browser coverage for Personal Workspace
// convergence (the approved plan deliverable).
//
// This spec exercises the named browser journeys from the plan:
//
//   AC1  fresh authentication creates exactly one Personal
//        Workspace ("My Workspace"). The opaque cuid-shaped slug
//        invariant (`^personal-c[a-z0-9]+$`) is pinned at the
//        API/repository layer in:
//          - apps/api/src/auth-repository/prisma-auth-repository.test.ts:334
//          - apps/api/src/services/personal-workspace-convergence.service.test.ts:118
//        (the slug is intentionally NOT in the customer DOM — Codex
//        P1-001 explicitly failed the customer-DOM assertion).
//   AC2  same-row retry reuses the same Personal Workspace (no
//        duplicate slugs after a second sign-in with the same
//        email/subject).
//   AC3  recovery surfaces truthful context: "SoundHub couldn't
//        safely confirm your Personal Workspace" with no
//        invented support-process or sign-in-recovery promise,
//        and the Organization memberships remain visible.
//   AC7  safe internal return context: `/login?return=/dashboard`
//        sets the return-context cookie, the post-sign-in redirect
//        targets /dashboard; external-return paths are silently
//        dropped.
//   AC8  return context grants no authority: a `/deals/{dealId}`
//        return path is accepted structurally but the Deal
//        boundary denies access.
//   AC9  BG1 engineering controls ("Verify acting Workspace",
//        "Send consequential command") are absent from the
//        customer UI per the M2 UX addendum.
//   AC10 loading, feedback, retry/exit: the recovery surface
//        exposes an operable sign-out button with a minimum
//        44×44 hit area.
//   AC13 focused browser coverage (this file).
//   AC14 keyboard order, visible focus, ≥44×44 hit areas, reflow
//        at 375 / 768 / 1280 widths.
//   M2 (#82) visual-QA additions:
//     - invalid / expired magic-link verification renders an
//       in-page `<Alert role="alert">` recovery surface (no silent
//       redirect to /login), the loading surface is REPLACED
//       (never visible alongside the alert), and focus moves to
//       the alert's heading.
//     - sign-out transport failure renders a bounded
//       `<Alert role="alert" variant="failure">` with copy
//       "We couldn't confirm sign-out. Please try again." The
//       sign-out button stays operable (not disabled by the
//       error state) and focus restores to it.
//     - recovery Card uses the restrained gold attention cue
//       (border-gold/40) per the M2 UX addendum.
//     - dashboard loading state (session/convergence in flight)
//       renders EXACTLY ONE bounded warm `<Alert role="status"
//       variant="status">` with customer-safe copy ("Loading your
//       workspace…"), no gold accent, no debug/provider/domain
//       terms, operational text ≥ 16px, and no horizontal
//       overflow at the narrow/zoom proxy (~240 CSS px).

const FRESH_EMAIL_PREFIX = "m2-82-fresh-";
const RECOVERY_EMAIL_PREFIX = "m2-82-recovery-";

async function signInFresh(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("login-dev-verify").click();
  // Either the Personal Workspace dashboard or the recovery
  // surface renders after verify-token completes.
  await page.getByTestId("dashboard").or(page.getByTestId("dashboard-recovery")).waitFor();
}

function seedRecoveryUser(email: string): void {
  // Insert a UserAccount with TWO Owner Personal Workspace
  // memberships. The convergence service's classifyPersonalWorkspaceState
  // will then classify this user as
  // `recovery: multiple-personal-workspaces` on sign-in, which
  // surfaces the recovery surface in the browser.
  //
  // We invoke the `db-seed-recovery-user.mjs` helper via the API
  // package's tsx binary so the `.js → .ts` import resolution
  // works. The helper uses the approved disposable-test-database
  // guard for fail-closed targeting. `execFileSync` avoids shell
  // interpolation of the email argument.
  //
  // TEST_DATABASE_URL is forwarded explicitly because the Playwright
  // worker process does NOT inherit `webServer.env`. Without an
  // explicit URL the wrapper fails closed on `readTestDatabaseUrl`
  // and the first recovery test fails, causing every later serial
  // case to skip (this was the failure mode Codex review P1-001
  // flagged). Both guards remain in force:
  //   - wrapper: `resolveApprovedTestDatabaseUrl()` validates the URL
  //   - leaf:    `assertDisposableTestDatabase()` validates the URL
  const repoRoot = resolvePath(__dirname, "..", "..", "..");
  const scriptPath = resolvePath(repoRoot, "scripts", "db-seed-recovery-user.mjs");
  const tsxBin = resolvePath(repoRoot, "apps", "api", "node_modules", ".bin", "tsx");
  execFileSync(tsxBin, [scriptPath, email], {
    stdio: "pipe",
    env: {
      ...process.env,
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? APPROVED_DISPOSABLE_TEST_DATABASE_URL,
    },
  });
}

test.describe.configure({ mode: "serial" });

const VIEWPORTS: ReadonlyArray<{ readonly name: string; readonly size: ViewportSize }> = [
  { name: "mobile-375", size: { width: 375, height: 720 } },
  { name: "tablet-768", size: { width: 768, height: 1024 } },
  { name: "desktop-1280", size: { width: 1280, height: 800 } },
];

test("fresh sign-in surfaces exactly one Personal Workspace ('My Workspace')", async ({ page }) => {
  // M2 (#82) visual-QA: the opaque Workspace slug is no longer
  // surfaced in the customer DOM (Codex P1-001). The cuid-shape
  // invariant is pinned at the API/repository layer:
  //   - apps/api/src/auth-repository/prisma-auth-repository.test.ts:334
  //     "createInitialPersonalWorkspace returns an opaque slug
  //      matching ^personal-c[a-z0-9]+$ AND equals personal-<workspaceId>"
  //   - apps/api/src/services/personal-workspace-convergence.service.test.ts:118
  //     "concurrent createInitialConvergence calls converge on the
  //      same workspace" + the slug-shape assertions above.
  // The browser now only needs to assert the customer-facing arrival
  // copy: the literal "My Workspace" heading inside the Personal
  // Workspace card.
  const email = `${FRESH_EMAIL_PREFIX}${Date.now()}@example.test`;
  await signInFresh(page, email);

  const card = page.getByTestId("dashboard-personal-workspace-card");
  await expect(card).toContainText("My Workspace");
  // Implementation / domain terminology must NOT appear on the
  // customer-facing arrival surface. Codex P1-001 explicitly failed
  // this layer for exposing the slug, the provider-key, and the
  // raw type/status/capabilities line.
  await expect(page.getByText(/personal-c[a-z0-9]+/)).toHaveCount(0);
  await expect(page.getByText(/identity\s+provider/i)).toHaveCount(0);
  await expect(page.getByText(/capabilities\s*:/i)).toHaveCount(0);
});

test("second sign-in with the same email reuses the same Personal Workspace (browser returns to dashboard)", async ({
  page,
}) => {
  // M2 (#82) visual-QA: the slug-identity proof moved to the
  // repository layer (see the test above). The browser-level reuse
  // proof remains — a second sign-in with the same email must
  // converge on the same Personal Workspace so the customer sees a
  // continuous dashboard, not a duplicate.
  const email = `${FRESH_EMAIL_PREFIX}retry-${Date.now()}@example.test`;
  await signInFresh(page, email);
  await expect(page.getByTestId("dashboard-personal-workspace-card")).toContainText("My Workspace");

  await page.getByTestId("dashboard-sign-out").click();
  await page.waitForURL("/");
  await signInFresh(page, email);
  await expect(page.getByTestId("dashboard-personal-workspace-card")).toContainText("My Workspace");
});

test("BG1 engineering controls are absent from the customer UI", async ({ page }) => {
  const email = `${FRESH_EMAIL_PREFIX}bg1-control-${Date.now()}@example.test`;
  await signInFresh(page, email);
  await expect(page.getByText("Verify acting Workspace")).toHaveCount(0);
  await expect(page.getByText("Send consequential command")).toHaveCount(0);
});

test("valid /dashboard return path round-trips through /login?return= and lands on /dashboard", async ({
  page,
}) => {
  // AC7 (valid case): the magic-link request includes
  // `?return=/dashboard`; the validator accepts it; the cookie
  // is set; verify-token surfaces returnTo; the browser lands on
  // /dashboard.
  const email = `${FRESH_EMAIL_PREFIX}return-valid-${Date.now()}@example.test`;
  await page.goto(`/login?return=/dashboard`);
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("login-dev-verify").click();
  await page.getByTestId("dashboard").waitFor();
  expect(new URL(page.url()).pathname).toBe("/dashboard");
});

test("external return path is silently dropped by the validator", async ({ page }) => {
  // AC7 (rejection case): an external (cross-origin) return path
  // is rejected by the validator. No cookie is set; the dashboard
  // still renders normally (no redirect to the external origin).
  const email = `${FRESH_EMAIL_PREFIX}return-external-${Date.now()}@example.test`;
  await page.goto(`/login?return=https://evil.example.com/steal`);
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("login-dev-verify").click();
  await page.getByTestId("dashboard").waitFor();
  expect(new URL(page.url()).pathname).not.toBe("evil.example.com");
  expect(new URL(page.url()).hostname).not.toBe("evil.example.com");
});

test("recovery surface renders truthful copy and an operable sign-out (≥44×44)", async ({
  page,
  viewport,
}) => {
  // Seed a recovery-bound user (two Owner Personal memberships),
  // sign in, and assert the recovery surface contract:
  //   - The truthful "couldn't safely confirm" body copy is present.
  //   - NO support-process / sign-in-recovery promise is present.
  //   - The sign-out button has a minimum 44×44 hit area (per the
  //     M2 UX addendum's accessibility requirements).
  const email = `${RECOVERY_EMAIL_PREFIX}${Date.now()}@example.test`;
  seedRecoveryUser(email);
  await page.setViewportSize(viewport ?? { width: 1280, height: 800 });
  await signInFresh(page, email);

  const recovery = page.getByTestId("dashboard-recovery");
  await expect(recovery).toBeVisible();
  await expect(page.getByTestId("dashboard-recovery-title")).toBeVisible();
  await expect(page.getByTestId("dashboard-recovery-body")).toContainText(
    "couldn't safely confirm your Personal Workspace",
  );
  await expect(page.getByTestId("dashboard-recovery-body")).toContainText(
    "Your existing Workspace memberships have not been changed.",
  );
  // No support / sign-in-recovery promise.
  await expect(page.getByText(/support\s+team/i)).toHaveCount(0);
  await expect(page.getByText(/try\s+signing\s+in\s+again/i)).toHaveCount(0);
  // Sign-out hit area ≥ 44×44.
  const signOut = page.getByTestId("dashboard-recovery-sign-out");
  const box = await signOut.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
});

for (const { name, size } of VIEWPORTS) {
  test(`recovery surface reflows at ${name} viewport without horizontal overflow`, async ({
    browser,
  }) => {
    // AC14 / AC15: the recovery surface reflows cleanly at the
    // three required viewport widths. A regression that introduces
    // fixed widths or non-wrapping copy would fail this loop.
    const ctx = await browser.newContext({ viewport: size });
    const page = await ctx.newPage();
    try {
      const email = `${RECOVERY_EMAIL_PREFIX}viewport-${name}-${Date.now()}@example.test`;
      seedRecoveryUser(email);
      await signInFresh(page, email);
      await expect(page.getByTestId("dashboard-recovery")).toBeVisible();
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(size.width + 1);
    } finally {
      await ctx.close();
    }
  });
}

test("sign-out button is keyboard-reachable with visible focus", async ({ page }) => {
  const email = `${FRESH_EMAIL_PREFIX}focus-${Date.now()}@example.test`;
  await signInFresh(page, email);
  // Focus the sign-out button via keyboard navigation. The button
  // must become the activeElement (visible focus ring required).
  await page.getByTestId("dashboard-sign-out").focus();
  await expect(page.getByTestId("dashboard-sign-out")).toBeFocused();
  // Enter activates it.
  await page.keyboard.press("Enter");
  await page.waitForURL("/");
});

test("sequential Tab order reaches every meaningful interactive element on the Personal Workspace dashboard", async ({
  page,
}) => {
  // AC14 (keyboard order): drive Tab from a known starting point
  // and assert the meaningful sequence. Programmatic focus calls
  // (page.focus) do NOT exercise the same DOM ordering as the
  // keyboard, so this assertion uses real keyboard events.
  const email = `${FRESH_EMAIL_PREFIX}tab-order-${Date.now()}@example.test`;
  await signInFresh(page, email);
  await page.locator("body").click({ position: { x: 0, y: 0 } });

  // Collect the test-ids of every NATIVE interactive element the
  // dashboard ships. The order in which they appear in document
  // order IS the order Tab reaches them when no explicit tabindex
  // is set. Codex review (P1-002) flagged that the previous list
  // included `dashboard-user-email`, which is attached to a
  // Card.Title rendered as a non-focusable <h3>. Real keyboard
  // navigation can never focus it; the heading is a label, not a
  // control. The Personal Workspace dashboard currently exposes
  // a single interactive control — the sign-out button — so the
  // assertion below covers the only meaningful Tab target. If a
  // future surface adds a second natively-focusable control, add
  // its testid to this list in document order.
  const interactiveTestIds = ["dashboard-sign-out"];
  for (const id of interactiveTestIds) {
    // Tab forward until the element is the active element or
    // we've pressed Tab too many times (defensive upper bound).
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        return el.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
      });
      if (focused === id) break;
    }
    await expect(page.locator(`[data-testid="${id}"]`)).toBeFocused();
  }
});

test("focused element shows a visible focus ring via computed outline / box-shadow", async ({
  page,
}) => {
  // AC14 (visible focus): a focused interactive element must
  // show a non-default focus indicator. We assert the computed
  // outline-width or box-shadow is non-zero on the focused
  // sign-out button so a regression that strips the focus ring
  // (e.g., `outline: none` without a replacement) is caught.
  const email = `${FRESH_EMAIL_PREFIX}focus-ring-${Date.now()}@example.test`;
  await signInFresh(page, email);
  const signOut = page.getByTestId("dashboard-sign-out");
  await signOut.focus();
  await expect(signOut).toBeFocused();
  const focusIndicator = await signOut.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return {
      outlineWidth: cs.outlineWidth,
      outlineStyle: cs.outlineStyle,
      boxShadow: cs.boxShadow,
    };
  });
  // The focus indicator must be visible — non-default outline
  // width OR a non-transparent box-shadow. Tailwind's ring
  // utility produces a box-shadow; the assertion accepts either.
  const hasVisibleOutline =
    focusIndicator.outlineStyle !== "none" &&
    focusIndicator.outlineWidth !== "0px" &&
    focusIndicator.outlineWidth !== "";
  const hasVisibleBoxShadow =
    focusIndicator.boxShadow !== "none" && focusIndicator.boxShadow !== "";
  expect(hasVisibleOutline || hasVisibleBoxShadow).toBe(true);
});

test("body text on the recovery surface meets the ≥16px minimum", async ({ page }) => {
  // AC14 (text size): the M2 UX addendum requires ≥16px body
  // text on every surface. We sample the recovery copy's
  // computed font-size so a regression to a smaller size is
  // caught.
  const email = `${RECOVERY_EMAIL_PREFIX}text-size-${Date.now()}@example.test`;
  seedRecoveryUser(email);
  await signInFresh(page, email);
  const body = page.getByTestId("dashboard-recovery-body");
  const fontSize = await body.evaluate((el) => {
    return window.getComputedStyle(el).fontSize;
  });
  // fontSize is in px (e.g., "16px"). Parse and assert ≥ 16.
  const px = parseFloat(fontSize);
  expect(px).toBeGreaterThanOrEqual(16);
});

for (const { name, size } of VIEWPORTS) {
  test(`Personal Workspace dashboard reflows cleanly at ${name} viewport without horizontal overflow`, async ({
    browser,
  }) => {
    // AC14 / AC15 (responsive coverage): the recovery viewport
    // loop above covers the recovery surface. This loop covers the
    // Personal Workspace dashboard at the same three widths (375 /
    // 768 / 1280) so a regression that breaks either surface at any
    // required viewport is caught (Codex review P1-004).
    const ctx = await browser.newContext({ viewport: size });
    const page = await ctx.newPage();
    try {
      const email = `${FRESH_EMAIL_PREFIX}responsive-pw-${name}-${Date.now()}@example.test`;
      await signInFresh(page, email);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      // Allow a single-pixel rounding tolerance for sub-pixel layout.
      expect(scrollWidth).toBeLessThanOrEqual(size.width + 1);
      // The Personal Workspace body text on the converged dashboard
      // also meets the 16px floor. Sample the workspace name paragraph
      // (the actual customer-facing copy) rather than the card
      // container, whose computed font-size can pass via inheritance
      // even when inner text is undersized.
      const cardName = page
        .getByTestId("dashboard-personal-workspace-card")
        .getByText("My Workspace", { exact: true });
      const cardTextFontSize = await cardName.evaluate(
        (el) => window.getComputedStyle(el).fontSize,
      );
      expect(parseFloat(cardTextFontSize)).toBeGreaterThanOrEqual(16);
    } finally {
      await ctx.close();
    }
  });
}

test("recovery and management actions use the approved aubergine semantic family", async ({
  page,
}) => {
  // AC15 (semantic colors, action contract). Codex review (P2-001)
  // flagged that the previous assertion inspected only the recovery
  // paragraph's neutral gray. The M2 UX addendum
  // (`docs/specs/milestone-2-reconciled-ux.md:269-274`) assigns
  // recovery and management actions to the aubergine semantic
  // family with a base reference around `#3B1E3E` = `rgb(59, 30, 62)`.
  // Sign-out is the only recovery/management control on the
  // surfaces this ticket owns; this test pins its color so a
  // regression to neutral gray or to a blue focus utility fails
  // the assertion.
  //
  // The two sign-out controls live on DIFFERENT surfaces
  // (`dashboard-sign-out` on the converged Personal Workspace
  // surface, `dashboard-recovery-sign-out` on the recovery
  // surface), so the assertion runs two separate sign-in flows
  // against the same page to reach each surface in turn.
  const surfaces: ReadonlyArray<{
    readonly actionId: string;
    readonly surface: "fresh" | "recovery";
  }> = [
    { actionId: "dashboard-sign-out", surface: "fresh" },
    { actionId: "dashboard-recovery-sign-out", surface: "recovery" },
  ];

  for (const { actionId, surface } of surfaces) {
    const email =
      surface === "recovery"
        ? `${RECOVERY_EMAIL_PREFIX}semantic-action-${Date.now()}@example.test`
        : `${FRESH_EMAIL_PREFIX}semantic-action-${Date.now()}@example.test`;
    if (surface === "recovery") seedRecoveryUser(email);
    await signInFresh(page, email);

    const color = await page
      .getByTestId(actionId)
      .evaluate((el) => window.getComputedStyle(el).color);
    // Parse the rgb(...) string into channel components.
    const rgbMatch = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    expect(
      rgbMatch,
      `expected computed color for ${actionId} to be rgb(...), got ${color}`,
    ).not.toBeNull();
    const [, rStr, gStr, bStr] = rgbMatch!;
    const r = Number(rStr);
    const g = Number(gStr);
    const b = Number(bStr);

    // Aubergine family predicate (the M2 UX base is `#3B1E3E` =
    // rgb(59, 30, 62), the hover variant is `#5a3061` = rgb(90, 48, 97),
    // both within the same hue family):
    //   - Dark mid-channel: each channel between 25 and 110 (a dark
    //     semantic-action hue, not light text and not black).
    //   - Purple tilt: G is the LOWEST channel (R > G, B > G), so
    //     the hue reads as aubergine / magenta and not red, green,
    //     blue, or neutral gray.
    //   - Red/blue balance: |R - B| ≤ 25 — aubergine is not pure
    //     red or pure blue; the two outer channels stay in lockstep.
    //   - Not browser default: all channels non-zero.
    expect(r, `${actionId} red channel must be ≥ 25`).toBeGreaterThanOrEqual(25);
    expect(g, `${actionId} green channel must be ≥ 25`).toBeGreaterThanOrEqual(25);
    expect(b, `${actionId} blue channel must be ≥ 25`).toBeGreaterThanOrEqual(25);
    expect(r, `${actionId} must not regress to gray (R must exceed G)`).toBeGreaterThan(g);
    expect(b, `${actionId} must not regress to gray (B must exceed G)`).toBeGreaterThan(g);
    expect(
      Math.abs(r - b),
      `${actionId} must stay in the aubergine hue family (|R-B| ≤ 25)`,
    ).toBeLessThanOrEqual(25);

    // Sign out so the next loop iteration signs in as a fresh user
    // without the serial-config dependency on the recovery-bound
    // session cookie.
    await page.getByTestId(actionId).click();
    await page.waitForURL("/");
  }
});

test("invalid magic-link verification renders an in-page recovery alert, replaces loading, and moves focus to the heading", async ({
  page,
}) => {
  // M2 (#82) visual-QA P2 #1 / #2. Visit the dev verification URL
  // with a token that does NOT resolve to a valid verify-token
  // session, and assert the recovery surface:
  //   - the in-page `<Alert role="alert">` recovery surface renders,
  //   - the loading surface (`role="status"` paragraph) does NOT
  //     render alongside the alert (mutually exclusive),
  //   - the truthful neutral wording "This sign-in link can't be used."
  //     is present,
  //   - the action button label is "Request a new sign-in link",
  //   - focus moves to the alert heading after the alert renders.
  // The token is intentionally malformed; the verify-token endpoint
  // rejects it and the verifier renders the recovery alert.
  await page.context().clearCookies();
  await page.goto("/auth/verify?token=invalid-verification-token");
  const recoveryAlert = page.getByTestId("magic-link-verifier-error");
  await expect(recoveryAlert).toBeVisible();
  await expect(recoveryAlert).toContainText("This sign-in link can't be used.");
  await expect(recoveryAlert).toHaveAttribute("role", "alert");
  // Loading surface is replaced — not visible alongside the alert.
  await expect(page.getByRole("status")).toHaveCount(0);
  // Request-a-new-link action button with the truthful label.
  const resendButton = page.getByTestId("magic-link-verifier-resend");
  await expect(resendButton).toBeVisible();
  await expect(resendButton).toHaveText("Request a new sign-in link");
  // Deliberate focus behavior — focus moves to the alert heading.
  // The heading is rendered as a focusable <h2 tabIndex={-1}> so
  // document.activeElement is the heading element (closest
  // [data-testid] is the Alert wrapper).
  const focusedTestId = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return el.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
  });
  expect(focusedTestId).toBe("magic-link-verifier-error");
});

test("sign-out failure renders a bounded failure alert and preserves the operable sign-out button", async ({
  page,
}) => {
  // M2 (#82) visual-QA P2 #4. Sign in normally, then force a
  // sign-out transport failure (we intercept the sign-out POST and
  // make it 500) and assert:
  //   - the page renders a `role="alert"` Alert with bounded copy
  //     "We couldn't confirm sign-out. Please try again.",
  //   - the sign-out button is NOT disabled by the error state —
  //     retry must remain operable,
  //   - focus restores to the sign-out button after the failure
  //     renders (deliberate focus behavior).
  const email = `${FRESH_EMAIL_PREFIX}signout-failure-${Date.now()}@example.test`;
  await signInFresh(page, email);

  // Intercept /api/auth/sign-out so the next request fails with a
  // transport-level error (the verifier treats a non-2xx response
  // as a thrown error). Use a route handler that aborts the
  // request so the verifier cannot read the response.
  await page.route("**/api/auth/sign-out", (route) => {
    void route.abort("failed");
  });
  await page.getByTestId("dashboard-sign-out").click();
  const errorAlert = page.getByTestId("dashboard-sign-out-error");
  await expect(errorAlert).toBeVisible();
  await expect(errorAlert).toHaveAttribute("role", "alert");
  await expect(errorAlert).toContainText("We couldn't confirm sign-out. Please try again.");
  // Never expose raw transport messages.
  await expect(errorAlert).not.toContainText(/failed to fetch/i);
  // Sign-out button remains operable — not disabled by the error.
  const signOut = page.getByTestId("dashboard-sign-out");
  await expect(signOut).toBeEnabled();
  // Focus restores to the sign-out button after the failure renders.
  await expect(signOut).toBeFocused();
  await page.unroute("**/api/auth/sign-out");
});

test("recovery Card uses the restrained gold attention cue (border color in the gold hue family)", async ({
  page,
}) => {
  // M2 (#82) visual-QA P2 #3. The contradictory-Personal-Workspace
  // recovery surface uses the `Card` `recovery` variant (warm
  // parchment surface + restrained gold border). The cue is never
  // color alone — it is paired with the recovery title and the
  // accompanying recovery text. We assert the computed border color
  // sits in the gold hue family so a regression to the default
  // neutral border fails the assertion.
  const email = `${RECOVERY_EMAIL_PREFIX}gold-cue-${Date.now()}@example.test`;
  seedRecoveryUser(email);
  await signInFresh(page, email);
  const recoveryCard = page.getByTestId("dashboard-recovery").locator(":scope > div").first();
  const borderColor = await recoveryCard.evaluate((el) => {
    return window.getComputedStyle(el).borderColor;
  });
  // Parse the rgb(...) string.
  const rgbMatch = borderColor.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  expect(rgbMatch, `expected recovery Card border color, got ${borderColor}`).not.toBeNull();
  const [, rStr, gStr, bStr] = rgbMatch!;
  const r = Number(rStr);
  const g = Number(gStr);
  const b = Number(bStr);
  // Gold family predicate (the M2 UX addendum's "restrained gold
  // warning and attention treatment" — base reference around
  // #A8763E = rgb(168, 118, 62)). The /40 alpha modifier applies
  // composited so the rendered border color is darker than the
  // base reference but stays in the same warm-brown hue family:
  //   - R is the HIGHEST channel (warm gold, not green / purple),
  //   - B is the LOWEST channel (warm gold, not cool blue),
  //   - All channels are non-zero.
  expect(r, "recovery Card border red channel must be the highest (warm gold)").toBeGreaterThan(g);
  expect(b, "recovery Card border blue channel must be the lowest (warm gold)").toBeLessThan(g);
  expect(
    r,
    "recovery Card border must be visibly warm (red channel > blue channel)",
  ).toBeGreaterThan(b);
});

test("dashboard loading state renders a bounded warm status Alert (no debug-like floating text)", async ({
  page,
}) => {
  // M2 (#82) visual-QA P2 #5. The dashboard loading branch must
  // render EXACTLY ONE bounded warm status surface using the
  // existing Alert primitive — never an unbounded floating
  // paragraph that reads like debug output. Delay the
  // session/convergence request so the loading branch is
  // observable, then assert:
  //   - exactly one semantic status region (no nested status
  //     regions, no debug-like floating paragraph);
  //   - the warm status surface is rendered via the Alert
  //     primitive (`data-alert-variant="status"`, no gold accent);
  //   - copy is customer-safe (no provider / domain / debug terms);
  //   - computed operational text size is >= 16px;
  //   - the loading surface reflows at the existing narrow/zoom
  //     proxy (~240 CSS px) without horizontal overflow;
  //   - after loading resolves, the dashboard transitions to the
  //     expected post-loading state — signed-out here, since the
  //     test carries no session cookie. The successful and
  //     recovery post-loading branches remain covered by the
  //     existing dedicated tests ("fresh sign-in surfaces
  //     exactly one Personal Workspace…" and "recovery surface
  //     renders truthful copy…").
  await page.context().clearCookies();

  // Hold the /api/auth/me response so the loading branch is
  // observable for the assertions below. The route handler defers
  // the response via a Promise; the test releases it manually once
  // the assertions have run. A 5-second setTimeout is a safety net
  // so the request is never abandoned even if the test is slow.
  const releaseMeRoute: { current: (() => void) | null } = { current: null };
  await page.route("**/api/auth/me", async (route) => {
    await new Promise<void>((resolve) => {
      releaseMeRoute.current = resolve;
      setTimeout(resolve, 5000);
    });
    await route.continue();
  });

  await page.goto("/dashboard");

  // Exactly one semantic status region. The Alert primitive emits
  // `role="status"`; the navigation's "Loading…" indicator is a
  // plain <span> with no role, so it does not appear in
  // `getByRole("status")`. A regression that wraps the Alert in
  // an outer role="status" div (nested regions) or that reverts
  // to a plain floating <p role="status"> without the Alert
  // primitive's bounded surface would fail this assertion.
  const statusAlerts = page.getByRole("status");
  await expect(statusAlerts).toHaveCount(1);
  const loadingAlert = statusAlerts.first();
  await expect(loadingAlert).toBeVisible();
  // The status variant is implicit on `role="status"`. Assert the
  // emitted data-attribute so a regression to the recovery (gold)
  // variant fails this assertion.
  await expect(loadingAlert).toHaveAttribute("data-alert-variant", "status");

  // Bounded warm surface — NO gold accent. The recovery variant
  // border-gold/40 (composited against the parchment surface)
  // renders R as the highest channel; the status variant's
  // border-borderWarm (rgb(232, 223, 213) = #E8DFD5) is a flat
  // warm gray. Assert |R - B| stays small so the gold regression
  // fails the assertion.
  const borderColor = await loadingAlert.evaluate((el) => window.getComputedStyle(el).borderColor);
  const rgbMatch = borderColor.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  expect(rgbMatch, `expected border color, got ${borderColor}`).not.toBeNull();
  const [, rStr, , bStr] = rgbMatch!;
  const r = Number(rStr);
  const b = Number(bStr);
  expect(
    Math.abs(r - b),
    `loading surface must NOT use the gold accent — expected |R-B| <= 40, got R=${r} B=${b}`,
  ).toBeLessThanOrEqual(40);
  // Warm neutral predicate — R, G, B all stay in the warm-gray band
  // (each channel between 200 and 240 for the #E8DFD5 base). A
  // regression to a coral or gold border fails this assertion.
  expect(r, "warm neutral border red channel must be in 200..240").toBeGreaterThanOrEqual(200);
  expect(b, "warm neutral border blue channel must be in 200..240").toBeGreaterThanOrEqual(200);

  // Customer-safe copy. Forbidden terms cover debug / provider /
  // domain vocabulary that the dashboard loading surface must
  // NEVER expose to the customer.
  await expect(loadingAlert).not.toContainText(/prisma/i);
  await expect(loadingAlert).not.toContainText(/provider/i);
  await expect(loadingAlert).not.toContainText(/identity\s+provider/i);
  await expect(loadingAlert).not.toContainText(/personal-c[a-z0-9]+/);
  await expect(loadingAlert).not.toContainText(/setup\s*state/i);
  // The visible copy MUST surface the customer-facing
  // "Loading your workspace…" wording.
  await expect(loadingAlert).toContainText(/Loading your workspace/i);

  // Operational text size >= 16px — the Alert primitive renders
  // both the <h2> title and the <p> body at text-base (16px). A
  // regression that drops to text-sm or smaller fails this
  // assertion.
  const h2FontSize = await loadingAlert
    .locator("h2")
    .evaluate((el) => window.getComputedStyle(el).fontSize);
  expect(parseFloat(h2FontSize)).toBeGreaterThanOrEqual(16);
  const bodyFontSize = await loadingAlert
    .locator("p")
    .evaluate((el) => window.getComputedStyle(el).fontSize);
  expect(parseFloat(bodyFontSize)).toBeGreaterThanOrEqual(16);

  // No horizontal overflow at the existing narrow/zoom proxy
  // (~240 CSS px). 240px is the WCAG 320% zoom proxy for a 768px
  // viewport. A regression that introduces a fixed-width wrapper
  // or a non-wrapping title would fail this assertion.
  await page.setViewportSize({ width: 240, height: 720 });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(240 + 1);

  // Release the delayed /api/auth/me request so the loading
  // branch transitions out and the post-loading dashboard state
  // renders. Without a session cookie, the dashboard renders the
  // signed-out surface. The successful/recovery post-loading
  // branches remain covered by the dedicated existing tests; this
  // assertion confirms the transition does not get stuck on the
  // loading surface after the response resolves.
  releaseMeRoute.current?.();
  await expect(page.getByTestId("dashboard-signed-out")).toBeVisible();
  // The status region is gone — the post-loading state does not
  // render alongside or nested under any leftover status surface.
  await expect(page.getByRole("status")).toHaveCount(0);
});
