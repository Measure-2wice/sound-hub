// Service-offering editor — slice 86F lifecycle / integrated-QA.
//
// Browser coverage of the lifecycle commands introduced in
// issue #86: Pause / Update / Reactivate (including repair mode) /
// final-sample removal / Cancel local edits / grandfathered
// Available + Update needed / non-final Active audio removal /
// Paused sample replacement / viewport reflow at desktop + 393px
// mobile / keyboard focus + dialog accessibility / status conveyed
// beyond color / reduced-motion emulation.
//
// All prerequisite state (UserAccount + Personal Workspace + dual
// Owner membership + Seller capability + Published SellerProfile +
// ServiceOffering in Active or Paused state + activation evidence +
// Live audio sample) is established via the Prisma-direct
// `seedActiveServiceOffering` helper so the browser walk exercises
// ONLY the slice-specific UI surfaces. No fake routes are stubbed;
// no production validation is weakened.

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_TEST_DATABASE_NAME,
  APPROVED_TEST_DATABASE_PORT,
} from "../../api/src/lib/test-database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const APPROVED_DISPOSABLE_TEST_DATABASE_URL = `postgresql://soundhub:password@localhost:${APPROVED_TEST_DATABASE_PORT}/${APPROVED_TEST_DATABASE_NAME}`;

const EMAIL_PREFIX = "lifecycle-coverage-";
const SEED_HELPER = resolvePath(__dirname, "../../api/src/test-helpers/service-offering-active.ts");
const SEED_RUNNER = resolvePath(__dirname, "../../api/node_modules/.bin/tsx");

interface SeedResult {
  readonly email: string;
  readonly userAccountId: string;
  readonly personalWorkspaceId: string;
  readonly sellerProfileId: string;
  readonly offeringId: string;
  readonly offeringSlug: string;
  readonly sampleId: string;
}

function seedActiveOffering(
  email: string,
  sidecarPath: string,
  flags: readonly string[] = [],
  mp3FixturePath?: string,
): SeedResult {
  // Ensure the sidecar parent directory exists before the helper
  // writes to it. The helper does NOT create the directory itself
  // (it runs as a tsx subprocess; filesystem setup is the test's
  // responsibility).
  mkdirSync(dirname(sidecarPath), { recursive: true });
  rmSync(sidecarPath, { force: true });
  execFileSync(SEED_RUNNER, [SEED_HELPER, email], {
    cwd: resolvePath(__dirname, "../../api"),
    env: {
      ...process.env,
      TEST_DATABASE_URL: APPROVED_DISPOSABLE_TEST_DATABASE_URL,
      NODE_ENV: "test",
      SEED_OFFERING_SIDECAR: sidecarPath,
      ...(mp3FixturePath ? { SEED_MP3_FIXTURE_PATH: mp3FixturePath } : {}),
      SEED_FLAGS: flags.join(","),
    },
    stdio: "inherit",
  });
  return JSON.parse(readFileSync(sidecarPath, "utf8")) as SeedResult;
}

function cleanupSidecar(sidecarPath: string, mp3FixturePath?: string): void {
  // The OS temp directory auto-cleans on platform reboot; this
  // explicit removal limits long-lived temp-file accumulation
  // during a single `pnpm test:e2e` invocation. Failing cleanup
  // is non-fatal: the test already ran; the sidecar is read-only.
  try {
    rmSync(sidecarPath, { force: true });
  } catch {
    // ignore
  }
  if (mp3FixturePath) {
    try {
      rmSync(mp3FixturePath, { force: true });
    } catch {
      // ignore
    }
  }
}

async function signInViaDevUrl(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("login-dev-verify").click();
  await page
    .getByTestId("dashboard")
    .waitFor({ timeout: 15_000 })
    .catch(async () => {
      await page.getByTestId("intent-page").waitFor({ timeout: 15_000 });
    });
}

async function openActiveOffering(page: Page, offeringId: string): Promise<void> {
  await page.goto(`/seller/services/${encodeURIComponent(offeringId)}/edit`);
  await expect(
    page.locator("[data-testid='service-offering-edit-status']:has-text('Available')"),
  ).toBeVisible({ timeout: 15_000 });
}

