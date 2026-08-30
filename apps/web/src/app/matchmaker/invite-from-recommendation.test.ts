/* eslint-disable @typescript-eslint/no-floating-promises */
// Matchmaker invitation test seam.
//
// Background: the buyer-side selection step that converts a
// Matchmaker recommendation into a persisted ProjectRequest lives
// in this module so the focused UI test can exercise the runtime
// wiring (acting Workspace + brief + selected offering + response
// state + error rendering + submitting flag) with a controlled
// fetch. The page delegates to this function on click; the tests
// pin the contract end to end.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  CreateProjectRequestRequestV1,
  CreateProjectRequestResponseV1,
  MatchmakerRecommendationV1,
} from "@soundhub/types";
import { createProjectRequestResponseV1Schema } from "@soundhub/types";
import { inviteFromRecommendation } from "./invite-from-recommendation.js";
import type { createProjectRequest } from "../lib/project-requests-client";

const RECOMMENDATION: MatchmakerRecommendationV1 = {
  sellerId: "seller-1",
  professionalName: "Test Seller",
  bestMatchingOfferingId: "of-1",
  relevanceScore: 0.7,
  explanations: [],
  matchReason: "matched offering title",
  bestMatchingOffering: {
    offeringId: "of-1",
    title: "Test Offering",
    description: "Test offering description.",
    primaryCategory: { key: "music-production", name: "Music Production" },
    includedServices: [],
    genreTags: [],
    serviceMode: "Remote",
    serviceAreas: [],
  },
  seller: {
    sellerId: "seller-1",
    professionalName: "Test Seller",
    specialties: ["Producer"],
    bio: "Test seller bio.",
    basedIn: { countryCode: "US" },
    caribbeanAffiliationCodes: ["HT"],
  },
  additionalMatchingOfferings: [],
};

const SUCCESS_RESPONSE: CreateProjectRequestResponseV1 = {
  ok: true,
  projectRequest: {
    projectRequestId: "pr-1",
    buyerWorkspaceId: "ws-buyer",
    sellerWorkspaceId: "ws-seller",
    serviceOfferingId: "of-1",
    projectBriefId: "brief-1",
    status: "Pending",
    sellerDecisionAt: null,
    sellerConsentAt: null,
    createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
    buyerWorkspaceName: "Buyer Studio",
    sellerWorkspaceName: "Seller Studio",
    serviceOfferingTitle: "House mix",
    briefExcerpt: "Need a polished house mix for a Caribbean EP.",
  },
};

describe("inviteFromRecommendation", () => {
  test("forwards the correct payload and records success on a 2xx", async () => {
    const calls: CreateProjectRequestRequestV1[] = [];
    const invite = ((input: CreateProjectRequestRequestV1) => {
      calls.push(input);
      return Promise.resolve(SUCCESS_RESPONSE);
    }) as typeof createProjectRequest;

    let submitting = false;
    let error: string | null | undefined = null;
    let success: string | null | undefined = null;
    await inviteFromRecommendation({
      actingWorkspaceId: "ws-buyer",
      briefId: "brief-1",
      recommendation: RECOMMENDATION,
      setError: (msg) => {
        error = msg;
      },
      setSuccess: (msg) => {
        success = msg;
      },
      setSubmitting: (v) => {
        submitting = v;
      },
      invite,
    });

    assert.equal(submitting, false, "submitting flag must reset after success");
    assert.equal(error, null);
    assert.ok((success ?? "").includes("pr-1"));
    assert.equal(calls.length, 1);
    const parsed = createProjectRequestResponseV1Schema.safeParse(SUCCESS_RESPONSE);
    assert.equal(parsed.success, true);
    assert.equal(calls[0]!.actingWorkspaceId, "ws-buyer");
    assert.equal(calls[0]!.projectBriefId, "brief-1");
    assert.equal(calls[0]!.serviceOfferingId, "of-1");
  });

  test("surfaces an error message and does not call setSuccess on a typed rejection", async () => {
    const invite = (() => {
      return Promise.reject(
        Object.assign(new Error("Offering ineligible."), {
          code: "PROJECT_REQUEST_OFFERING_INELIGIBLE",
        }),
      );
    }) as typeof createProjectRequest;

    let submitting = false;
    let error: string | null | undefined = null;
    let success: string | null | undefined = null;
    await inviteFromRecommendation({
      actingWorkspaceId: "ws-buyer",
      briefId: "brief-1",
      recommendation: RECOMMENDATION,
      setError: (msg) => {
        error = msg;
      },
      setSuccess: (msg) => {
        success = msg;
      },
      setSubmitting: (v) => {
        submitting = v;
      },
      invite,
    });

    assert.equal(submitting, false);
    assert.equal(success, null);
    assert.ok((error ?? "").includes("ineligible"));
  });

  test("rejects when the acting Workspace is missing without calling the client", async () => {
    let called = false;
    const invite = (() => {
      called = true;
      return Promise.resolve(SUCCESS_RESPONSE);
    }) as typeof createProjectRequest;

    let error: string | null | undefined = null;
    await inviteFromRecommendation({
      actingWorkspaceId: "",
      briefId: "brief-1",
      recommendation: RECOMMENDATION,
      setError: (msg) => {
        error = msg;
      },
      setSuccess: () => {
        /* */
      },
      setSubmitting: () => {
        /* */
      },
      invite,
    });
    assert.equal(called, false);
    assert.ok((error ?? "").includes("acting Workspace"));
  });

  test("invokes onSessionInvalid on SESSION_INVALID so the SessionProvider can refresh", async () => {
    const invite = (() => {
      return Promise.reject(
        Object.assign(new Error("Sign in required."), { code: "SESSION_INVALID" }),
      );
    }) as typeof createProjectRequest;

    let refreshed = false;
    await inviteFromRecommendation({
      actingWorkspaceId: "ws-buyer",
      briefId: "brief-1",
      recommendation: RECOMMENDATION,
      setError: () => {
        /* */
      },
      setSuccess: () => {
        /* */
      },
      setSubmitting: () => {
        /* */
      },
      invite,
      onSessionInvalid: () => {
        refreshed = true;
      },
    });
    assert.equal(refreshed, true);
  });
});
