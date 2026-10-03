/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */

// ServiceOffering lifecycle contracts.
//
// Verifies the durable, domain-oriented contracts that gate the
// ServiceOffering lifecycle (Active → Paused, Paused → Active,
// Active → Active update, final-sample removal). Each test asserts
// observable schema / type behaviour without exercising any
// unimplemented runtime command:
//   1. The lifecycle error codes parse through the closed error-code
//      enum and `mapStatus` returns the documented HTTP status.
//   2. The Pause request schema accepts ONLY a UUID idempotencyKey
//      and rejects every other field (strict mode is enforced).
//   3. The Reactivate / updateActive request shapes reuse the
//      existing STRICT activation schema instance rather than
//      reimplementing the field rules.
//   4. The audio remove request schema accepts the transient
//      eligibility-loss confirmation flag and that flag is NOT
//      exposed on the persisted public DTO.
//   5. Pause evidence records no activation confirmationVersion.
//   6. Update evidence supports per-offering idempotency and the
//      OwnerView's original activation timestamp is preserved
//      across an Active → Active update.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  apiErrorCodeV1Schema,
  bg2AudioSampleRemoveRequestV1Schema,
  bg2AudioSampleRemoveResponseV1Schema,
  serviceOfferingActivateRequestV1Schema,
  serviceOfferingPauseEvidenceV1Schema,
  serviceOfferingPauseRequestV1Schema,
  serviceOfferingPauseResponseV1Schema,
  serviceOfferingReactivateRequestV1Schema,
  serviceOfferingUpdateEvidenceV1Schema,
  serviceOfferingUpdateRequestV1Schema,
  serviceOfferingUpdateResponseV1Schema,
  type ApiErrorCodeV1,
} from "@soundhub/types";
import { mapStatus } from "../lib/errors.js";

// `mapStatus` is exported from `errors.ts`; the test file lives in
// the same package. The cast preserves the stable signature.
type MapStatusFn = (code: ApiErrorCodeV1) => number;
const getStatus = mapStatus as unknown as MapStatusFn;

