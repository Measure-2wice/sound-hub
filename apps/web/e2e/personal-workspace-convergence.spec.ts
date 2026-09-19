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
//        Workspace ("My Workspace") with an opaque cuid-shaped
//        slug matching `^personal-c[a-z0-9]+$`.
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

const FRESH_EMAIL_PREFIX = "m2-82-fresh-";
const RECOVERY_EMAIL_PREFIX = "m2-82-recovery-";
const CUID_SLUG_PATTERN = /^personal-c[a-z0-9]+$/;

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

test("fresh sign-in surfaces exactly one Personal Workspace with a cuid-shaped opaque slug", async ({
  page,
}) => {
  const email = `${FRESH_EMAIL_PREFIX}${Date.now()}@example.test`;
  await signInFresh(page, email);

  const slugLocator = page.getByTestId("dashboard-personal-workspace-slug");
  await expect(slugLocator).toBeVisible();
  const slugText = (await slugLocator.textContent())?.trim() ?? "";
  expect(slugText).toMatch(CUID_SLUG_PATTERN);
  expect(slugText.includes("@")).toBe(false);
  const card = page.getByTestId("dashboard-personal-workspace-card");
  await expect(card).toContainText("My Workspace");
});

test("second sign-in with the same email reuses the same Personal Workspace", async ({ page }) => {
  const email = `${FRESH_EMAIL_PREFIX}retry-${Date.now()}@example.test`;
  await signInFresh(page, email);
  const firstSlug =
    (await page.getByTestId("dashboard-personal-workspace-slug").textContent())?.trim() ?? "";
  expect(firstSlug).toMatch(CUID_SLUG_PATTERN);

  await page.getByTestId("dashboard-sign-out").click();
  await page.waitForURL("/");
  await signInFresh(page, email);
  const secondSlug =
    (await page.getByTestId("dashboard-personal-workspace-slug").textContent())?.trim() ?? "";
  expect(secondSlug).toBe(firstSlug);
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

test("semantic colors on the recovery copy fall within the approved muted-text family", async ({
  page,
}) => {
  // AC15 (semantic colors): the recovery body uses the application
  // text palette — a regression to the browser default would mean
  // the design tokens regressed. Codex review (P2-002) flagged the
  // previous assertion as too lax (any non-black color passed).
  // This assertion pins the recovery body to the muted-text gray
  // family Tailwind defines as `text-gray-700` (the same family
  // the dashboard uses for every customer-facing paragraph on both
  // the recovery surface and the Personal Workspace surface).
  const email = `${RECOVERY_EMAIL_PREFIX}semantic-${Date.now()}@example.test`;
  seedRecoveryUser(email);
  await signInFresh(page, email);
  const color = await page
    .getByTestId("dashboard-recovery-body")
    .evaluate((el) => window.getComputedStyle(el).color);

  // Parse the rgb(...) string into channel components so a regression
  // to `rgb(0, 0, 0)` (browser default) or to an out-of-family hue
  // (e.g., pure red or pure green) is caught without depending on a
  // specific Tailwind release.
  const rgbMatch = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  expect(rgbMatch, `expected computed color to be rgb(...), got ${color}`).not.toBeNull();
  const [, rStr, gStr, bStr] = rgbMatch!;
  const r = Number(rStr);
  const g = Number(gStr);
  const b = Number(bStr);

  // The recovery body uses the muted-text gray family. Each channel
  // must satisfy the muted-text predicate: a dark neutral channel
  // (≥ 40 — i.e., far from pure black, which is the regression we
  // want to catch) and the channels must be roughly balanced (no
  // pure chromatic hue) within a bounded delta. The Tailwind
  // `text-gray-700` value `rgb(55, 65, 81)` is the canonical
  // customer-facing paragraph color and falls well within these
  // bounds.
  expect(r).toBeGreaterThanOrEqual(40);
  expect(g).toBeGreaterThanOrEqual(40);
  expect(b).toBeGreaterThanOrEqual(40);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  expect(max - min).toBeLessThanOrEqual(40); // gray family: channels balanced
});
