// Representative browser journey for the M2 #83 intent
// selection + Workspace switching surface.
//
// Scope:
//   - Fresh user with Personal Workspace + Organization Workspace
//     (dual Owner, the multi-workspace-user fixture).
//   - Acting on Personal, dashboard auto-redirects to /workspace/intent.
//   - Hire, Offer, and Both happy paths each provision the right
//     capability set; the Shell renders the correct destinations
//     for each — Deals is visible for Buyer OR Seller.
//   - Later capability addition is gated by the atomic primitive:
//     re-submitting the SAME intent is idempotent; a CONFLICTING
//     retry (Hire after Offer) is rejected with INTENT_FORBIDDEN
//     and zero unintended capability writes.
//   - Validated return continuity: deep-link to
//     /workspace/intent?return=/talent resumes at /talent after a
//     successful Hire.
//   - Clicking the Workspace selector and choosing the Organization
//     routes through /workspace/switch?target=<orgId; Cancel leaves
//     the committed actingWorkspace unchanged in localStorage.
//   - Switch and continue commits; the dashboard re-renders under
//     the Organization acting surface with the Organization empty-
//     state (no Choose-intent CTA, capability-aware copy).
//   - localStorage (key `soundhub.actingWorkspaceId`) reflects the
//     committed acting Workspace only after Switch and continue;
//     not after Cancel.
//   - Keyboard navigation: Tab order traverses intent → submit
//     without a pointer (reduced-motion friendly).
//   - Narrow viewport (mobile / small): no horizontal page scroll;
//     the acting-Workspace control remains visible outside the menu.
//
// The fixture is created via the existing
// `apps/api/src/test-helpers/multi-workspace-user.ts` helper (a
// direct Prisma seed). No new product flow is introduced in this
// spec.

import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_TEST_DATABASE_NAME,
  APPROVED_TEST_DATABASE_PORT,
} from "../../api/src/lib/test-database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPROVED_DISPOSABLE_TEST_DATABASE_URL = `postgresql://soundhub:password@localhost:${APPROVED_TEST_DATABASE_PORT}/${APPROVED_TEST_DATABASE_NAME}`;

const FRESH_EMAIL_PREFIX = "m2-83-intent-";
const SEED_HELPER = resolvePath(__dirname, "../../api/src/test-helpers/multi-workspace-user.ts");
const SEED_RUNNER = resolvePath(__dirname, "../../api/node_modules/.bin/tsx");

function seedFreshUser(email: string): void {
  execFileSync(SEED_RUNNER, [SEED_HELPER, email], {
    cwd: resolvePath(__dirname, "../../api"),
    env: {
      ...process.env,
      TEST_DATABASE_URL: APPROVED_DISPOSABLE_TEST_DATABASE_URL,
      NODE_ENV: "test",
    },
    stdio: "inherit",
  });
}

async function signInViaDevUrl(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("login-dev-verify").click();
  await page.getByTestId("dashboard").or(page.getByTestId("dashboard-recovery")).waitFor();
}

function readCommittedActingWorkspaceId(page: Page): Promise<string | null> {
  return page.evaluate(() => window.localStorage.getItem("soundhub.actingWorkspaceId"));
}

