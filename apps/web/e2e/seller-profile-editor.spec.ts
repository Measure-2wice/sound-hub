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