describe("ServiceOffering lifecycle contracts", () => {
  test("lifecycle error codes are part of the closed error-code enum", () => {
    const lifecycleCodes: readonly ApiErrorCodeV1[] = [
      "SERVICE_OFFERING_ALREADY_PAUSED",
      "SERVICE_OFFERING_NOT_PAUSED",
      "SERVICE_OFFERING_NOT_ACTIVE",
      "SERVICE_OFFERING_INVALID_UPDATE",
      "AUDIO_SAMPLE_FINAL_REMOVAL_CONFIRMATION_REQUIRED",
    ];
    for (const code of lifecycleCodes) {
      const parsed = apiErrorCodeV1Schema.parse(code);
      assert.equal(parsed, code);
    }
  });

  test("lifecycle error codes map to the documented HTTP statuses", () => {
    assert.equal(getStatus("SERVICE_OFFERING_ALREADY_PAUSED"), 409);
    assert.equal(getStatus("SERVICE_OFFERING_NOT_PAUSED"), 409);
    assert.equal(getStatus("SERVICE_OFFERING_NOT_ACTIVE"), 409);
    assert.equal(getStatus("SERVICE_OFFERING_INVALID_UPDATE"), 422);
    assert.equal(getStatus("AUDIO_SAMPLE_FINAL_REMOVAL_CONFIRMATION_REQUIRED"), 400);
  });

  test("pause request accepts only a UUID idempotencyKey", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    const parsed = serviceOfferingPauseRequestV1Schema.parse({
      idempotencyKey: validUuid,
    });
    assert.equal(parsed.idempotencyKey, validUuid);

    // Missing field is rejected.
    assert.throws(() => serviceOfferingPauseRequestV1Schema.parse({}));

    // Empty string is rejected.
    assert.throws(() => serviceOfferingPauseRequestV1Schema.parse({ idempotencyKey: "" }));

    // Non-UUID is rejected.
    assert.throws(() =>
      serviceOfferingPauseRequestV1Schema.parse({ idempotencyKey: "not-a-uuid" }),
    );
  });

  test("pause request rejects unknown fields including returnTo", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    // `returnTo` was a candidate redirect hint; the strict schema rejects
    // it. If a future slice requires post-command navigation, the field
    // must be added intentionally to the schema rather than smuggled in.
    assert.throws(() =>
      serviceOfferingPauseRequestV1Schema.parse({
        idempotencyKey: validUuid,
        returnTo: "/dashboard",
      }),
    );
    // Any arbitrary additional field is also rejected.
    assert.throws(() =>
      serviceOfferingPauseRequestV1Schema.parse({
        idempotencyKey: validUuid,
        extra: "nope",
      }),
    );
  });

  test("reactivate request shape reuses the STRICT activation schema instance", () => {
    assert.strictEqual(
      serviceOfferingReactivateRequestV1Schema,
      serviceOfferingActivateRequestV1Schema,
      "Reactivate must reuse the activation schema instance — divergent " +
        "rules would introduce two STRICT contracts and the repository " +
        "recheck would silently drift.",
    );
  });

  test("updateActive request shape reuses the STRICT activation schema instance", () => {
    assert.strictEqual(
      serviceOfferingUpdateRequestV1Schema,
      serviceOfferingActivateRequestV1Schema,
      "updateActive must reuse the activation schema instance — divergent " +
        "rules would introduce two STRICT contracts and the repository " +
        "recheck would silently drift.",
    );
  });

  test("audio removal confirmation is request-only and not persisted", () => {
    const parsed = bg2AudioSampleRemoveRequestV1Schema.parse({
      actingWorkspaceId: "ws-1",
      confirmEligibilityLoss: true,
    });
    assert.equal(parsed.actingWorkspaceId, "ws-1");
    assert.equal(parsed.confirmEligibilityLoss, true);

    // Omitting the flag is accepted (transient field is optional).
    const noFlag = bg2AudioSampleRemoveRequestV1Schema.parse({
      actingWorkspaceId: "ws-2",
    });
    assert.equal(noFlag.confirmEligibilityLoss, undefined);

    // Unknown fields are rejected (strict mode).
    assert.throws(() =>
      bg2AudioSampleRemoveRequestV1Schema.parse({
        actingWorkspaceId: "ws-3",
        confirmationVersion: "m2-audio-confirmation-v1",
      }),
    );

    // The remove response schema must NOT include the eligibility-loss
    // flag — it is transient and never crosses the public DTO boundary.
    // M2 (#86, slice 86F PR feedback): assert against the RESPONSE
    // schema (not the request schema) so the test proves the
    // boundary it claims to prove. A request-only field is
    // trivially absent from any response that doesn't carry it.
    const responseKeys = Object.keys(
      bg2AudioSampleRemoveResponseV1Schema.parse({
        ok: true,
        sampleId: "of-1-seed",
        offeringId: "of-1",
        removedAt: "2026-09-27T13:00:00.000Z",
      }),
    );
    assert.equal(
      responseKeys.includes("confirmEligibilityLoss"),
      false,
      "the remove response schema must not expose confirmEligibilityLoss — it is request-only",
    );
    assert.ok(responseKeys.includes("sampleId"));
    assert.ok(responseKeys.includes("offeringId"));
    assert.ok(responseKeys.includes("removedAt"));
    assert.ok(responseKeys.includes("ok"));
  });

  test("pause evidence excludes activation confirmation", () => {
    // The Pause evidence shape records only the facts established by
    // the Pause command: pausedAt + reason + idempotencyKey. Pause
    // authorization is independent of activation completeness, so no
    // activation confirmationVersion is recorded — fabricating such a
    // column would invent an attestation the Pause command did not invoke.
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    const evidence = serviceOfferingPauseEvidenceV1Schema.parse({
      pausedAt: new Date().toISOString(),
      reason: "user_initiated",
      idempotencyKey: validUuid,
    });
    assert.equal(evidence.reason, "user_initiated");
    assert.equal(evidence.idempotencyKey, validUuid);
    assert.equal(evidence.pausedAt.length > 0, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(evidence, "confirmationVersion"),
      false,
      "pause evidence must not record an activation confirmationVersion",
    );
  });

  test("update evidence supports per-offering idempotency", () => {
    // The Update evidence carries confirmationVersion (because
    // updateActive re-runs the activation contract) and the idempotency
    // key that binds the (offeringId, idempotencyKey) unique index for
    // durable same-key retry convergence.
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    const evidence = serviceOfferingUpdateEvidenceV1Schema.parse({
      updatedAt: new Date().toISOString(),
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: validUuid,
    });
    assert.equal(evidence.confirmationVersion, "m2-service-activation-v1");
    assert.equal(evidence.idempotencyKey, validUuid);
  });

  test("pause response wraps the OwnerView and the pause evidence", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    const evidence = serviceOfferingPauseEvidenceV1Schema.parse({
      pausedAt: new Date().toISOString(),
      reason: "user_initiated",
      idempotencyKey: validUuid,
    });
    const sampleOffering = {
      serviceOfferingId: "so-1",
      workspaceId: "ws-1",
      sellerProfileId: "sp-1",
      status: "Paused" as const,
      title: "Haitian dancehall single production",
      description: "Remote production of one dancehall single.",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote" as const,
      serviceAreas: [],
      pricing: null,
      genreTags: ["Dancehall"],
      includedServiceCategoryKeys: [],
      samples: [],
      activatedAt: null,
      activatedByDisplayName: null,
      readiness: {
        isAvailable: false,
        updateNeeded: false,
        reasonCategories: [],
        isGrandfatheredNonconforming: false,
      },
    };
    const full = serviceOfferingPauseResponseV1Schema.parse({
      ok: true,
      offering: sampleOffering,
      evidence,
      returnTo: null,
      safeReturnTo: null,
    });
    assert.equal(full.offering.status, "Paused");
    assert.equal(full.evidence.reason, "user_initiated");
    assert.equal(full.offering.readiness.isAvailable, false);
  });

  test("update response preserves the original activation timestamp on the OwnerView", () => {
    // A successful Active → Active update must NOT rewrite activation
    // evidence; the OwnerView's `activatedAt` / `activatedByDisplayName`
    // continue to reflect the original activation moment per ADR 0008.
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    const parsedEvidence = serviceOfferingUpdateEvidenceV1Schema.parse({
      updatedAt: new Date().toISOString(),
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: validUuid,
    });
    const sampleOffering = {
      serviceOfferingId: "so-1",
      workspaceId: "ws-1",
      sellerProfileId: "sp-1",
      status: "Active" as const,
      title: "Haitian dancehall single production",
      description: "Remote production of one dancehall single.",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote" as const,
      serviceAreas: [],
      pricing: null,
      genreTags: ["Dancehall"],
      includedServiceCategoryKeys: [],
      samples: [],
      activatedAt: "2026-09-27T12:00:00.000Z",
      activatedByDisplayName: "creole@example.com",
      readiness: {
        isAvailable: true,
        updateNeeded: false,
        reasonCategories: [],
        isGrandfatheredNonconforming: false,
      },
    };
    const full = serviceOfferingUpdateResponseV1Schema.parse({
      ok: true,
      offering: sampleOffering,
      evidence: parsedEvidence,
      returnTo: null,
      safeReturnTo: null,
    });
    assert.equal(full.offering.status, "Active");
    assert.equal(full.offering.activatedAt, "2026-09-27T12:00:00.000Z");
    assert.equal(full.offering.activatedByDisplayName, "creole@example.com");
    assert.equal(full.evidence.idempotencyKey, validUuid);
  });
});
