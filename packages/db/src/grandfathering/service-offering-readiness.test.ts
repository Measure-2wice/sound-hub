// Tests for the pure readiness predicate in
// ./service-offering-readiness.ts. These tests do NOT touch the
// database — the predicate is a pure function and the tests are
// pure-function tests against the closed set of reason categories
// the slice plan locks.
//
// The predicate lives in `packages/db/src/grandfathering/` so the
// inventory script can consume it without an upward
// `packages/db → apps/api` dependency (the slice plan's "Dependency
// boundary" section). The tests live alongside the source for the
// same reason: a sibling relative import keeps this file inside
// the package's boundary.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  deriveEffectiveConfirmationVersion,
  deriveServiceOfferingReadiness,
  SERVICE_OFFERING_MAX_CONFIRMED_LIVE_SAMPLES,
  SERVICE_OFFERING_MIN_CONFIRMED_LIVE_SAMPLES,
  type EffectiveConfirmationVersionInput,
  type ServiceOfferingReadiness,
  type ServiceOfferingReadinessInput,
  type ServiceOfferingReadinessReasonCategory,
} from "./service-offering-readiness.js";

const CURRENT_CONFIRMATION = "m2-service-activation-v1";
const STALE_CONFIRMATION = "m2-service-activation-v0";

function conformantInput(
  overrides: Partial<ServiceOfferingReadinessInput> = {},
): ServiceOfferingReadinessInput {
  return {
    status: "Active",
    title: "Haitian dancehall production",
    description: "Arrangement + recording direction + editing.",
    hasPrimaryCategory: true,
    serviceMode: "Remote",
    serviceAreaCount: 0,
    hasPricing: true,
    confirmedLiveSampleCount: SERVICE_OFFERING_MIN_CONFIRMED_LIVE_SAMPLES,
    sellerProfileStatus: "Published",
    confirmationVersion: CURRENT_CONFIRMATION,
    currentConfirmationVersion: CURRENT_CONFIRMATION,
    ...overrides,
  };
}

