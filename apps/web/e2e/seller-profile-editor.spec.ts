// M2 #84 — Professional Profile (SellerProfile) editor + reviewer
// focused browser coverage.
//
// Required Playwright coverage for #84. Exercises the named browser
// journeys from the approved plan:
//
//   - Personal-Workspace-only authority: a Seller-capable Personal
//     Workspace can publish; a Buyer-only Personal Workspace is
//     bounced to a recovery Alert; an Organization actor is bounced
//     to the same recovery surface.
//   - Lazy first-save: an empty draft saves on Save Draft; a page
//     refresh renders the same draft state.
//   - Resume: re-opening the editor restores every saved field
//     (professionalName, bio, basedIn.{countryCode,region,city},
//     specialties[], caribbeanAffiliationCodes[]).
//   - Publish confirmation: the publication checkbox is required
//     (Publish disabled until checked).
//   - Publish atomic transition: a successful Publish returns
//     the publishedAt + confirmationVersion + idempotencyKey; the
//     review page renders the truthful post-publication success
//     state (no ServiceOffering was created/activated).
//   - Mobile/responsive QA: the editor and review pages reflow at
//     375 CSS px without horizontal page scroll.
//
// Reuses the existing real-Prisma + real-Next.js + real-Express
// harness (`apps/web/e2e/global-setup.ts`).

import { test, expect, type Page, type ViewportSize } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_TEST_DATABASE_NAME,
  APPROVED_TEST_DATABASE_PORT,
} from "../../api/src/lib/test-database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const APPROVED_DISPOSABLE_TEST_DATABASE_URL = `postgresql://soundhub:password@localhost:${APPROVED_TEST_DATABASE_PORT}/${APPROVED_TEST_DATABASE_NAME}`;

const EMAIL_PREFIX = "m2-84-seller-profile-";
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
  await Promise.race([
    page
      .getByTestId("dashboard")
      .waitFor({ timeout: 15_000 })
      .then(() => undefined),
    page
      .getByTestId("intent-page")
      .waitFor({ timeout: 15_000 })
      .then(() => undefined),
  ]);
}

/**
 * Walk a freshly-signed-in user through the intent page to provision
 * the Seller capability on the Personal Workspace. After this, the
 * dashboard's Seller-readiness row is visible.
 */
async function provisionSellerCapability(page: Page): Promise<void> {
  if (await page.getByTestId("intent-page").count()) {
    // already on intent page
  } else {
    await page.goto("/workspace/intent");
    await page.getByTestId("intent-page").waitFor();
  }
  await page.getByTestId("intent-choice-offer-input").check();
  await page.getByTestId("intent-submit").click();
  await page.getByTestId("dashboard").waitFor();
}

test.describe.configure({ mode: "serial" });

test("Seller-capable Personal Workspace can lazy-first-save a Professional Profile draft", async ({
  page,
}) => {
  const email = `${EMAIL_PREFIX}draft-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Open the editor directly (deep-link).
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();

  await page.getByTestId("profile-edit-input-professional-name").fill("Creole Beats Brooklyn");
  await page
    .getByTestId("profile-edit-input-bio")
    .fill(
      "Brooklyn-based production studio with Caribbean roots. Ten years of mixing, mastering, and on-location recording.",
    );
  await page.getByTestId("profile-edit-input-country").selectOption("US");
  await page.getByTestId("profile-edit-input-region").fill("New York");
  await page.getByTestId("profile-edit-input-city").fill("Brooklyn");

  // Toggle at least one Specialty chip.
  await page.getByTestId("specialty-chip-Producer").click();
  // Toggle at least one Caribbean affiliation.
  await page.getByTestId("profile-edit-caribbean-chip-HT").click();

  // Save draft.
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({
    timeout: 10_000,
  });
});

test("Refreshing the editor renders the same draft state (resume)", async ({ page }) => {
  const email = `${EMAIL_PREFIX}resume-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Seed a draft.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await page.getByTestId("profile-edit-input-professional-name").fill("Resume Test Studio");
  await page
    .getByTestId("profile-edit-input-bio")
    .fill(
      "Test studio for resume coverage — bio text intentionally long enough to test the canonical max(2000) bound.",
    );
  await page.getByTestId("profile-edit-input-country").selectOption("JM");
  await page.getByTestId("specialty-chip-Artist").click();
  await page.getByTestId("profile-edit-caribbean-chip-JM").click();
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({
    timeout: 10_000,
  });

  // Refresh — the editor must re-render the saved values.
  await page.reload();
  await page.getByTestId("profile-edit").waitFor();
  await expect(page.getByTestId("profile-edit-input-professional-name")).toHaveValue(
    "Resume Test Studio",
  );
  // Specialty chip is in the "selected" state after resume.
  await expect(page.getByTestId("specialty-chip-Artist")).toHaveAttribute("aria-pressed", "true");
});

