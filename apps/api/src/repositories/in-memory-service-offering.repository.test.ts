// In-memory ServiceOfferingRepository tests.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InMemoryServiceOfferingRepository } from "./in-memory-service-offering.repository.js";

const WS_ID = "ws_test";
const SELLER_PROFILE_ID = "sp_test";
const ACTIVATED_BY = "user_test_activator";

function buildRepo(): InMemoryServiceOfferingRepository {
  const repo = new InMemoryServiceOfferingRepository();
  repo._seedOffering({
    id: "of_a",
    workspaceId: WS_ID,
    sellerProfileId: SELLER_PROFILE_ID,
    status: "Draft",
  });
  repo._seedOffering({
    id: "of_b",
    workspaceId: WS_ID,
    sellerProfileId: SELLER_PROFILE_ID,
    status: "Draft",
  });
  return repo;
}

const playbackUrl = (input: { offeringId: string; sampleId: string }) =>
  `https://api.test/${input.offeringId}/${input.sampleId}/play`;

void describe("InMemoryServiceOfferingRepository", () => {
  void test("per-offering mutex chain does NOT poison after a rejected saveDraft", async () => {
    const repo = buildRepo();
    await assert.rejects(
      repo.saveDraft({
        offeringId: "of_missing",
        workspaceId: WS_ID,
        title: "x",
        description: "x",
        primaryCategoryKey: null,
        serviceMode: null,
        serviceAreas: [],
        pricing: null,
        genreTags: [],
        includedServiceCategoryKeys: [],
        now: new Date(),
        playbackUrlFor: playbackUrl,
      }),
      (err: unknown) => (err as Error).name === "ServiceOfferingNotFoundError",
    );
    const ok = await repo.saveDraft({
      offeringId: "of_a",
      workspaceId: WS_ID,
      title: "Title",
      description: "Description",
      primaryCategoryKey: null,
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: null,
      genreTags: [],
      includedServiceCategoryKeys: [],
      now: new Date(),
      playbackUrlFor: playbackUrl,
    });
    assert.equal(ok.serviceOfferingId, "of_a");
    assert.equal(ok.title, "Title");
  });

  // Codex/Tenki Blocker 2 — the in-memory adapter's
  // `toOwnerView` must NOT leak the internal `activatedByUserId`
  // through the human-facing `activatedByDisplayName` DTO field.
  // The Prisma adapter resolves the related `UserAccount.email`
  // via the OFFERING_INCLUDE join; the in-memory adapter has no
  // trustworthy human-readable value to surface, so it returns
  // `null` (contract-consistent parity). The internal
  // `activatedByUserId` remains available on the stored
  // activation row for authorization / evidence and is never
  // serialized to the OwnerView.
  void test("activatedByDisplayName never exposes the raw internal user ID; returns null instead", async () => {
    const repo = buildRepo();
    // Seed a CONFIRMED Live sample so the activation
    // completeness recheck (requires 1-3 Live samples) passes.
    repo._seedSample("of_a", {
      sampleId: "smp_b2",
      label: "Blocker 2 Demo",
      byteSize: 4096,
      displayOrder: 1,
      storageRef: "ref://blocker-2",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: ACTIVATED_BY,
        confirmedAt: new Date(),
      },
    });
    const result = await repo.activate({
      offeringId: "of_a",
      workspaceId: WS_ID,
      sellerProfileId: SELLER_PROFILE_ID,
      activatedByUserId: ACTIVATED_BY,
      title: "Title",
      description: "Description",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: {
        kind: "StartingAt",
        amountMinor: 60000,
        currency: "USD",
        unitId: "per-track",
      },
      genreTags: [],
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
      requestId: "req-b2",
      playbackUrlFor: playbackUrl,
      now: new Date(),
    });
    // The activation MUST record the internal actor for
    // authorization / evidence — the field is preserved on
    // the stored activation row.
    // The stored activation evidence carries the internal
    // actor identifier (the same shape the Prisma adapter
    // persists on `service_offering_activations.activatedByUserId`).
    const storedActivations = repo._activationsForTest("of_a");
    assert.ok(storedActivations && storedActivations.length === 1);
    assert.equal(
      storedActivations[0]!.activatedByUserId,
      ACTIVATED_BY,
      "activation evidence must internally preserve the actor id",
    );
    // The OwnerView's `activatedByDisplayName` MUST NOT
    // expose that raw internal id. The previous
    // implementation assigned `row.activatedByUserId`
    // directly to the human-facing DTO field, leaking the
    // internal identifier. The fix returns `null` because
    // the in-memory store has no email / display-name to
    // resolve (parity with the Prisma path's
    // `latestActivation?.activatedBy?.email ?? null`).
    assert.equal(
      result.offering.activatedByDisplayName,
      null,
      "activatedByDisplayName must be null (never the raw internal user id)",
    );
    assert.notEqual(
      result.offering.activatedByDisplayName,
      ACTIVATED_BY,
      "activatedByDisplayName must NOT equal activatedByUserId — that would leak the internal id",
    );
    // Round-trip through the actual activation RESPONSE
    // schema (the route layer). The contract permits null;
    // any other value (e.g. a leaked user id) would either
    // fail the schema or — worse — succeed and expose the
    // internal identifier through a public DTO field.
    const { serviceOfferingActivationResponseV1Schema } = await import("@soundhub/types");
    const response = {
      ok: true as const,
      // Apply the service-layer Date→ISOString conversion
      // (`toResponseOwnerView`) so the response shape matches
      // the wire format the route layer sends. The repository
      // returns Date objects; the DTO requires ISO strings.
      offering: {
        ...result.offering,
        activatedAt: result.offering.activatedAt ? result.offering.activatedAt.toISOString() : null,
      },
      evidence: {
        ...result.evidence,
        activatedAt: result.evidence.activatedAt.toISOString(),
      },
      returnTo: null,
      safeReturnTo: null,
    };
    assert.doesNotThrow(
      () => serviceOfferingActivationResponseV1Schema.parse(response),
      "in-memory activation response must parse through serviceOfferingActivationResponseV1Schema",
    );
    assert.equal(
      serviceOfferingActivationResponseV1Schema.parse(response).offering.activatedByDisplayName,
      null,
      "in-memory OwnerView.activatedByDisplayName must be null per the DTO contract",
    );
  });
});