async function openPausedOffering(page: Page, offeringId: string): Promise<void> {
  await page.goto(`/seller/services/${encodeURIComponent(offeringId)}/edit`);
  await expect(
    page.locator("[data-testid='service-offering-edit-status']:has-text('Paused')"),
  ).toBeVisible({ timeout: 15_000 });
}

function sidecarFor(email: string): string {
  // Sidecars live in the OS temp directory so they NEVER pollute
  // the source tree (Playwright would otherwise leave untracked
  // JSON artifacts under `apps/web/e2e/` that fail `pnpm check:fast`
  // formatting). The OS temp dir is auto-cleaned by the platform.
  const safe = email.replace(/[^a-zA-Z0-9]/g, "_");
  return resolvePath(tmpdir(), `soundhub-slice-86f-${safe}-${process.pid}.json`);
}

function mp3FixtureFor(email: string): string {
  // Sibling to the sidecar so a single cleanup pass deletes both.
  const safe = email.replace(/[^a-zA-Z0-9]/g, "_");
  return resolvePath(tmpdir(), `soundhub-slice-86f-${safe}-${process.pid}.mp3`);
}

async function gotoEditorAndWaitForStatus(
  page: Page,
  offeringId: string,
  status: "Available" | "Paused",
): Promise<void> {
  await page.goto(`/seller/services/${encodeURIComponent(offeringId)}/edit`);
  await expect(
    page.locator(`[data-testid='service-offering-edit-status']:has-text('${status}')`),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("Service-offering editor — slice 86F lifecycle / integrated QA", () => {
  test("Pause from Active opens the confirmation dialog and flips the status pill to Paused", async ({
    page,
  }) => {
    const email = `${EMAIL_PREFIX}pause-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email));
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);

    await page.getByTestId("service-offering-edit-pause").click();
    const pauseDialog = page.getByTestId("service-offering-edit-pause-confirm");
    await expect(pauseDialog).toBeVisible();
    await expect(pauseDialog).toHaveRole("alertdialog");
    // Identity context surfaces the Workspace NAME (not the opaque
    // workspaceId) per the M2 UX contract for consequential
    // commands: "Consequential regions repeat the full acting
    // Workspace immediately beside or above the action."
    await expect(pauseDialog).toContainText("Workspace:");
    await expect(
      pauseDialog.locator("[data-testid='service-offering-edit-pause-confirm-context']"),
    ).toBeVisible();
    // Cancel leaves the offering Active.
    await page.getByTestId("service-offering-edit-pause-confirm-cancel").click();
    await expect(pauseDialog).not.toBeVisible();
    await expect(
      page.locator("[data-testid='service-offering-edit-status']:has-text('Available')"),
    ).toBeVisible();
    // Now confirm — the status pill flips.
    await page.getByTestId("service-offering-edit-pause").click();
    await expect(pauseDialog).toBeVisible();
    // Target the CONFIRM BUTTON (testid ends in `-confirm-confirm`)
    // — not the dialog container (testid is `...-confirm`).
    await page.getByTestId("service-offering-edit-pause-confirm-confirm").click();
    await expect(
      page.locator("[data-testid='service-offering-edit-status']:has-text('Paused')"),
    ).toBeVisible({ timeout: 15_000 });
    // Reactivate entry appears on the Paused branch.
    await expect(page.getByTestId("service-offering-edit-reactivate")).toBeVisible();
    // Reload — the status persists.
    await page.reload();
    await expect(
      page.locator("[data-testid='service-offering-edit-status']:has-text('Paused')"),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Update from Active enters local-edit mode and the persistence path passes", async ({
    page,
  }) => {
    const email = `${EMAIL_PREFIX}update-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email));
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);
    const originalTitle = await page.getByTestId("service-offering-edit-input-title").inputValue();

    // The Update button enters local-edit mode directly (no
    // intermediate dialog — the slice plan says: "Click → enter
    // `localEditMode` state").
    await page.getByTestId("service-offering-edit-update").click();
    await expect(page.getByTestId("service-offering-edit-update-submit")).toBeVisible();
    // Inputs are editable in local mode.
    await expect(page.getByTestId("service-offering-edit-input-title")).toBeEnabled();
    const updatedTitle = `${originalTitle} (updated)`;
    await page.getByTestId("service-offering-edit-input-title").fill(updatedTitle);
    await page.getByTestId("service-offering-edit-update-submit").click();
    await expect(page.getByTestId("service-offering-edit-update-success-alert")).toBeVisible({
      timeout: 15_000,
    });
    // Reload — the new title persists.
    await page.reload();
    await expect(page.getByTestId("service-offering-edit-input-title")).toHaveValue(updatedTitle);
  });

  test("Cancel local edits rehydrates the persisted title", async ({ page }) => {
    const email = `${EMAIL_PREFIX}cancel-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email));
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);
    const originalTitle = await page.getByTestId("service-offering-edit-input-title").inputValue();

    await page.getByTestId("service-offering-edit-update").click();
    await expect(page.getByTestId("service-offering-edit-update-submit")).toBeVisible();
    await page.getByTestId("service-offering-edit-input-title").fill("Should be discarded");
    await page.getByTestId("service-offering-edit-update-cancel-button").click();
    await expect(page.getByTestId("service-offering-edit-update-submit")).not.toBeVisible();
    // Title restored to the persisted value.
    await expect(page.getByTestId("service-offering-edit-input-title")).toHaveValue(originalTitle);
  });

  test("Reactivate from Paused enters paused-repair mode and returns the offering to Active", async ({
    page,
  }) => {
    const email = `${EMAIL_PREFIX}reactivate-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email));
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);

    // Pause first to reach the Paused branch.
    await page.getByTestId("service-offering-edit-pause").click();
    await page.getByTestId("service-offering-edit-pause-confirm-confirm").click();
    await expect(
      page.locator("[data-testid='service-offering-edit-status']:has-text('Paused')"),
    ).toBeVisible({ timeout: 15_000 });
    // Reactivate confirms the user intent then enters `paused-repair`
    // mode (the slice plan: "Reactivate enters local repair mode").
    await page.getByTestId("service-offering-edit-reactivate").click();
    const reactivateDialog = page.getByTestId("service-offering-edit-reactivate-confirm");
    await expect(reactivateDialog).toBeVisible();
    await expect(reactivateDialog).toHaveRole("alertdialog");
    await expect(reactivateDialog).toContainText("Workspace:");
    await page.getByTestId("service-offering-edit-reactivate-confirm-confirm").click();
    // After confirming Reactivate, the editor enters paused-repair
    // mode. The Submit button is bound to the Reactivate dispatch
    // (it posts to the strict reactivation endpoint).
    const submitButton = page.getByTestId("service-offering-edit-update-submit");
    await expect(submitButton).toBeVisible();
    // The Submit button label switches to "Submit reactivate" in
    // paused-repair mode so the seller can read which command the
    // surface is dispatching.
    await expect(submitButton).toContainText("Submit reactivate");
    // Paused inputs are unlocked in paused-repair mode (the slice
    // plan: "submit the complete replacement state" requires the
    // seller to be able to edit fields).
    await expect(page.getByTestId("service-offering-edit-input-title")).toBeEnabled();
    // Submit reactivate → Active.
    await submitButton.click();
    await expect(
      page.locator("[data-testid='service-offering-edit-status']:has-text('Available')"),
    ).toBeVisible({ timeout: 15_000 });
    // M2 (#86, slice 86F Codex re-review): successful Reactivate
    // must close paused-repair mode so the newly Active form is
    // read-only. The action row disappears; inputs are disabled;
    // the Reactivate error message (if any) is cleared.
    await expect(page.getByTestId("service-offering-edit-update-submit")).not.toBeVisible();
    await expect(page.getByTestId("service-offering-edit-input-title")).toBeDisabled();
    await expect(page.getByTestId("service-offering-edit-pause")).toBeVisible();
    await expect(page.getByTestId("service-offering-edit-update")).toBeVisible();
    await expect(page.getByTestId("service-offering-edit-reactivate-error")).not.toBeVisible();
    // Reload — Active persists.
    await page.reload();
    await expect(
      page.locator("[data-testid='service-offering-edit-status']:has-text('Available')"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("service-offering-edit-input-title")).toBeDisabled();
  });

  test("Reactivate failure + repair + success (paused-repair preserves entered values)", async ({
    page,
  }) => {
    // Paused offering (seeded as Paused so the Reactivate entry is
    // visible without the in-spec Pause click).
    const email = `${EMAIL_PREFIX}reactivate-repair-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email), ["paused"]);
    await signInViaDevUrl(page, email);
    await gotoEditorAndWaitForStatus(page, seed.offeringId, "Paused");

    // Enter Reactivate → paused-repair mode.
    await page.getByTestId("service-offering-edit-reactivate").click();
    const reactivateDialog = page.getByTestId("service-offering-edit-reactivate-confirm");
    await expect(reactivateDialog).toBeVisible();
    await page.getByTestId("service-offering-edit-reactivate-confirm-confirm").click();
    const submitButton = page.getByTestId("service-offering-edit-update-submit");
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toContainText("Submit reactivate");
    // Clear the title to force the strict reactivation contract to
    // reject with 422.
    await page.getByTestId("service-offering-edit-input-title").fill("");
    await submitButton.click();
    // Failure path: Reactivate error alert visible; entered local
    // values (the empty title) are preserved so the seller can
    // repair without re-typing other fields. The form is still in
    // paused-repair mode (the Submit button + action row stay
    // visible) so the seller can correct + retry.
    await expect(page.getByTestId("service-offering-edit-reactivate-error")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("service-offering-edit-input-title")).toHaveValue("");
    await expect(submitButton).toBeVisible();
    // Repair: restore the title; submit succeeds; offering flips
    // back to Active AND paused-repair mode closes (inputs
    // disabled; action row gone).
    await page.getByTestId("service-offering-edit-input-title").fill("Corrected reactivate title");
    await submitButton.click();
    await expect(
      page.locator("[data-testid='service-offering-edit-status']:has-text('Available')"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(submitButton).not.toBeVisible();
    await expect(page.getByTestId("service-offering-edit-input-title")).toBeDisabled();
    await expect(page.getByTestId("service-offering-edit-reactivate-error")).not.toBeVisible();
  });

  test("Active Update failure + success", async ({ page }) => {
    const email = `${EMAIL_PREFIX}update-failure-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email));
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);

    await page.getByTestId("service-offering-edit-update").click();
    const submitButton = page.getByTestId("service-offering-edit-update-submit");
    await expect(submitButton).toBeVisible();
    // Clear the title to force the strict recheck to reject.
    await page.getByTestId("service-offering-edit-input-title").fill("");
    await submitButton.click();
    await expect(page.getByTestId("service-offering-edit-update-error")).toBeVisible({
      timeout: 15_000,
    });
    // Failure path preserves local values; correct and re-submit.
    await page.getByTestId("service-offering-edit-input-title").fill("Restored update title");
    await submitButton.click();
    await expect(page.getByTestId("service-offering-edit-update-success-alert")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("Grandfathered Available + Update needed surface", async ({ page }) => {
    // Seeded with stale confirmation + missing pricing + missing
    // sample so the readiness predicate returns
    // `updateNeeded: true` with three reason categories.
    const email = `${EMAIL_PREFIX}grandfathered-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email), [
      "stale-confirmation",
      "omit-pricing",
      "omit-sample",
    ]);
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);
    // The status pill still shows "Available" (the offering is
    // grandfathered nonconforming — it remains visible until the
    // seller Pauses or successfully replaces the public state).
    const banner = page.getByTestId("service-offering-edit-update-needed-banner");
    await expect(banner).toBeVisible();
    // The banner surfaces the three closed-set reason categories
    // verbatim from `readiness.reasonCategories`. The closed set
    // is the slice plan's contract vocabulary: every category is
    // pinned to a stable testid so any future regression is loud.
    await expect(
      page.getByTestId("service-offering-edit-update-needed-reason-activation-confirmation-stale"),
    ).toBeVisible();
    await expect(
      page.getByTestId("service-offering-edit-update-needed-reason-pricing-required"),
    ).toBeVisible();
    await expect(
      page.getByTestId("service-offering-edit-update-needed-reason-audio-sample-required"),
    ).toBeVisible();
  });

  test("Non-final Active audio removal does not transition to Paused", async ({ page }) => {
    const email = `${EMAIL_PREFIX}non-final-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email), ["multiple-samples"]);
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);

    // Two Live samples are listed. Click Remove on the first.
    const firstRemove = page
      .locator("[data-testid='service-offering-edit-sample-row']")
      .first()
      .getByTestId("service-offering-edit-sample-remove");
    await firstRemove.click();
    // Non-final removal proceeds without the consequence dialog.
    await expect(
      page.getByTestId("service-offering-edit-final-sample-remove-confirm"),
    ).not.toBeVisible();
    // The offering remains Active.
    await expect(
      page.locator("[data-testid='service-offering-edit-status']:has-text('Available')"),
    ).toBeVisible({ timeout: 15_000 });
    // The second sample is still in the list.
    await expect(page.locator("[data-testid='service-offering-edit-sample-row']")).toHaveCount(1, {
      timeout: 15_000,
    });
  });

  test("Final-sample Active → Paused with explicit consequence confirmation", async ({ page }) => {
    const email = `${EMAIL_PREFIX}final-sample-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email));
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);

    // One Live sample. Click Remove on it.
    await page
      .locator("[data-testid='service-offering-edit-sample-row']")
      .first()
      .getByTestId("service-offering-edit-sample-remove")
      .click();
    // The consequence confirmation dialog opens (M2 #86 slice 86D:
    // final-sample removal transitions the offering to Paused
    // atomically).
    const confirmDialog = page.getByTestId("service-offering-edit-final-sample-remove-confirm");
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toHaveRole("alertdialog");
    await expect(confirmDialog).toContainText("Workspace:");
    // Confirm the consequence (target the CONFIRM BUTTON, not the
    // dialog container).
    await page.getByTestId("service-offering-edit-final-sample-remove-confirm-confirm").click();
    // Status pill flips to Paused.
    await expect(
      page.locator("[data-testid='service-offering-edit-status']:has-text('Paused')"),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Paused sample replacement via the editor upload form does not auto-reactivate", async ({
    page,
  }) => {
    // Seeded as Paused so the Reactivate entry + sample upload
    // affordance are visible. The seed leaves the existing sample
    // in place so we exercise a SECOND upload against the same
    // Paused offering (the slice plan: "Paused — sample upload
    // permitted"). The deterministic in-memory storage adapter is
    // already populated by the seed; the upload step posts a real
    // multipart body so the test exercises the actual upload
    // path, not just the visible affordance.
    const email = `${EMAIL_PREFIX}paused-upload-${Date.now()}@example.test`;
    const sidecarPath = sidecarFor(email);
    const mp3FixturePath = mp3FixtureFor(email);
    const seed = seedActiveOffering(email, sidecarPath, ["paused"], mp3FixturePath);
    try {
      await signInViaDevUrl(page, email);
      await openPausedOffering(page, seed.offeringId);

      // The sample upload form must be available on the Paused branch.
      await expect(page.getByTestId("service-offering-edit-sample-upload-form")).toBeVisible();
      // Drive a real upload via the editor UI. The bytes come
      // from the canonical deterministic MP3 fixture the helper
      // writes to disk — a truncated hand-rolled frame would
      // fail the production MP3 validator ("MPEG frame body
      // exceeds the payload"). The deterministic fixture is the
      // SAME bytes the BG7 browser proof uses; they are
      // guaranteed to satisfy the trusted-boundary validator.
      const sampleBytes = readFileSync(mp3FixturePath);
      const fileChooserPromise = page.waitForEvent("filechooser");
      await page.getByTestId("service-offering-edit-sample-file-input").click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: "paused-sample.mp3",
        mimeType: "audio/mpeg",
        buffer: sampleBytes,
      });
      await page.getByTestId("service-offering-edit-sample-label-input").fill("Paused replacement");
      await page.getByTestId("service-offering-edit-sample-confirmation").check();
      await page.getByTestId("service-offering-edit-sample-submit").click();
      // Wait for the upload to land — the sample list re-renders
      // with the new row appended.
      await expect(page.locator("[data-testid='service-offering-edit-sample-row']")).toHaveCount(
        2,
        {
          timeout: 15_000,
        },
      );
      // The status pill remains Paused after the upload (the slice
      // plan: "Paused — sample upload permitted" — and "no auto-
      // reactivation"). The upload is purely additive against the
      // Paused lifecycle state.
      await expect(
        page.locator("[data-testid='service-offering-edit-status']:has-text('Paused')"),
      ).toBeVisible();
    } finally {
      cleanupSidecar(sidecarPath, mp3FixturePath);
    }
  });

  test("Viewport reflow at 393px mobile", async ({ browser }) => {
    const email = `${EMAIL_PREFIX}viewport-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email));
    const context = await browser.newContext({
      viewport: { width: 393, height: 800 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);
    // Body scrollWidth stays within the viewport (no horizontal
    // page scroll on the 393px mobile surface).
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // Status pill + Pause / Update buttons remain visible at the
    // mobile breakpoint (they may stack vertically; the testids
    // still resolve).
    await expect(
      page.locator("[data-testid='service-offering-edit-status']:has-text('Available')"),
    ).toBeVisible();
    await expect(page.getByTestId("service-offering-edit-pause")).toBeVisible();
    await expect(page.getByTestId("service-offering-edit-update")).toBeVisible();
    await context.close();
  });

  test("Dialog accessibility — initial focus, Tab containment, focus restoration", async ({
    page,
  }) => {
    const email = `${EMAIL_PREFIX}dialog-a11y-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email));
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);

    // Open the Pause confirmation dialog. The Pause button is the
    // trigger; focus is captured on the confirm button on dialog
    // mount (the M2 UX contract: "Dialogs and interstitials move
    // focus appropriately into the active surface").
    await page.getByTestId("service-offering-edit-pause").click();
    const dialog = page.getByTestId("service-offering-edit-pause-confirm");
    await expect(dialog).toBeVisible();
    // Target the CONFIRM BUTTON (testid ends in `-confirm-confirm`)
    // for the focused-element check, not the dialog container.
    const confirmButton = page.getByTestId("service-offering-edit-pause-confirm-confirm");
    await expect(confirmButton).toBeFocused({ timeout: 5_000 });

    // Tab cycles forward through the focusable elements in the
    // dialog; tabbing past the last wraps to the first.
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("service-offering-edit-pause-confirm-cancel")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirmButton).toBeFocused();
    // Shift+Tab cycles backward to the cancel button.
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("service-offering-edit-pause-confirm-cancel")).toBeFocused();

    // Escape dismisses (cancellation is allowed; the operation
    // is not pending).
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    // Focus is restored to the trigger button.
    await expect(page.getByTestId("service-offering-edit-pause")).toBeFocused();
  });

  test("Status conveyed beyond color — text + accessible name", async ({ page }) => {
    const email = `${EMAIL_PREFIX}status-beyond-color-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email));
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);
    const pill = page.getByTestId("service-offering-edit-status");
    await expect(pill).toContainText("Available");
    // The accessible name carries the same text so the status is
    // not color-only (the M2 UX contract: "Lifecycle, readiness,
    // validation, approval, funding, and progress never depend
    // on color alone.").
    const accessibleName = await pill.evaluate(
      (el) => el.getAttribute("aria-label") ?? el.textContent ?? "",
    );
    expect(accessibleName).toContain("Available");
  });

  test("Reduced motion emulation disables the editor spinner / pulse dot animation", async ({
    browser,
  }) => {
    const email = `${EMAIL_PREFIX}reduced-motion-${Date.now()}@example.test`;
    const seed = seedActiveOffering(email, sidecarFor(email));
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await signInViaDevUrl(page, email);
    await openActiveOffering(page, seed.offeringId);
    // The status pill / Save button renders a SyncIcon spinner /
    // identity dot with `motion-safe:animate-…`. With
    // `prefers-reduced-motion: reduce`, the computed
    // `animationDuration` is `0s` (Tailwind's
    // `motion-reduce:animate-none` sets `animation: none`).
    const spinnerAnimationDuration = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='service-offering-edit-status'] svg");
      if (!el) return "1s";
      return window.getComputedStyle(el).animationDuration;
    });
    expect(spinnerAnimationDuration).toBe("0s");
    await context.close();
  });
});