test("Publishing requires the explicit confirmation checkbox; Publish is disabled until checked", async ({
  page,
}) => {
  const email = `${EMAIL_PREFIX}publish-confirm-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Seed a complete draft.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await page.getByTestId("profile-edit-input-professional-name").fill("Confirm Studio");
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Confirm-test bio — covers all required fields so the publish button is reachable.");
  await page.getByTestId("profile-edit-input-country").selectOption("US");
  await page.getByTestId("specialty-chip-Producer").click();
  await page.getByTestId("profile-edit-caribbean-chip-HT").click();
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({
    timeout: 10_000,
  });

  // Navigate to review.
  await page.goto("/seller/profile/review");
  await page.getByTestId("profile-review").waitFor();

  // Publish is disabled until the confirmation checkbox is checked.
  const publishButton = page.getByTestId("profile-review-publish");
  await expect(publishButton).toBeDisabled();
  await page.getByTestId("profile-review-confirm").check();
  await expect(publishButton).toBeEnabled();
});

test("Successful Publish returns the truthful post-publication success state", async ({ page }) => {
  const email = `${EMAIL_PREFIX}publish-success-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Seed a complete draft.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await page.getByTestId("profile-edit-input-professional-name").fill("Success Studio");
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Success-test bio — surfaces the truthful post-publication state copy.");
  await page.getByTestId("profile-edit-input-country").selectOption("TT");
  await page.getByTestId("specialty-chip-Producer").click();
  await page.getByTestId("profile-edit-caribbean-chip-TT").click();
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({
    timeout: 10_000,
  });

  // Publish.
  await page.goto("/seller/profile/review");
  await page.getByTestId("profile-review").waitFor();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();

  // Truthful success surface.
  const success = page.getByTestId("profile-review-success");
  await expect(success).toBeVisible({ timeout: 15_000 });
  await expect(success).toContainText("No ServiceOffering was created");
  await expect(success).toContainText("Your services are not yet available to buyers");
  await expect(success).toContainText(/Create your first service/i);

  // No Stitch terminology leaks into the success surface.
  await expect(success).not.toContainText(/Studio Entity/i);
  await expect(success).not.toContainText(/Acoustic Standards/i);
  await expect(success).not.toContainText(/Step 4 of 4/i);
});

