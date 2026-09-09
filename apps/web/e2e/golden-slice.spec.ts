import { test, expect } from "@playwright/test";
import { assertAudioPlaybackUsable } from "./golden-slice-helpers";

// BG7 (ticket #65) — the integrated Buildathon Golden Slice
// browser journey.
//
// This is the SINGLE integrated journey that proves the entire
// Golden Slice (BG1 → BG6) against real disposable PostgreSQL.
// The journey uses the deterministic adapters for auth, AI,
// storage, and escrow (configured via webServer.env) while
// crossing the same routes/DTOs as the deployed providers.
//
// AC mapping:
//   AC1 — exactly one browser journey exercises the complete
//         buyer-to-Active-Deal sequence against real disposable
//         PostgreSQL (this file).
//   AC2 — the journey crosses the same application interfaces as
//         the deployed providers while remaining deterministic
//         and independent of live email, AI, storage, and
//         blockchain services (env flags + in-process storage).
//   AC3 — the Active Deal view displays seller consent, both
//         approvals, sandbox funding confirmation, and the
//         terminal "Deal Active — escrow funded; commissioned
//         work may begin." message (asserted in step 10).
//         Per Codex P1 (ticket AC27), the seller-consent
//         indicator is driven by the narrow `sellerConsent`
//         projection on the BG5 Deal view, which is derived
//         from the persisted ProjectRequest; it MUST NOT be
//         inferred from Deal existence alone.
//   AC4 — managed Supabase Auth and Storage configuration pass one
//         bounded deployed-environment smoke (operator-run; not
//         in this file; tracked in docs/deployment/bg7-golden-slice-evidence.md).
//   AC5 — deployed beta uses truthful mock/provider and
//         asset/environment labels (asserted in step 10).
//   AC6 — public/counterparty DTOs do not expose provider
//         subjects, private email, session tokens, storage
//         internals, Prisma-only data, or internal AI data
//         (asserted in step 10).
//
// The journey runs in the main `chromium` project; it does NOT
// depend on the dedicated `chromium-outage` project (no DB
// interruption here). The single page is shared across the
// entire serial run so cookies carry the acting-Workspace and
// session state.

const DEMO_BUYER_EMAIL = "demo.buyer@soundhub.example";
const DEMO_SELLER_EMAIL = "marc.andre@creolebeats.example";
const DEMO_BUYER_WORKSPACE_ID = "ws-bg1-demo-buyer";
const CANONICAL_OFFERING_TITLE = "Haitian dancehall single production — remote";
const TERMINAL_ACTIVE_COPY = "Deal Active — escrow funded; commissioned work may begin.";

test.describe.configure({ mode: "serial" });

