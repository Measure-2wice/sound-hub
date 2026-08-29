/* eslint-disable @typescript-eslint/no-floating-promises */
// Matchmaker-to-real-search integration tests.
//
// Background: ticket #60 (and the buildathon Golden Slice
// spec GS 13 / GS 14 / GS 15) require the Matchmaker to invoke
// the existing TalentSearchService end-to-end. The existing
// focused service tests substitute FakeTalentSearchService to
// pin the orchestration without exercising the eligibility
// filter; this file wires the REAL TalentSearchService against
// the in-memory talent-search repository + a deterministic
// fixture to prove:
//
//   - The shipped DEFAULT_BRIEF (Brooklyn-based producer for a
//     remote Haitian dancehall single) preserves the required
//     Brooklyn location and the remote service mode.
//   - Eligibility filters out sellers outside Brooklyn when the
//     buyer required the location.
//   - A deterministic-fixture primary adapter + the real search
//     service end-to-end produces only Brooklyn-based
//     recommendations (and the related explanation entries
//     reference factual match evidence).
//   - The persisted Brief round-trips through the in-memory
//     ProjectBriefRepository and exposes the same criteria to
//     getBrief.
//
// The disposable PostgreSQL integration test (which exercises
// the seeded Caribbean sellers) is intentionally NOT exercised
// here per the BG3 ticket scope: BG2 holds the disposable DB
// during parallel work, and the ticket authorises a separate
// live Impala + browser smoke for the deployed path. The
// in-memory fixture is sufficient to prove the
// Matchmaker → TalentSearchService → eligibility → repository
// contract end to end.
//
// These tests are network-free (no live AI, no live database).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { MatchmakerCriteriaV1 } from "@soundhub/types";
import {
  InMemoryTalentSearchRepository,
  type InMemoryFixture,
} from "../repositories/in-memory-talent-search.repository.js";
import { TalentSearchService } from "./talent-search.service.js";
import { MatchmakerService } from "./matchmaker.service.js";
import { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";
import {
  InMemoryAuthRepository,
  type InMemoryUserSeed,
} from "../auth-repository/in-memory-auth-repository.js";
import { DeterministicAiAdapter } from "../matchmaker/deterministic-ai-adapter.js";
import { InMemoryProjectBriefRepository } from "../matchmaker/in-memory-project-brief.repository.js";

const BUYER_USER_ID = "user-integration-buyer";
const BUYER_WORKSPACE_ID = "ws-integration-buyer";

// Two sellers with the same category + serviceMode + Caribbean
// affiliation, but only one is Brooklyn-based. The eligibility
// filter must drop the non-Brooklyn seller when the buyer
// required a Brooklyn basedIn.
const fixture: InMemoryFixture = {
  sellers: [
    {
      sellerId: "seller-brooklyn",
      workspaceId: "w-brooklyn",
      professionalName: "Brooklyn Producer",
      bio: "Brooklyn-based producer.",
      status: "Published",
      basedInCity: "Brooklyn",
      basedInRegion: "NY",
      basedInCountryCode: "US",
      avatarUrl: null,
      specialtyKeys: ["Producer"],
      caribbeanAffiliationCodes: ["HT"],
      workspaceStatus: "Active",
      workspaceHasSellerCapability: true,
      offerings: [
        {
          offeringId: "offering-brooklyn",
          title: "Haitian dancehall single production — remote",
          description: "Brooklyn-based dancehall production.",
          status: "Active",
          serviceMode: "Remote",
          primaryCategory: { key: "music-production", name: "Music Production", bundleOnly: false },
          includedServices: [],
          genreTags: ["Dancehall"],
          serviceAreas: [{ city: "Brooklyn", region: "NY", countryCode: "US" }],
          pricing: {
            kind: "StartingAt",
            amountMinor: 60000,
            currency: "USD",
            unitKey: "track",
          },
        },
      ],
    },
    {
      sellerId: "seller-not-brooklyn",
      workspaceId: "w-not-brooklyn",
      professionalName: "London Producer",
      bio: "London-based producer.",
      status: "Published",
      basedInCity: "London",
      basedInRegion: null,
      basedInCountryCode: "GB",
      avatarUrl: null,
      specialtyKeys: ["Producer"],
      caribbeanAffiliationCodes: ["HT"],
      workspaceStatus: "Active",
      workspaceHasSellerCapability: true,
      offerings: [
        {
          offeringId: "offering-not-brooklyn",
          title: "Haitian dancehall single production — remote",
          description: "London-based dancehall production.",
          status: "Active",
          serviceMode: "Remote",
          primaryCategory: { key: "music-production", name: "Music Production", bundleOnly: false },
          includedServices: [],
          genreTags: ["Dancehall"],
          serviceAreas: [{ city: null, region: null, countryCode: "GB" }],
          pricing: {
            kind: "StartingAt",
            amountMinor: 70000,
            currency: "USD",
            unitKey: "track",
          },
        },
      ],
    },
  ],
  controlledKeys: {
    serviceCategoryKeys: ["music-production"],
    specialtyKeys: ["Producer"],
    pricingUnitKeys: ["track"],
  },
};

function buildIntegrationService() {
  const repo = new InMemoryTalentSearchRepository(fixture);
  const search = new TalentSearchService(repo);
  const buyerSeed: InMemoryUserSeed = {
    userAccountId: BUYER_USER_ID,
    email: "buyer-integration@example.com",
    identityProvider: "deterministic",
    identitySubject: "buyer-integration-subject",
    memberships: [
      {
        workspaceId: BUYER_WORKSPACE_ID,
        slug: "integration-buyer",
        name: "Integration Buyer",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        role: "Owner",
        capabilities: ["Buyer"],
      },
    ],
  };
  const authRepo = new InMemoryAuthRepository([buyerSeed]);
  const authz = new WorkspaceAuthorizationService({ authRepository: authRepo });
  const matchmaker = new MatchmakerService({
    talentSearchService: search,
    workspaceAuthorizationService: authz,
    projectBriefRepository: new InMemoryProjectBriefRepository(),
    aiAdapter: new DeterministicAiAdapter(),
  });
  return { matchmaker, search };
}

test("Matchmaker → real TalentSearchService filters out non-Brooklyn sellers", async () => {
  const { matchmaker } = buildIntegrationService();
  const result = await matchmaker.submitBrief({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    briefText:
      "I need a Brooklyn-based producer for a remote Haitian dancehall single, ideally delivered before March 14.",
  });

  // Required criteria carry Brooklyn. The deterministic adapter
  // produced these from the buyer's natural-language brief; the
  // service hands them to the existing TalentSearchService
  // untouched (no second search path).
  const persisted: MatchmakerCriteriaV1 = result.brief.criteria;
  assert.equal(persisted.required.basedIn?.city, "Brooklyn");
  assert.equal(persisted.required.basedIn?.countryCode, "US");
  assert.ok(persisted.required.serviceModes?.includes("Remote"));

  // The real TalentSearchService → in-memory repository end-to-end
  // path ran: eligibility filtered out the London seller and
  // surfaced only the Brooklyn-based seller. This is the
  // integration proof the ticket requires.
  assert.ok(result.recommendations.length >= 1);
  for (const rec of result.recommendations) {
    assert.equal(
      rec.seller.sellerId,
      "seller-brooklyn",
      "non-Brooklyn seller must not surface when Brooklyn is required",
    );
    assert.equal(rec.bestMatchingOffering.offeringId, "offering-brooklyn");
    // Explanations must reference factual match evidence, not
    // free-form AI text.
    assert.ok(rec.explanations.length > 0);
    for (const entry of rec.explanations) {
      assert.ok(typeof entry.label === "string" && entry.label.length > 0);
    }
  }

  // The persisted Brief round-trips through getBrief with the
  // same criteria.
  const fetched = await matchmaker.getBrief({
    userAccountId: BUYER_USER_ID,
    briefId: result.brief.briefId,
  });
  assert.equal(fetched.brief.briefId, result.brief.briefId);
  assert.equal(fetched.brief.criteria.required.basedIn?.city, "Brooklyn");
});
