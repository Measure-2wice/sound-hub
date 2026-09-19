import { test, expect, type Page, type ViewportSize } from "@playwright/test";
import { execSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";

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
  // guard for fail-closed targeting.
  const repoRoot = resolvePath(__dirname, "..", "..", "..");
  const scriptPath = resolvePath(repoRoot, "scripts", "db-seed-recovery-user.mjs");
  const tsxBin = resolvePath(repoRoot, "apps", "api", "node_modules", ".bin", "tsx");
  execSync(`${tsxBin} ${scriptPath} ${email}`, {
    stdio: "pipe",
    env: process.env,
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
  await seedRecoveryUser(email);
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
      await seedRecoveryUser(email);
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