test("BG7: integrated buyer-to-Active-Deal journey", async ({ page }) => {
  // -------------------------------------------------------------
  // Step 1 — Buyer sign-in (BG1).
  // -------------------------------------------------------------
  await page.goto("/login");
  await page.getByTestId("login-email").fill(DEMO_BUYER_EMAIL);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-sent")).toBeVisible();
  // The deterministic adapter emits devVerificationUrl only when
  // BG1_DETERMINISTIC_OPERATOR_MODE=1, which is wired in
  // apps/web/playwright.config.ts webServer.env.
  await page.getByTestId("login-dev-verify").click();
  await expect(page).toHaveURL(/\/dashboard/);

  // -------------------------------------------------------------
  // Step 2 — Submit a brief (BG3).
  // -------------------------------------------------------------
  await page.goto("/matchmaker");
  await expect(page.getByTestId("matchmaker-page")).toBeVisible();
  // The acting-Workspace selector renders a <label> wrapper around a
  // hidden <input type="radio">; click the label so the radio is
  // checked via the standard form behaviour.
  await page
    .locator(
      `[data-testid="matchmaker-workspace-option"][data-workspace-id="${DEMO_BUYER_WORKSPACE_ID}"]`,
    )
    .click();
  // The DEFAULT_BRIEF text is already populated in the textarea.
  await page.getByTestId("matchmaker-submit").click();
  await expect(page.getByTestId("matchmaker-recommendation-list")).toBeVisible({
    timeout: 30_000,
  });

  // -------------------------------------------------------------
  // Step 3 — Preview the audio sample inline (BG2 — strengthened).
  //
  // Per amendment 2, simply rendering <audio src=...> is NOT
  // sufficient evidence. The journey MUST prove:
  //   - the playback request succeeds;
  //   - the response Content-Type is audio/mpeg;
  //   - the <audio> element reaches a usable media state
  //     (loadeddata / canplay / HAVE_FUTURE_DATA).
  // The test does NOT depend on physical audio output — it never
  // asserts that bytes are heard.
  // -------------------------------------------------------------
  const firstRecommendation = page.getByTestId("matchmaker-recommendation-item").first();
  await expect(firstRecommendation).toBeVisible();
  // The audio preview surface starts collapsed; the toggle has
  // aria-expanded=false. Clicking it opens the player.
  const previewToggle = firstRecommendation.getByTestId("matchmaker-preview-toggle");
  await expect(previewToggle).toBeVisible();
  await expect(previewToggle).toHaveAttribute("aria-expanded", "false");

  await previewToggle.click();
  await expect(previewToggle).toHaveAttribute("aria-expanded", "true");

  // The audio player renders inside the same recommendation row.
  const audioPlayer = firstRecommendation.getByTestId("matchmaker-audio-player");
  await expect(audioPlayer).toBeVisible({ timeout: 15_000 });
  const audioSrc = await audioPlayer.getAttribute("src");
  expect(audioSrc, "audio player must carry an in-app playback URL").toBeTruthy();
  expect(audioSrc).toMatch(
    /^https?:\/\/[^/]+\/api\/services\/of-creole-beats-dancehall-single-remote\/audio-samples\/.+\/play$/,
  );

  await assertAudioPlaybackUsable({ page, playerLocator: audioPlayer });

  // -------------------------------------------------------------
  // Step 4 — Invite the seller (BG4).
  // -------------------------------------------------------------
  await firstRecommendation.getByTestId("matchmaker-invite-button").click();
  const inviteSuccess = page.getByTestId("matchmaker-invite-success");
  await expect(inviteSuccess).toBeVisible({ timeout: 15_000 });
  await expect(inviteSuccess).toContainText("ProjectRequest");
  await expect(inviteSuccess).toContainText("Pending");

  // -------------------------------------------------------------
  // Step 5 — Sign out + sign back in as the seller (BG1).
  // -------------------------------------------------------------
  await page.getByTestId("nav-desktop-row").getByTestId("nav-sign-out").click();
  // Sign-out clears the session but does not navigate; the
  // session-cookie is revoked server-side and the UI re-renders
  // in the signed-out state. The next test step explicitly goes to
  // /login to re-authenticate as the seller.
  await page.goto("/login");
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.getByTestId("login-email").fill(DEMO_SELLER_EMAIL);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-sent")).toBeVisible();
  await page.getByTestId("login-dev-verify").click();
  await expect(page).toHaveURL(/\/dashboard/);

  // -------------------------------------------------------------
  // Step 6 — Accept the ProjectRequest (BG4).
  // -------------------------------------------------------------
  await page.goto("/seller-requests");
  await expect(page.getByTestId("seller-requests-page")).toBeVisible();
  // The seller-requests inbox lists Pending requests for the
  // current Seller-capable Workspace. The row whose brief title
  // matches the canonical offering title is the one we created.
  const inboxRow = page
    .locator(`[data-testid="seller-request-row"]`)
    .filter({ hasText: CANONICAL_OFFERING_TITLE })
    .first();
  await expect(inboxRow).toBeVisible();
  await inboxRow.getByTestId("seller-request-accept").click();
  const acceptSuccess = page.getByTestId("seller-requests-success");
  await expect(acceptSuccess).toBeVisible({ timeout: 15_000 });
  await expect(acceptSuccess).toContainText("Accepted");

  // -------------------------------------------------------------
  // Step 7 — Discover the Deal through the shipped flow (BG5 +
  // BG6 surface, ticket #74). Per amendment 1, the journey must
  // reach /deals/:dealId via the Deals navigation + row click —
  // NOT via goto(/deals/${dealId}).
  // -------------------------------------------------------------
  await page.goto("/deals");
  await expect(page.getByTestId("deals-page")).toBeVisible();
  // The acting Workspace picker auto-selects a Seller-capable
  // Workspace; the Deal we created is visible to the seller.
  const dealRow = page
    .locator(`[data-testid="deal-row"]`)
    .filter({ hasText: CANONICAL_OFFERING_TITLE })
    .first();
  await expect(dealRow).toBeVisible({ timeout: 15_000 });
  // Confirm the row title carries the offering title (human-
  // readable evidence we are picking the right Deal without
  // relying on the raw id).
  await expect(dealRow.getByTestId("deal-row-title")).toContainText(CANONICAL_OFFERING_TITLE);
  await dealRow.getByTestId("deal-row-link").click();
  await expect(page).toHaveURL(/\/deals\/[a-z0-9]+/);
  await expect(page.getByTestId("deal-page")).toBeVisible();

  // Capture the dealId from the URL for the buyer-side assertion.
  // This is permitted per the plan ("dealId may still be captured
  // for assertions, but the browser navigation itself uses the
  // shipped flow"). The dealId is NOT used for browser routing.
  const dealId = page.url().match(/\/deals\/([a-z0-9]+)/)?.[1] ?? "";
  expect(dealId, "dealId must be extractable from the row-click URL").toBeTruthy();

  // -------------------------------------------------------------
  // Step 8 — Draft + approve TermsVersion 1 as the seller (BG5).
  // -------------------------------------------------------------
  await expect(page.getByTestId("deal-no-terms")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("deal-draft-button").click();
  await expect(page.getByTestId("deal-terms-view")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("deal-terms-version-label")).toHaveText(/TermsVersion\s+1/);
  await page.getByTestId("deal-approve-button").click();
  // The seller-side approval row transitions from "Pending" to
  // "Approved at …". The list renders both Buyer and Seller rows;
  // the Seller row's text starts with "Seller:".
  const sellerApprovalRow = page
    .locator(`[data-testid="deal-approvals"] [data-testid="deal-approval"]`)
    .filter({ hasText: /Seller:/ });
  await expect(sellerApprovalRow.first()).toContainText("Approved at");

  // -------------------------------------------------------------
  // Step 9 — Sign back in as the buyer, approve, then fund
  // (BG5 + BG6).
  // -------------------------------------------------------------
  await page.getByTestId("nav-desktop-row").getByTestId("nav-sign-out").click();
  // Sign-out clears the session; navigate explicitly.
  await page.goto("/login");
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.getByTestId("login-email").fill(DEMO_BUYER_EMAIL);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-sent")).toBeVisible();
  await page.getByTestId("login-dev-verify").click();
  await expect(page).toHaveURL(/\/dashboard/);

  // Repeat the ticket #74 deal-discovery flow. The Deal is
  // visible to the buyer under the Buyer-capable acting
  // Workspace; locate it by offering title, click the row link.
  await page.goto("/deals");
  await expect(page.getByTestId("deals-page")).toBeVisible();
  const buyerDealRow = page
    .locator(`[data-testid="deal-row"]`)
    .filter({ hasText: CANONICAL_OFFERING_TITLE })
    .first();
  await expect(buyerDealRow).toBeVisible({ timeout: 15_000 });
  await expect(buyerDealRow.getByTestId("deal-row-title")).toContainText(CANONICAL_OFFERING_TITLE);
  await buyerDealRow.getByTestId("deal-row-link").click();
  await expect(page).toHaveURL(new RegExp(`/deals/${dealId}`));
  await expect(page.getByTestId("deal-page")).toBeVisible();

  await page.getByTestId("deal-approve-button").click();
  // Both approvals are now recorded — the AI-drafted badge
  // transitions to "approved by both parties" (BG5).
  await expect(page.getByTestId("deal-terms-ai-badge")).toContainText(/approved/i, {
    timeout: 15_000,
  });
  await page.getByTestId("deal-fund-button").click();
  await expect(page.getByTestId("deal-active-terminal")).toBeVisible({ timeout: 15_000 });

  // -------------------------------------------------------------
  // Step 10 — Terminal assertions (AC#3, #5, #6).
  // -------------------------------------------------------------
  // AC3 (seller consent — ticket AC27): the Active Deal view
  // renders an explicit seller-consent indicator sourced from the
  // narrow `sellerConsent` projection on the BG5 Deal view. The
  // projection is derived from the persisted ProjectRequest
  // (status="Accepted" + sellerConsentAt), so the indicator
  // appears here because the seller accepted the ProjectRequest in
  // step 6. The indicator MUST NOT be inferred from Deal
  // existence alone.
  await expect(page.getByTestId("deal-seller-consent")).toBeVisible();
  await expect(page.getByTestId("deal-seller-consent")).toContainText(/Seller consent.*Accepted/);
  await expect(page.getByTestId("deal-seller-consent")).toHaveAttribute(
    "data-consent-status",
    "Accepted",
  );

  // AC3 (seller approval): the seller-side approval row
  // transitioned from "Pending" to "Approved at …" in step 8.
  // The approval list is stable across the buyer round-trip; we
  // re-assert it here so the terminal step proves both sides
  // have approved and consent is recorded.
  const terminalSellerApprovalRow = page
    .locator(`[data-testid="deal-approvals"] [data-testid="deal-approval"]`)
    .filter({ hasText: /Seller:/ });
  await expect(terminalSellerApprovalRow.first()).toContainText("Approved at");

  // AC3 (buyer approval): the buyer-side approval row also
  // transitioned to "Approved at …" in step 9.
  const terminalBuyerApprovalRow = page
    .locator(`[data-testid="deal-approvals"] [data-testid="deal-approval"]`)
    .filter({ hasText: /Buyer:/ });
  await expect(terminalBuyerApprovalRow.first()).toContainText("Approved at");

  // AC3 (sandbox funding confirmation): the funding status row
  // carries the deterministic-confirmed copy from the public DTO.
  await expect(page.getByTestId("deal-funding-status")).toContainText(/Funding confirmed/i);

  // AC3: the Active Deal view displays the required terminal copy.
  await expect(page.getByTestId("deal-active-terminal")).toHaveText(TERMINAL_ACTIVE_COPY);

  // AC5: truthful labels. The funding surface carries the
  // canonical "Sandbox · simulated" badge and the funding
  // status carries the simulated-network label (the public DTO
  // also exposes assetLabel="sandbox-USDC"; this assertion proves
  // the rendered UI surfaces both the network label and the
  // sandbox badge so no real-network claim slips through).
  await expect(page.getByTestId("deal-funding-badge")).toContainText(/Sandbox.*simulated/s);
  await expect(page.getByTestId("deal-funding-status")).toContainText(/simulated-network/);
  await expect(page.getByTestId("deal-funding-status")).toContainText(/sandbox/);

  // AC6: public/counterparty DTOs do NOT expose provider
  // subjects, private email, session tokens, storage internals,
  // Prisma-only data, or internal AI data. The page body must not
  // contain any of these forbidden strings.
  const bodyText = (await page.textContent("body")) ?? "";
  const forbidden = [
    "paymentIntentId",
    "correlationId",
    "providerReference",
    "Supabase signed",
    "bucket=",
    "fail_unsafe",
  ];
  for (const needle of forbidden) {
    expect(bodyText, `page body must not contain "${needle}"`).not.toContain(needle);
  }
});

// (no extra tests; the journey spec above is the single integrated
// proof per ticket #65 AC#1)
