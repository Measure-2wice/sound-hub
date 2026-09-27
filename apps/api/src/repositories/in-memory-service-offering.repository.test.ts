// In-memory ServiceOfferingRepository tests.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InMemoryServiceOfferingRepository } from "./in-memory-service-offering.repository.js";

const WS_ID = "ws_test";
const SELLER_PROFILE_ID = "sp_test";

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
});