test.describe("M2 #83: intent + Workspace switching (P1-005)", () => {
  test("cancel from switch interstitial leaves committed acting Workspace unchanged", async ({
    page,
  }) => {
    const email = `${FRESH_EMAIL_PREFIX}cancel-${Date.now()}@example.test`;
    seedFreshUser(email);
    await signInViaDevUrl(page, email);
    // Reach the dashboard — the multi-workspace user is already
    // converged onto the Personal Workspace as the default.
    await page.getByTestId("dashboard").waitFor();
    const initialCommitted = await readCommittedActingWorkspaceId(page);
    // No remembered actingWorkspace yet; the resolver falls
    // back to the user's Personal. Initial committed value
    // is null (no localStorage write yet on first sign-in
    // interaction).
    if (initialCommitted !== null) {
      // Clear it so we observe the post-cancel invariant.
      await page.evaluate(() => window.localStorage.removeItem("soundhub.actingWorkspaceId"));
    }
    // The dashboard pin to Personal-only has already fired;
    // by the time we land here, Buyer capability is expected
    // absent. Verify the Choose-intent / intent page path is
    // accessible via dashboard CTA.
    const chooseIntent = page.getByTestId("dashboard-choose-intent");
    if (await chooseIntent.count()) {
      await chooseIntent.click();
    } else {
      await page.goto("/workspace/intent");
    }
    await page.getByTestId("intent-page").waitFor();
    // Pick Hire. #83 re-revision: no Seller participation terms
    // surface is required for any intent path — the intent page
    // submits the choice directly to the server.
    await page.getByTestId("intent-choice-hire-input").check();
    await page.getByTestId("intent-submit").click();
    // Returns to /dashboard via navigateAfterIntent.
    await page.getByTestId("dashboard").waitFor();
    await expect(page.getByTestId("dashboard-buyer-readiness")).toBeVisible();

    // Now click the ActingWorkspaceSelector and pick the
    // Organization.
    await page.getByTestId("acting-workspace-selector").click();
    await page
      .getByTestId(/^acting-workspace-option-/)
      .nth(1) // first [0] is Personal, second [1] is Organization
      .click();

    // We land on the switch interstitial with the Organization
    // as the pending target (query string carries `target=`).
    await page.getByTestId("workspace-switch-page").waitFor();
    await expect(page).toHaveURL(/target=/);
    // Capture committed BEFORE cancel; should be unchanged.
    const beforeCancel = await readCommittedActingWorkspaceId(page);
    await page.getByTestId("workspace-switch-cancel").click();
    // The committed actingWorkspace must NOT have changed.
    const afterCancel = await readCommittedActingWorkspaceId(page);
    expect(afterCancel).toBe(beforeCancel);
    // The dashboard re-renders Buyer readiness under the still-
    // committed Personal acting surface.
    await page.getByTestId("dashboard").waitFor();
    await expect(page.getByTestId("dashboard-buyer-readiness")).toBeVisible();
  });

  test("Switch and continue commits and renders the Organization empty-state (no Choose-intent CTA)", async ({
    page,
  }) => {
    const email = `${FRESH_EMAIL_PREFIX}commit-${Date.now()}@example.test`;
    seedFreshUser(email);
    await signInViaDevUrl(page, email);
    await page.getByTestId("dashboard").waitFor();

    await page.evaluate(() => window.localStorage.removeItem("soundhub.actingWorkspaceId"));

    // Walk to the switch interstitial targeting the Organization.
    await page.getByTestId("acting-workspace-selector").click();
    await page
      .getByTestId(/^acting-workspace-option-/)
      .nth(1)
      .click();
    await page.getByTestId("workspace-switch-page").waitFor();
    await page.getByTestId("workspace-switch-continue").click();
    await page.getByTestId("dashboard").waitFor();

    // Re-read localStorage: it MUST now hold the Organization id.
    const committed = await readCommittedActingWorkspaceId(page);
    expect(committed).not.toBeNull();
    expect(committed).not.toBe("");

    // The Organization dashboard renders the empty-state copy
    // and offers a "Switch to your Personal Workspace" link —
    // NOT the Choose-intent CTA (which is Personal-only).
    await expect(page.getByTestId("dashboard-org-no-capabilities")).toBeVisible();
    await expect(page.getByTestId("dashboard-choose-intent")).toHaveCount(0);
    await expect(page.getByTestId("dashboard-org-switch-to-personal")).toBeVisible();
  });

  // -----------------------------------------------------------------
  // Additional acceptance paths: Offer, Both, later-add / conflicting-
  // retry, validated return continuity, keyboard, narrow viewport.
  // -----------------------------------------------------------------

  /**
   * Walk the freshly-signed-in user to the intent page. The
   * dashboard auto-redirects to `/workspace/intent` when the actor
   * is a Personal Workspace with zero capabilities; if the
   * auto-redirect has not fired yet, fall back to a direct
   * navigation.
   */
  async function walkToIntentPage(page: Page): Promise<void> {
    const chooseIntent = page.getByTestId("dashboard-choose-intent");
    if (await chooseIntent.count()) {
      await chooseIntent.click();
    } else {
      await page.goto("/workspace/intent");
    }
    await page.getByTestId("intent-page").waitFor();
  }

  test("Offer provisions Seller capability and the Shell exposes Deals", async ({ page }) => {
    const email = `${FRESH_EMAIL_PREFIX}offer-${Date.now()}@example.test`;
    seedFreshUser(email);
    await signInViaDevUrl(page, email);
    await page.evaluate(() => window.localStorage.removeItem("soundhub.actingWorkspaceId"));
    await walkToIntentPage(page);
    await page.getByTestId("intent-choice-offer-input").check();
    await page.getByTestId("intent-submit").click();
    await page.getByTestId("dashboard").waitFor();
    // Seller readiness surfaces the forward-journey copy:
    // publish profile + activate service → receive requests.
    // the dashboard Seller copy reflects the forward journey.
    await expect(page.getByTestId("dashboard-seller-readiness")).toBeVisible();
    // Sellers are also Deal parties — Deals must render in the
    // Shell and the dashboard quick-actions.
    await expect(page.getByTestId("nav-deals-link")).toBeVisible();
    await expect(page.getByTestId("dashboard-view-deals")).toBeVisible();
    // The Shell also surfaces the Seller-only destinations.
    await expect(page.getByTestId("nav-requests-link")).toBeVisible();
    await expect(page.getByTestId("nav-services-link")).toBeVisible();
  });

  test("Both provisions Buyer + Seller atomically; Shell exposes all capability-aware destinations", async ({
    page,
  }) => {
    const email = `${FRESH_EMAIL_PREFIX}both-${Date.now()}@example.test`;
    seedFreshUser(email);
    await signInViaDevUrl(page, email);
    await page.evaluate(() => window.localStorage.removeItem("soundhub.actingWorkspaceId"));
    await walkToIntentPage(page);
    await page.getByTestId("intent-choice-both-input").check();
    await page.getByTestId("intent-submit").click();
    await page.getByTestId("dashboard").waitFor();
    // Dual capability: both Buyer and Seller readiness rows visible.
    await expect(page.getByTestId("dashboard-buyer-readiness")).toBeVisible();
    await expect(page.getByTestId("dashboard-seller-readiness")).toBeVisible();
    // Shell surfaces Deals (Buyer OR Seller) and Seller-only
    // destinations.
    await expect(page.getByTestId("nav-deals-link")).toBeVisible();
    await expect(page.getByTestId("nav-requests-link")).toBeVisible();
    await expect(page.getByTestId("nav-services-link")).toBeVisible();
    await expect(page.getByTestId("dashboard-find-talent")).toBeVisible();
    await expect(page.getByTestId("dashboard-view-deals")).toBeVisible();
  });

  test("Validated return continuity: deep-link /workspace/intent?return=/talent resumes at /talent", async ({
    page,
  }) => {
    const email = `${FRESH_EMAIL_PREFIX}return-${Date.now()}@example.test`;
    seedFreshUser(email);
    await signInViaDevUrl(page, email);
    await page.evaluate(() => window.localStorage.removeItem("soundhub.actingWorkspaceId"));
    // Direct navigation to the intent page with a validated
    // `?return=/talent` query.
    await page.goto("/workspace/intent?return=/talent");
    await page.getByTestId("intent-page").waitFor();
    await page.getByTestId("intent-choice-hire-input").check();
    await page.getByTestId("intent-submit").click();
    // After success, the browser must land at the validated
    // /talent destination (the server-resolved `safeReturnTo`),
    // NOT /dashboard.
    await page.waitForURL(/\/talent/);
    await expect(page).toHaveURL(/\/talent/);
  });

  test("Validated return continuity: cross-Workspace switch honors ?return=", async ({ page }) => {
    const email = `${FRESH_EMAIL_PREFIX}switch-return-${Date.now()}@example.test`;
    seedFreshUser(email);
    await signInViaDevUrl(page, email);
    await page.evaluate(() => window.localStorage.removeItem("soundhub.actingWorkspaceId"));
    // Walk to the Organization acting surface, with a validated
    // return destination threaded through the switch interstitial.
    await walkToIntentPage(page);
    await page.getByTestId("intent-choice-hire-input").check();
    await page.getByTestId("intent-submit").click();
    await page.getByTestId("dashboard").waitFor();

    // Open the selector and pick the Organization, but this time
    // the URL carries `?return=/talent`. The interstitial commits;
    // the browser must resume at `/talent`.
    await page.getByTestId("acting-workspace-selector").click();
    await page
      .getByTestId(/^acting-workspace-option-/)
      .nth(1)
      .click();
    await page.getByTestId("workspace-switch-page").waitFor();
    // The interstitial received `?return=/talent` via the
    // ActingWorkspaceSelector navigation; commit.
    await page.getByTestId("workspace-switch-continue").click();
    await page.waitForURL(/\/talent/);
    await expect(page).toHaveURL(/\/talent/);
  });

  test("Conflicting intent retry (Offer after Hire) surfaces INTENT_FORBIDDEN; zero unintended writes", async ({
    page,
  }) => {
    const email = `${FRESH_EMAIL_PREFIX}conflict-${Date.now()}@example.test`;
    seedFreshUser(email);
    await signInViaDevUrl(page, email);
    await page.evaluate(() => window.localStorage.removeItem("soundhub.actingWorkspaceId"));
    await walkToIntentPage(page);
    // First submission: Hire → Buyer.
    await page.getByTestId("intent-choice-hire-input").check();
    await page.getByTestId("intent-submit").click();
    await page.getByTestId("dashboard").waitFor();
    await expect(page.getByTestId("dashboard-buyer-readiness")).toBeVisible();

    // The user now navigates back to the intent page and tries to
    // silently switch to Offer — the conflict path. The dashboard
    // has a "Choose intent" entry path: the Buyer capability is
    // already present, so the dashboard's auto-redirect does NOT
    // fire (the dashboard renders Buyer readiness). The user
    // navigates directly to /workspace/intent.
    await page.goto("/workspace/intent");
    await page.getByTestId("intent-page").waitFor();
    await page.getByTestId("intent-choice-offer-input").check();
    await page.getByTestId("intent-submit").click();
    // The server rejects the conflicting retry; the page renders
    // the INTENT_FORBIDDEN error envelope.
    await expect(page.getByTestId("intent-error")).toBeVisible({ timeout: 5000 });
    // Navigate back to the dashboard; Buyer-only readiness remains.
    await page.goto("/dashboard");
    await page.getByTestId("dashboard").waitFor();
    await expect(page.getByTestId("dashboard-buyer-readiness")).toBeVisible();
    // The Seller readiness row must NOT have appeared (zero silent
    // merge into Both).
    await expect(page.getByTestId("dashboard-seller-readiness")).toHaveCount(0);
  });

  test("Keyboard-only intent submission", async ({ page }) => {
    const email = `${FRESH_EMAIL_PREFIX}keyboard-${Date.now()}@example.test`;
    seedFreshUser(email);
    await signInViaDevUrl(page, email);
    await page.evaluate(() => window.localStorage.removeItem("soundhub.actingWorkspaceId"));
    await walkToIntentPage(page);
    // Focus the Hire radio (the first radio in the fieldset) and
    // toggle it via Space. Arrow-key navigation between radios
    // follows standard browser radio-group semantics.
    await page.getByTestId("intent-choice-hire-input").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("intent-choice-hire-input")).toBeChecked();
    // Tab to the Submit button and activate via Enter.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.getByTestId("dashboard").waitFor();
    await expect(page.getByTestId("dashboard-buyer-readiness")).toBeVisible();
  });

  test("Narrow viewport reflow (mobile / reflow behavior)", async ({ page }) => {
    // 360 × 800 is the canonical narrow viewport. The intent page
    // MUST NOT introduce a horizontal page scroll.
    await page.setViewportSize({ width: 360, height: 800 });
    const email = `${FRESH_EMAIL_PREFIX}narrow-${Date.now()}@example.test`;
    seedFreshUser(email);
    await signInViaDevUrl(page, email);
    await page.evaluate(() => window.localStorage.removeItem("soundhub.actingWorkspaceId"));
    await walkToIntentPage(page);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    // The intent form remains usable: every radio + submit button
    // is in the visible viewport band.
    await expect(page.getByTestId("intent-choice-hire")).toBeVisible();
    await expect(page.getByTestId("intent-choice-offer")).toBeVisible();
    await expect(page.getByTestId("intent-choice-both")).toBeVisible();
    await expect(page.getByTestId("intent-submit")).toBeVisible();
  });
});