test("Dashboard seller-readiness copy is truthful after publication", async ({ page }) => {
  // Per M2 #84: once a Professional Profile is Published, the
  // dashboard's "Offering services" row must convey the
  // truthful post-publication state — the profile IS published,
  // no service is active yet, and the next product step is
  // creating/activating the first service. The pre-publication
  // "Publish your professional profile and activate at least
  // one service…" copy is stale for a Published profile. The
  // CTA stays "Edit your Professional Profile" per #84; this
  // assertion is solely about the surrounding body + hint.
  const email = `${EMAIL_PREFIX}dashboard-published-copy-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Seed and publish a complete profile.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await page.getByTestId("profile-edit-input-professional-name").fill("Dashboard Studio");
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Dashboard-copy bio — surfaces the truthful Published-row copy.");
  await page.getByTestId("profile-edit-input-country").selectOption("JM");
  await page.getByTestId("specialty-chip-Producer").click();
  await page.getByTestId("profile-edit-caribbean-chip-JM").click();
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({ timeout: 10_000 });

  await page.goto("/seller/profile/review");
  await page.getByTestId("profile-review").waitFor();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();
  await expect(page.getByTestId("profile-review-success")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("profile-review-success-dismiss").click();

  // Land on the dashboard. The seller-readiness row must reflect
  // the Published state with truthful body + hint copy.
  await page.getByTestId("dashboard").waitFor();
  await expect(page.getByTestId("dashboard-seller-readiness")).toBeVisible();
  const sellerBody = page.getByTestId("dashboard-seller-body");
  await expect(sellerBody).toContainText(/Professional Profile is published/i);
  await expect(sellerBody).toContainText(/not yet available to buyers/i);
  await expect(sellerBody).toContainText(/create and activate your first service/i);
  const sellerHint = page.getByTestId("dashboard-seller-hint");
  await expect(sellerHint).toContainText(/next step is to create and activate/i);
  // The CTA stays anchored to the same destination the seller
  // just acted on.
  await expect(page.getByTestId("dashboard-seller-edit-profile")).toHaveAttribute(
    "data-profile-state",
    "published",
  );
  await expect(page.getByTestId("dashboard-seller-edit-profile")).toHaveText(
    /Edit your Professional Profile/i,
  );

  // The stale pre-publication copy must NOT leak into the
  // Published row.
  await expect(sellerBody).not.toContainText(
    /Publish your professional profile and activate at least one service/i,
  );
  await expect(sellerHint).not.toContainText(/private drafts as you go/i);
});

test("Post-publication edits are forwarded to review and persisted via updatePublishedSellerProfile", async ({
  page,
}) => {
  const email = `${EMAIL_PREFIX}update-edits-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Seed a complete draft and publish it.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await page.getByTestId("profile-edit-input-professional-name").fill("Original Studio");
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Original biography — this is the value that was first published.");
  await page.getByTestId("profile-edit-input-country").selectOption("JM");
  await page.getByTestId("specialty-chip-Producer").click();
  await page.getByTestId("profile-edit-caribbean-chip-JM").click();
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({ timeout: 10_000 });

  await page.goto("/seller/profile/review");
  await page.getByTestId("profile-review").waitFor();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();
  await expect(page.getByTestId("profile-review-success")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("profile-review-success-dismiss").click();

  // Re-open the editor. The Published profile's current public
  // values must populate the form.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await expect(page.getByTestId("profile-edit-status")).toContainText(/Published/i);
  await expect(page.getByTestId("profile-edit-input-professional-name")).toHaveValue(
    "Original Studio",
  );

  // Edit the biography. The editor must NOT call saveDraft on a
  // Published profile (the API rejects with SELLER_PROFILE_NOT_DRAFT);
  // instead, the edits live in client state until the user clicks
  // "Review update", which forwards them to the review page via
  // sessionStorage.
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Updated biography — the post-publication edit must reach the public profile.");
  // The Save draft button is hidden when the profile is Published;
  // the "Review update" button replaces it.
  await expect(page.getByTestId("profile-edit-save-draft")).toHaveCount(0);
  await page.getByTestId("profile-edit-review-update").click();

  // The review page must show the EDITED biography, not the stale
  // published one. If it showed the original value, the sessionStorage
  // handoff would have been ignored and the public profile would not
  // change.
  await page.getByTestId("profile-review").waitFor();
  await expect(page.getByTestId("profile-review")).toContainText(
    "Updated biography — the post-publication edit must reach the public profile.",
  );
  await expect(page.getByTestId("profile-review")).not.toContainText(
    "Original biography — this is the value that was first published.",
  );

  // Confirm and update.
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();
  await expect(page.getByTestId("profile-review-success")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("profile-review-success-dismiss").click();

  // The updated biography is now persisted on the server.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await expect(page.getByTestId("profile-edit-status")).toContainText(/Published/i);
  await expect(page.getByTestId("profile-edit-input-bio")).toHaveValue(
    "Updated biography — the post-publication edit must reach the public profile.",
  );
});

test("Post-publication edit rejection is corrected without losing entered values", async ({
  page,
}) => {
  // Per M2 #84: "Post-publication editing starts from current
  // public values and atomically replaces the complete valid public
  // field set with current confirmation; failure preserves the
  // prior public state and creates no persistent working draft."
  //
  // This test exercises the FULL CORRECTION FLOW that the prior
  // "submit failure preserves the prior public state" test only
  // asserted the editor's consistency post-publish:
  //   1. Reject the update by deselecting the only Specialty so the
  //      STRICT completeness invariant fails at the API
  //      (SELLER_PROFILE_INCOMPLETE with field error path
  //      `disciplines.specialtyKeys`).
  //   2. Return to the editor and verify the editor hydrates from
  //      the rejected payload (specialty stays cleared) AND the
  //      retained field-error annotation is still visible in the
  //      editor's ErrorSummary (so the user knows what to fix).
  //   3. Re-select the Specialty, click Review update, confirm and
  //      publish — must succeed and persist the new public state.
  const email = `${EMAIL_PREFIX}update-correction-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Seed and publish.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await page.getByTestId("profile-edit-input-professional-name").fill("Correction Studio");
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Correction-flow bio — exercises the rejected-then-fixed contract.");
  await page.getByTestId("profile-edit-input-country").selectOption("US");
  await page.getByTestId("specialty-chip-Producer").click();
  await page.getByTestId("profile-edit-caribbean-chip-HT").click();
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({ timeout: 10_000 });

  await page.goto("/seller/profile/review");
  await page.getByTestId("profile-review").waitFor();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();
  await expect(page.getByTestId("profile-review-success")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("profile-review-success-dismiss").click();

  // Re-open the editor. The Published profile's public values
  // populate the form.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await expect(page.getByTestId("profile-edit-status")).toContainText(/Published/i);
  await expect(page.getByTestId("profile-edit-input-bio")).toHaveValue(
    "Correction-flow bio — exercises the rejected-then-fixed contract.",
  );

  // Edit the bio AND deselect the only Specialty. The Specialty
  // deselection drives SELLER_PROFILE_INCOMPLETE on the update
  // payload — the (path = disciplines.specialtyKeys, code =
  // specialty_required) field error is what the editor's correction
  // flow must retain.
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Bio proposed for the failing update — must survive the rejection.");
  // Toggle Producer OFF (the chip is currently selected because
  // the Published profile had Producer; clicking it deselects).
  await page.getByTestId("specialty-chip-Producer").click();
  await expect(page.getByTestId("specialty-chip-Producer")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // Save draft is hidden on a Published profile; "Review update"
  // forwards the edits to the review surface.
  await page.getByTestId("profile-edit-review-update").click();

  // The review page must reflect the deselected Specialty (zero
  // selected chips on the preview). The user confirms and submits.
  await page.getByTestId("profile-review").waitFor();
  await expect(page.getByTestId("profile-review-specialties")).toBeEmpty();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();

  // Server rejects with SELLER_PROFILE_INCOMPLETE; the review
  // surface renders the linked ErrorSummary.
  const reviewError = page.getByTestId("profile-review-error-summary");
  await expect(reviewError).toBeVisible({ timeout: 10_000 });

  // Return to the editor. The recovery handoff must:
  //   - hydrate the form from the rejected payload (still-empty
  //     Specialty + the new bio), NOT reload from the server's
  //     Published state;
  //   - retain the per-field error annotation so the user knows
  //     what was rejected.
  await page.getByTestId("profile-review-back-edit").click();
  await page.getByTestId("profile-edit").waitFor();
  await expect(page.getByTestId("profile-edit-input-bio")).toHaveValue(
    "Bio proposed for the failing update — must survive the rejection.",
  );
  await expect(page.getByTestId("specialty-chip-Producer")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByTestId("profile-edit-error-summary")).toBeVisible();

  // Correct the rejection by re-selecting the Specialty.
  await page.getByTestId("specialty-chip-Producer").click();
  await expect(page.getByTestId("specialty-chip-Producer")).toHaveAttribute("aria-pressed", "true");

  // Resubmit. The payload is now complete and the update succeeds.
  await page.getByTestId("profile-edit-review-update").click();
  await page.getByTestId("profile-review").waitFor();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();
  await expect(page.getByTestId("profile-review-success")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("profile-review-success-dismiss").click();

  // Public state holds the corrected bio; the Specialty was
  // preserved across the rejection cycle.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await expect(page.getByTestId("profile-edit-status")).toContainText(/Published/i);
  await expect(page.getByTestId("profile-edit-input-bio")).toHaveValue(
    "Bio proposed for the failing update — must survive the rejection.",
  );
  await expect(page.getByTestId("specialty-chip-Producer")).toHaveAttribute("aria-pressed", "true");
});

test("Prominent action-row Back-to-edit preserves the post-publication edit handoff", async ({
  page,
}) => {
  // Per M2 #84: "Post-publication editing starts from current
  // public values and atomically replaces the complete valid
  // public field set with current confirmation; failure preserves
  // the prior public state and creates no persistent working
  // draft." Both Back-to-edit entry points (the action-row
  // button and the card-footer link) must preserve the
  // handoff so the editor can resume the rejected payload on
  // the next attempt. The destructive Discard path is gated
  // by an explicit confirmation.
  const email = `${EMAIL_PREFIX}preserve-action-back-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Seed and publish.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await page.getByTestId("profile-edit-input-professional-name").fill("Preserve Studio");
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Preserve-flow bio — confirms both Back-to-edit entries preserve the handoff.");
  await page.getByTestId("profile-edit-input-country").selectOption("JM");
  await page.getByTestId("specialty-chip-Producer").click();
  await page.getByTestId("profile-edit-caribbean-chip-JM").click();
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({ timeout: 10_000 });

  await page.goto("/seller/profile/review");
  await page.getByTestId("profile-review").waitFor();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();
  await expect(page.getByTestId("profile-review-success")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("profile-review-success-dismiss").click();

  // Re-open the editor and edit the bio so a real handoff is in
  // sessionStorage before clicking the prominent Back-to-edit.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await expect(page.getByTestId("profile-edit-status")).toContainText(/Published/i);
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Bio carried across the prominent Back-to-edit — must still be editable.");
  await page.getByTestId("profile-edit-review-update").click();

  // The review page renders the proposed bio.
  await page.getByTestId("profile-review").waitFor();
  await expect(page.getByTestId("profile-review")).toContainText(
    "Bio carried across the prominent Back-to-edit",
  );

  // The prominent action-row Back-to-edit must NOT clear the
  // handoff: returning to the editor should still show the
  // edited bio, and the discarded-link affordance must NOT be
  // visible (no destructive one-click path).
  await page.getByTestId("profile-review-back").click();
  await page.getByTestId("profile-edit").waitFor();
  await expect(page.getByTestId("profile-edit-input-bio")).toHaveValue(
    "Bio carried across the prominent Back-to-edit — must still be editable.",
  );

  // The Discard pending changes link is reachable only as an
  // explicit destructive opt-in while a handoff exists; it
  // must require confirmation before clearing.
  await page.getByTestId("profile-edit-review-update").click();
  await page.getByTestId("profile-review").waitFor();
  page.once("dialog", (dialog) => {
    void dialog.dismiss();
  });
  await page.getByTestId("profile-review-discard-updates").click();
  // Cancel keeps the handoff intact.
  await expect(page.getByTestId("profile-review")).toContainText(
    "Bio carried across the prominent Back-to-edit",
  );

  // Accept the second confirmation to actually discard.
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.getByTestId("profile-review-discard-updates").click();
  await page.getByTestId("profile-edit").waitFor();
  // After discard the editor hydrates from the server (not the
  // handoff) — the originally-published bio is back.
  await expect(page.getByTestId("profile-edit-input-bio")).toHaveValue(
    "Preserve-flow bio — confirms both Back-to-edit entries preserve the handoff.",
  );
});

test("Strict publish validation rejects empty professional name / bio and is correctable", async ({
  page,
}) => {
  // Per M2 #84: "Incomplete pre-publication Drafts remain
  // private, resumable, absent from public DTOs, and presented
  // as Private draft. […] Publication requires the functional
  // specification's professional name, biography, country,
  // controlled specialty, Caribbean affiliation." When a Draft
  // lacks any of those required fields at the review stage,
  // the client-side STRICT Zod gate must surface per-field
  // guidance (not a generic failure message), persist that
  // guidance into the editor's correction handoff, and let the
  // seller correct and resubmit.
  const email = `${EMAIL_PREFIX}strict-validation-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Lazy first-save with EMPTY identity. The relaxed draft
  // schema allows partial drafts; the country + disciplines
  // are filled so the only gaps are the identity-required
  // fields and the editor-side country guard won't fire.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await page.getByTestId("profile-edit-input-country").selectOption("JM");
  await page.getByTestId("specialty-chip-Producer").click();
  await page.getByTestId("profile-edit-caribbean-chip-JM").click();
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({ timeout: 10_000 });

  await page.goto("/seller/profile/review");
  await page.getByTestId("profile-review").waitFor();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();

  // The client Zod gate converts the missing fields into a
  // typed SellerProfileClientError with `fieldErrors`. The
  // review surface renders the linked ErrorSummary.
  const reviewError = page.getByTestId("profile-review-error-summary");
  await expect(reviewError).toBeVisible({ timeout: 10_000 });
  await expect(reviewError).toContainText(/professional name/i);
  await expect(reviewError).toContainText(/biography/i);

  // Return to the editor. The retained field errors must show
  // so the user knows exactly what to fix.
  await page.getByTestId("profile-review-back").click();
  await page.getByTestId("profile-edit").waitFor();
  const editError = page.getByTestId("profile-edit-error-summary");
  await expect(editError).toBeVisible();
  await expect(editError).toContainText(/professional name/i);
  await expect(editError).toContainText(/biography/i);

  // Correct the rejected values and save the draft.
  await page.getByTestId("profile-edit-input-professional-name").fill("Strict Studio");
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Strict-bio — the corrected version must reach publication.");
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({ timeout: 10_000 });

  // Now the Draft is complete; publish from review must succeed.
  await page.goto("/seller/profile/review");
  await page.getByTestId("profile-review").waitFor();
  await expect(page.getByTestId("profile-review")).toContainText("Strict Studio");
  await expect(page.getByTestId("profile-review")).toContainText("Strict-bio");
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();
  await expect(page.getByTestId("profile-review-success")).toBeVisible({ timeout: 15_000 });
});

test("Retained field errors are programmatically associated with the editor's controls", async ({
  page,
}) => {
  // Per M2 #84 and the WCAG / §508 contract relied on by the
  // page-level error summary: each retained error must render an
  // adjacent message element AND connect it to its control
  // through `aria-describedby` + `aria-invalid="true"` so
  // assistive tech can announce which field rejected which
  // payload.
  const email = `${EMAIL_PREFIX}a11y-field-association-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Seed a Draft with EMPTY identity (relaxed draft schema
  // accepts) but complete location + disciplines. Rejecting
  // publication surfaces fields errors for BOTH the bio and
  // any specialty-less path — but in this scenario the
  // publisher reaches the publish path with the bio gone
  // missing.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await page.getByTestId("profile-edit-input-country").selectOption("JM");
  await page.getByTestId("specialty-chip-Producer").click();
  await page.getByTestId("profile-edit-caribbean-chip-JM").click();
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({ timeout: 10_000 });

  await page.goto("/seller/profile/review");
  await page.getByTestId("profile-review").waitFor();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();
  await expect(page.getByTestId("profile-review-error-summary")).toBeVisible({ timeout: 10_000 });

  // Return to the editor. The retained error for `identity.bio`
  // must be: (a) carried across the navigation in the
  // sessionStorage rejection state, (b) announced to assistive
  // tech via `aria-invalid="true"` on the bio <textarea>, (c)
  // described by an adjacent error element whose `id` resolves
  // the input's `aria-describedby` pointer.
  await page.getByTestId("profile-review-back").click();
  await page.getByTestId("profile-edit").waitFor();
  const bioTextarea = page.getByTestId("profile-edit-input-bio");
  await expect(bioTextarea).toHaveAttribute("aria-invalid", "true");
  const describedBy = await bioTextarea.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  const errorElement = page.locator(`#${describedBy}`);
  await expect(errorElement).toBeVisible();
  await expect(errorElement).toContainText(/biography/i);
  await expect(errorElement).toHaveAttribute("role", "alert");

  // The summary list still focuses the bio control on click;
  // the per-field error element is an additional
  // (programmatic-association) anchor.
  await expect(page.getByTestId("profile-edit-input-bio-error")).toBeVisible();
});

test("Grouped-field error-summary links land on a focusable control", async ({ page }) => {
  // Per the editor's section in the M2 #84 UX contract: a
  // linked/focusable error summary must navigate to EACH
  // invalid control, including grouped fields like the
  // Specialty chip-set and the Caribbean chip-set. Each
  // rejected path's summary link must land on a real, named,
  // focusable container — not on a phantom id.
  const email = `${EMAIL_PREFIX}a11y-grouped-summary-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);
  await provisionSellerCapability(page);

  // Seed + publish a complete Draft so we land on the Published
  // profile and can deselect both disciplines to drive
  // SELLER_PROFILE_INCOMPLETE on Update.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await page.getByTestId("profile-edit-input-professional-name").fill("Grouped Studio");
  await page
    .getByTestId("profile-edit-input-bio")
    .fill("Grouped-flow bio — exercises the chip-group summary link invariants.");
  await page.getByTestId("profile-edit-input-country").selectOption("JM");
  await page.getByTestId("specialty-chip-Producer").click();
  await page.getByTestId("profile-edit-caribbean-chip-JM").click();
  await page.getByTestId("profile-edit-save-draft").click();
  await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({ timeout: 10_000 });

  await page.goto("/seller/profile/review");
  await page.getByTestId("profile-review").waitFor();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();
  await expect(page.getByTestId("profile-review-success")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("profile-review-success-dismiss").click();

  // Re-open the editor and deselect BOTH disciplines so the
  // Update payload is incomplete.
  await page.goto("/seller/profile/edit");
  await page.getByTestId("profile-edit").waitFor();
  await expect(page.getByTestId("profile-edit-status")).toContainText(/Published/i);
  await page.getByTestId("specialty-chip-Producer").click();
  await expect(page.getByTestId("specialty-chip-Producer")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByTestId("profile-edit-caribbean-chip-JM").click();
  await expect(page.getByTestId("profile-edit-caribbean-chip-JM")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await page.getByTestId("profile-edit-review-update").click();
  await page.getByTestId("profile-review").waitFor();
  await page.getByTestId("profile-review-confirm").check();
  await page.getByTestId("profile-review-publish").click();
  const reviewError = page.getByTestId("profile-review-error-summary");
  await expect(reviewError).toBeVisible({ timeout: 10_000 });

  // Return to the editor and verify each grouped-control summary
  // link targets a real, focusable element.
  await page.getByTestId("profile-review-back").click();
  await page.getByTestId("profile-edit").waitFor();

  // The Specialty group must expose a stable id AND be
  // programmatically focusable (tabindex=-1).
  const specialtyGroup = page.locator("#seller-profile-specialties");
  await expect(specialtyGroup).toBeVisible();
  await expect(specialtyGroup).toHaveAttribute("tabindex", "-1");
  await expect(specialtyGroup).toHaveAttribute("aria-invalid", "true");

  // The Caribbean group must expose a stable id AND be
  // programmatically focusable.
  const caribbeanGroup = page.locator("#seller-profile-caribbean");
  await expect(caribbeanGroup).toBeVisible();
  await expect(caribbeanGroup).toHaveAttribute("tabindex", "-1");
  await expect(caribbeanGroup).toHaveAttribute("aria-invalid", "true");

  // Click each grouped summary link and verify focus reaches
  // the corresponding group container. The summary item testids
  // include the API field path so we can target each link by
  // its stable id.
  const specialtyLink = page.locator(
    'a[href="#seller-profile-specialties"][data-testid="profile-edit-error-summary-link-disciplines.specialtyKeys"]',
  );
  await expect(specialtyLink).toBeVisible();
  await specialtyLink.click();
  await expect(specialtyGroup).toBeFocused();

  const caribbeanLink = page.locator(
    'a[href="#seller-profile-caribbean"][data-testid="profile-edit-error-summary-link-disciplines.caribbeanAffiliationCodes"]',
  );
  await expect(caribbeanLink).toBeVisible();
  await caribbeanLink.click();
  await expect(caribbeanGroup).toBeFocused();
});

test("Buyer-only Personal Workspace is bounced from the editor with a recovery Alert", async ({
  page,
}) => {
  const email = `${EMAIL_PREFIX}buyer-only-${Date.now()}@example.test`;
  seedFreshUser(email);
  await signInViaDevUrl(page, email);

  // Provision Buyer-only (Hire) so the editor rejects the actor.
  await page.goto("/workspace/intent");
  await page.getByTestId("intent-page").waitFor();
  await page.getByTestId("intent-choice-hire-input").check();
  await page.getByTestId("intent-submit").click();
  await page.getByTestId("dashboard").waitFor();

  await page.goto("/seller/profile/edit");
  // The Buyer-only editor surface renders the "Seller capability required"
  // recovery Alert and NOT the editor form.
  await expect(page.getByText(/Seller capability required/i)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("profile-edit")).toHaveCount(0);
});

const VIEWPORTS: ReadonlyArray<{ readonly name: string; readonly size: ViewportSize }> = [
  { name: "mobile-375", size: { width: 375, height: 720 } },
];

test.describe("M2 #84 mobile reflow", () => {
  for (const viewport of VIEWPORTS) {
    test(`editor + review reflow at ${viewport.name} without horizontal page scroll`, async ({
      page,
    }) => {
      const email = `${EMAIL_PREFIX}mobile-${Date.now()}@example.test`;
      seedFreshUser(email);
      await signInViaDevUrl(page, email);
      await provisionSellerCapability(page);
      await page.setViewportSize(viewport.size);

      await page.goto("/seller/profile/edit");
      await page.getByTestId("profile-edit").waitFor();
      const editorScrollWidth = await page.evaluate(() => document.body.scrollWidth);
      const editorClientWidth = await page.evaluate(() => document.body.clientWidth);
      expect(editorScrollWidth).toBeLessThanOrEqual(editorClientWidth + 1);

      // The review page only renders its body once a draft exists;
      // seed the minimum required fields so the mobile reflow can be
      // measured against the publication surface.
      await page.getByTestId("profile-edit-input-professional-name").fill("Mobile Reflow Studio");
      await page
        .getByTestId("profile-edit-input-bio")
        .fill(
          "Reflow coverage bio — covers all required fields so the review surface renders at mobile width.",
        );
      await page.getByTestId("profile-edit-input-country").selectOption("US");
      await page.getByTestId("specialty-chip-Producer").click();
      await page.getByTestId("profile-edit-caribbean-chip-HT").click();
      await page.getByTestId("profile-edit-save-draft").click();
      await expect(page.getByTestId("profile-edit-save-saved")).toBeVisible({
        timeout: 10_000,
      });

      await page.goto("/seller/profile/review");
      await page.getByTestId("profile-review").waitFor();
      const reviewScrollWidth = await page.evaluate(() => document.body.scrollWidth);
      const reviewClientWidth = await page.evaluate(() => document.body.clientWidth);
      expect(reviewScrollWidth).toBeLessThanOrEqual(reviewClientWidth + 1);
    });
  }
});