void describe("deriveServiceOfferingReadiness", () => {
  void test("a fully conformant Active offering is Available + not Update needed + zero categories", () => {
    const r = deriveServiceOfferingReadiness(conformantInput());
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, false);
    assert.deepEqual(r.reasonCategories, []);
    assert.equal(r.isGrandfatheredNonconforming, false);
  });

  void test("[true/true regression] a nonconforming Active offering is Available + Update needed", () => {
    // The 86E Codex re-review primary concern: the prior
    // conjunction `isAvailable && reasons.length > 0` was
    // logically impossible. This test pins the corrected
    // semantics: every nonconforming Active offering returns
    // BOTH `isAvailable=true` (preserved marketplace eligibility)
    // AND `updateNeeded=true` (the actionable Update-needed
    // signal). The two flags are independent.
    const r = deriveServiceOfferingReadiness(conformantInput({ title: "" }));
    assert.equal(r.isAvailable, true, "Active row must remain Available even when nonconforming");
    assert.equal(r.updateNeeded, true, "Nonconforming Active row must report Update needed");
    assert.deepEqual(r.reasonCategories, ["title-required"]);
    assert.equal(r.isGrandfatheredNonconforming, true);
  });

  void test("Active + missing title surfaces title-required + isAvailable=true + updateNeeded=true", () => {
    const r = deriveServiceOfferingReadiness(conformantInput({ title: "" }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, ["title-required"]);
  });

  void test("Active + whitespace-only title surfaces title-required", () => {
    const r = deriveServiceOfferingReadiness(conformantInput({ title: "   " }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, ["title-required"]);
  });

  void test("Active + missing description surfaces description-required + isAvailable=true + updateNeeded=true", () => {
    const r = deriveServiceOfferingReadiness(conformantInput({ description: "" }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, ["description-required"]);
  });

  void test("Active + no primary category surfaces category-required + isAvailable=true + updateNeeded=true", () => {
    const r = deriveServiceOfferingReadiness(conformantInput({ hasPrimaryCategory: false }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, ["category-required"]);
  });

  void test("InPerson + zero service areas surfaces service-area-required + isAvailable=true + updateNeeded=true", () => {
    const r = deriveServiceOfferingReadiness(
      conformantInput({ serviceMode: "InPerson", serviceAreaCount: 0 }),
    );
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, ["service-area-required"]);
  });

  void test("Hybrid + zero service areas surfaces service-area-required + isAvailable=true + updateNeeded=true", () => {
    const r = deriveServiceOfferingReadiness(
      conformantInput({ serviceMode: "Hybrid", serviceAreaCount: 0 }),
    );
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, ["service-area-required"]);
  });

  void test("Remote + zero service areas does NOT surface service-area-required", () => {
    const r = deriveServiceOfferingReadiness(
      conformantInput({ serviceMode: "Remote", serviceAreaCount: 0 }),
    );
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, false, "Remote offerings with zero service areas are conformant");
    assert.equal(
      r.reasonCategories.includes("service-area-required"),
      false,
      "Remote offerings do not require service areas",
    );
  });

  void test("Active + no pricing surfaces pricing-required + isAvailable=true + updateNeeded=true", () => {
    const r = deriveServiceOfferingReadiness(conformantInput({ hasPricing: false }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, ["pricing-required"]);
  });

  void test("Active + zero CONFIRMED Live samples surfaces audio-sample-required + isAvailable=true + updateNeeded=true", () => {
    const r = deriveServiceOfferingReadiness(conformantInput({ confirmedLiveSampleCount: 0 }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, ["audio-sample-required"]);
  });

  void test("Active + too many CONFIRMED Live samples surfaces audio-sample-required (closed upper bound)", () => {
    const r = deriveServiceOfferingReadiness(
      conformantInput({
        confirmedLiveSampleCount: SERVICE_OFFERING_MAX_CONFIRMED_LIVE_SAMPLES + 1,
      }),
    );
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, ["audio-sample-required"]);
  });

  void test("Active + null confirmationVersion surfaces activation-confirmation-stale (grandfathered)", () => {
    // Grandfathered Active offering whose original activation was
    // never written (or whose update evidence was not yet merged
    // by the caller). The seller must re-run the activation
    // contract via `reactivate` or a successful `updateActive`
    // for the effective confirmation to converge.
    const r = deriveServiceOfferingReadiness(conformantInput({ confirmationVersion: null }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.ok(
      r.reasonCategories.includes("activation-confirmation-stale"),
      "Draft-only (null confirmation) Active rows surface activation-confirmation-stale",
    );
  });

  void test("Active + mismatched confirmationVersion surfaces activation-confirmation-stale (grandfathered)", () => {
    const r = deriveServiceOfferingReadiness(
      conformantInput({ confirmationVersion: STALE_CONFIRMATION }),
    );
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.ok(r.reasonCategories.includes("activation-confirmation-stale"));
  });

  void test("Active + Draft SellerProfile surfaces seller-profile-not-published (grandfathered)", () => {
    const r = deriveServiceOfferingReadiness(conformantInput({ sellerProfileStatus: "Draft" }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.ok(r.reasonCategories.includes("seller-profile-not-published"));
  });

  void test("Active + Suspended SellerProfile surfaces seller-profile-not-published (grandfathered)", () => {
    const r = deriveServiceOfferingReadiness(conformantInput({ sellerProfileStatus: "Suspended" }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.ok(r.reasonCategories.includes("seller-profile-not-published"));
  });

  void test("Draft offerings do NOT surface activation-confirmation-stale (not Active)", () => {
    const r = deriveServiceOfferingReadiness(
      conformantInput({ status: "Draft", confirmationVersion: null }),
    );
    assert.equal(r.isAvailable, false);
    assert.equal(r.updateNeeded, false);
    assert.equal(
      r.reasonCategories.includes("activation-confirmation-stale"),
      false,
      "Non-Active offerings are never stale-confirmation (marketplace does not require Visibility on Draft)",
    );
  });

  void test("Draft offerings do NOT surface seller-profile-not-published (not Active)", () => {
    const r = deriveServiceOfferingReadiness(
      conformantInput({ status: "Draft", sellerProfileStatus: "Draft" }),
    );
    assert.equal(r.isAvailable, false);
    assert.equal(r.updateNeeded, false);
    assert.equal(r.reasonCategories.includes("seller-profile-not-published"), false);
  });

  void test("Paused offerings carry the field-level reasons but are NOT Available", () => {
    const r = deriveServiceOfferingReadiness(conformantInput({ status: "Paused", title: "" }));
    assert.equal(r.isAvailable, false, "Paused is not a marketplace-eligible state");
    assert.equal(
      r.updateNeeded,
      false,
      "Paused offerings cannot be Update-needed (must Reactivate first)",
    );
    assert.deepEqual(r.reasonCategories, ["title-required"]);
  });

  void test("Archived offerings carry the field-level reasons but are NOT Available", () => {
    const r = deriveServiceOfferingReadiness(
      conformantInput({ status: "Archived", description: "" }),
    );
    assert.equal(r.isAvailable, false);
    assert.equal(r.updateNeeded, false);
    assert.deepEqual(r.reasonCategories, ["description-required"]);
  });

  void test("Active + multiple reasons surfaces every applicable category + isAvailable=true + updateNeeded=true", () => {
    // A legacy Active offering with every field-level category
    // missing, plus stale confirmation, plus a Draft
    // SellerProfile. The marketplace eligibility is preserved
    // (isAvailable=true) and the operator/seller must surface
    // ALL actionable reasons.
    const r = deriveServiceOfferingReadiness(
      conformantInput({
        title: "",
        description: "",
        hasPrimaryCategory: false,
        serviceMode: "InPerson",
        serviceAreaCount: 0,
        hasPricing: false,
        confirmedLiveSampleCount: 0,
        confirmationVersion: null,
        sellerProfileStatus: "Draft",
      }),
    );
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, [
      "title-required",
      "description-required",
      "category-required",
      "service-area-required",
      "pricing-required",
      "audio-sample-required",
      "activation-confirmation-stale",
      "seller-profile-not-published",
    ]);
  });

  void test("Active + current confirmation + Draft profile: every reason is independent (grandfathered)", () => {
    // Regression pin: the prior test claimed
    // `updateNeeded=false` here because of an alleged
    // "SellerProfile gate". There is no gate — every reason
    // category is independent. A grandfathered Active offering
    // with a Draft SellerProfile returns BOTH `isAvailable=true`
    // AND `updateNeeded=true`; the seller must publish the
    // profile to clear the `seller-profile-not-published`
    // category.
    const r = deriveServiceOfferingReadiness(
      conformantInput({
        confirmationVersion: CURRENT_CONFIRMATION,
        sellerProfileStatus: "Draft",
      }),
    );
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.ok(r.reasonCategories.includes("seller-profile-not-published"));
  });

  void test("Active + current confirmation + Published profile + missing title: grandfathered on the title alone", () => {
    // Regression pin: the prior test claimed
    // `updateNeeded=false` here because "title-required alone
    // does not make the offering grandfathered". That was wrong
    // per the slice plan's Grandfathering section: title missing
    // IS one of the grandfathered reasons. The predicate reports
    // BOTH `isAvailable=true` AND `updateNeeded=true`.
    const r = deriveServiceOfferingReadiness(
      conformantInput({
        confirmationVersion: CURRENT_CONFIRMATION,
        sellerProfileStatus: "Published",
        title: "",
      }),
    );
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.deepEqual(r.reasonCategories, ["title-required"]);
  });

  void test("the reason categories are emitted in the slice-plan-defined order (stable for rendering)", () => {
    const r = deriveServiceOfferingReadiness(
      conformantInput({
        title: "",
        description: "",
        hasPrimaryCategory: false,
        serviceMode: "InPerson",
        serviceAreaCount: 0,
        hasPricing: false,
        confirmedLiveSampleCount: 0,
        confirmationVersion: null,
        sellerProfileStatus: "Draft",
      }),
    );
    const expected: ServiceOfferingReadinessReasonCategory[] = [
      "title-required",
      "description-required",
      "category-required",
      "service-area-required",
      "pricing-required",
      "audio-sample-required",
      "activation-confirmation-stale",
      "seller-profile-not-published",
    ];
    assert.deepEqual(r.reasonCategories, expected);
  });

  void test("isGrandfatheredNonconforming is in lockstep with updateNeeded (same conjunction)", () => {
    const r1: ServiceOfferingReadiness = deriveServiceOfferingReadiness(
      conformantInput({ title: "" }),
    );
    assert.equal(r1.isGrandfatheredNonconforming, r1.updateNeeded);
    const r2: ServiceOfferingReadiness = deriveServiceOfferingReadiness(conformantInput());
    assert.equal(r2.isGrandfatheredNonconforming, r2.updateNeeded);
    const r3: ServiceOfferingReadiness = deriveServiceOfferingReadiness(
      conformantInput({ status: "Paused", title: "" }),
    );
    assert.equal(r3.isGrandfatheredNonconforming, r3.updateNeeded);
  });
});

void describe("deriveEffectiveConfirmationVersion", () => {
  // Timestamps used by every test below. The helper compares
  // occurredAt values to select the chronologically newest
  // evidence event; the date math is arbitrary but stable
  // across runs.
  const T_BASE = new Date("2024-01-01T00:00:00.000Z");
  const T_LATER = new Date("2024-06-01T00:00:00.000Z");
  const T_LATEST = new Date("2024-12-01T00:00:00.000Z");

  void test("no activation and no update returns null (Draft-only)", () => {
    const input: EffectiveConfirmationVersionInput = {
      latestActivation: null,
      latestUpdate: null,
    };
    assert.equal(deriveEffectiveConfirmationVersion(input), null);
  });

  void test("activation-only returns the activation's confirmationVersion", () => {
    const input: EffectiveConfirmationVersionInput = {
      latestActivation: {
        confirmationVersion: CURRENT_CONFIRMATION,
        occurredAt: T_BASE,
      },
      latestUpdate: null,
    };
    assert.equal(deriveEffectiveConfirmationVersion(input), CURRENT_CONFIRMATION);
  });

  void test("update-only returns the update's confirmationVersion", () => {
    const input: EffectiveConfirmationVersionInput = {
      latestActivation: null,
      latestUpdate: {
        confirmationVersion: CURRENT_CONFIRMATION,
        occurredAt: T_BASE,
      },
    };
    assert.equal(deriveEffectiveConfirmationVersion(input), CURRENT_CONFIRMATION);
  });

  void test("update is newer than activation: the update's confirmationVersion wins", () => {
    // The 86E blocker #2 root scenario. An Active offering whose
    // original activation was at v0 and which has a successful
    // update at v1 must NOT be misclassified as
    // `activation-confirmation-stale`. The update evidence is
    // authoritative; the activation row is preserved verbatim
    // per the slice plan and is NOT rewritten.
    const input: EffectiveConfirmationVersionInput = {
      latestActivation: {
        confirmationVersion: STALE_CONFIRMATION,
        occurredAt: T_BASE,
      },
      latestUpdate: {
        confirmationVersion: CURRENT_CONFIRMATION,
        occurredAt: T_LATER,
      },
    };
    assert.equal(deriveEffectiveConfirmationVersion(input), CURRENT_CONFIRMATION);
  });

  void test("newer reactivation supersedes an older update (after version rotation) — Activate → Update → Pause → Reactivate", () => {
    // The 86E Codex re-review blocker #1 follow-up. After a
    // confirmation-version rotation, a Reactivate issued AFTER
    // the rotation writes a NEW activation row at the current
    // version while the older update row from before the
    // rotation still carries the previous version. The helper
    // MUST pick the chronologically newest event — the newer
    // activation, NOT the older update.
    const input: EffectiveConfirmationVersionInput = {
      latestActivation: {
        confirmationVersion: CURRENT_CONFIRMATION,
        occurredAt: T_LATEST,
      },
      latestUpdate: {
        confirmationVersion: STALE_CONFIRMATION,
        occurredAt: T_LATER,
      },
    };
    assert.equal(deriveEffectiveConfirmationVersion(input), CURRENT_CONFIRMATION);
  });

  void test("both present at the same timestamp: returns the update's confirmationVersion (tie-break)", () => {
    // Same-instant Reactivate and update is impossible in
    // practice (Reactivate creates an activation row without
    // an accompanying update, and update is forbidden on Paused
    // rows). The helper picks the update value when timestamps
    // are equal so the contract is total and deterministic.
    const sameInstant = T_BASE;
    const input: EffectiveConfirmationVersionInput = {
      latestActivation: {
        confirmationVersion: "m2-service-activation-v0",
        occurredAt: sameInstant,
      },
      latestUpdate: {
        confirmationVersion: CURRENT_CONFIRMATION,
        occurredAt: sameInstant,
      },
    };
    assert.equal(deriveEffectiveConfirmationVersion(input), CURRENT_CONFIRMATION);
  });
});

void describe("deriveServiceOfferingReadiness with effective confirmation", () => {
  // Integration of deriveEffectiveConfirmationVersion +
  // deriveServiceOfferingReadiness, exercising the 86E blocker #2
  // scenario end-to-end at the pure-function level.

  const T_BASE = new Date("2024-01-01T00:00:00.000Z");
  const T_LATER = new Date("2024-06-01T00:00:00.000Z");
  const T_LATEST = new Date("2024-12-01T00:00:00.000Z");

  void test("Active + legacy activation at v0 + successful update at v1 is NOT stale-confirmation", () => {
    const effective = deriveEffectiveConfirmationVersion({
      latestActivation: {
        confirmationVersion: STALE_CONFIRMATION,
        occurredAt: T_BASE,
      },
      latestUpdate: {
        confirmationVersion: CURRENT_CONFIRMATION,
        occurredAt: T_LATER,
      },
    });
    assert.equal(effective, CURRENT_CONFIRMATION);

    const r = deriveServiceOfferingReadiness(conformantInput({ confirmationVersion: effective }));
    assert.equal(r.isAvailable, true);
    assert.equal(
      r.updateNeeded,
      false,
      "successfully repaired Active row must NOT be Update needed",
    );
    assert.deepEqual(r.reasonCategories, []);
  });

  void test("Activate → Update → Pause → Reactivate after version rotation: stale update does not poison readiness", () => {
    // The 86E Codex re-review blocker #1 follow-up. The
    // older update at v0 was the seller's last command
    // BEFORE the version rotation; the Reactivate AFTER the
    // rotation wrote the new v1 activation. The helper picks
    // the newer event (activation at T_LATEST) so the
    // offering is NOT flagged as stale-confirmation.
    const effective = deriveEffectiveConfirmationVersion({
      latestActivation: {
        confirmationVersion: CURRENT_CONFIRMATION,
        occurredAt: T_LATEST,
      },
      latestUpdate: {
        confirmationVersion: STALE_CONFIRMATION,
        occurredAt: T_LATER,
      },
    });
    assert.equal(effective, CURRENT_CONFIRMATION);

    const r = deriveServiceOfferingReadiness(conformantInput({ confirmationVersion: effective }));
    assert.equal(r.isAvailable, true);
    assert.equal(
      r.updateNeeded,
      false,
      "newer reactivation supersedes older update; offering must NOT be Update needed",
    );
    assert.equal(
      r.reasonCategories.includes("activation-confirmation-stale"),
      false,
      "stale update evidence must not poison the readiness view",
    );
  });

  void test("Active + activation at v0 + no update IS stale-confirmation", () => {
    const effective = deriveEffectiveConfirmationVersion({
      latestActivation: {
        confirmationVersion: STALE_CONFIRMATION,
        occurredAt: T_BASE,
      },
      latestUpdate: null,
    });
    assert.equal(effective, STALE_CONFIRMATION);

    const r = deriveServiceOfferingReadiness(conformantInput({ confirmationVersion: effective }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.ok(r.reasonCategories.includes("activation-confirmation-stale"));
  });

  void test("Active + no activation + no update (Draft-only migration) IS stale-confirmation", () => {
    const effective = deriveEffectiveConfirmationVersion({
      latestActivation: null,
      latestUpdate: null,
    });
    assert.equal(effective, null);

    const r = deriveServiceOfferingReadiness(conformantInput({ confirmationVersion: effective }));
    assert.equal(r.isAvailable, true);
    assert.equal(r.updateNeeded, true);
    assert.ok(r.reasonCategories.includes("activation-confirmation-stale"));
  });
});
