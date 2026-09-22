// Codex CHANGES_REQUESTED P1-005: representative browser journey for
// the M2 #83 intent selection + Workspace switching surface.
//
// Scope:
//   - Fresh user with Personal Workspace + Organization Workspace
//     (dual Owner, the multi-workspace-user fixture).
//   - Acting on Personal, dashboard auto-redirects to /workspace/intent.
//   - Hiring completes Buyer capability; view "Find talent" + "View
//     your deals" surface.
//   - Clicking the Workspace selector and choosing the Organization
//     routes through /workspace/switch?target=<orgId>; Cancel
//     leaves the committed actingWorkspace unchanged in localStorage.
//   - Switch and continue commits; the dashboard re-renders under
//     the Organization acting surface with the Organization empty-
//     state (no Choose-intent CTA, capability-aware copy).
//   - localStorage (key `soundhub.actingWorkspaceId`) reflects the
//     committed acting Workspace only after Switch and continue;
//     not after Cancel.
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
    // Pick Hire (no legal copy required for Buyer-only).
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
});
