/* eslint-disable @typescript-eslint/no-floating-promises */
// Matchmaker page contract tests.
//
// Background: ticket #60 ships the buyer-facing Matchmaker flow.
// The page submits the buyer's natural-language brief to
// /api/matchmaker/brief and renders the resulting eligibility-
// determined recommendations. These tests pin the React boundary
// contract at two layers:
//
//   1. Source-pattern tests pin the page's authoritative code
//      paths (DEFAULT_BRIEF wording, Buyer-capability filter,
//      wired submission, fallback notice element, fact-only
//      explanation rendering) so a refactor cannot silently
//      disconnect the buyer journey.
//
//   2. Runtime tests exercise the extracted
//      `submitBriefFromForm` test seam with a controlled fetch
//      (no live AI, no live database). The success path proves
//      the page actually posts the buyer workspace + brief text
//      AND records the returned recommendations (the page's
//      `setResponse` is exercised end to end). The rejection
//      path proves the page surfaces the error and resets
//      submitting so the form can be used again. Removing the
//      `setResponse(result)` call from the page's submit
//      handler would fail the runtime success test because the
//      recorded response state stays null.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Bg3SubmitBriefRequestV1, Bg3SubmitBriefResponseV1 } from "@soundhub/types";
import { bg3SubmitBriefResponseV1Schema } from "@soundhub/types";
import type { submitBrief as submitBriefFn } from "../lib/matchmaker-client";
import { submitBriefFromForm } from "./submit-brief-from-form.js";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}web`;

function readMatchmakerPage(): string {
  return readFileSync(`${repoRoot}/src/app/matchmaker/page.tsx`, "utf8");
}

// ---------- Runtime tests (controlled fetch) ----------

function buildResponse(override: Partial<Bg3SubmitBriefResponseV1> = {}): Bg3SubmitBriefResponseV1 {
  return {
    ok: true,
    brief: {
      briefId: "brief-runtime-1",
      actingWorkspaceId: "ws-buyer-runtime",
      createdByUserId: "user-runtime-buyer",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      criteria: { required: { primaryCategoryKeys: ["music-production"] } },
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
      createdAt: "2026-08-26T00:00:00.000Z",
      buyerWorkspace: {
        workspaceId: "ws-buyer-runtime",
        slug: "bg1-demo-buyer",
        name: "BG1 Demo Buyer",
      },
    },
    recommendations: [
      {
        sellerId: "seller-runtime-1",
        professionalName: "Marc-André Pierre",
        bestMatchingOfferingId: "of-runtime-1",
        relevanceScore: 0.9,
        explanations: [
          { kind: "matched-offering-title", label: "Matched the offering title" },
          { kind: "preferred-genre", label: "Preferred genre: Dancehall" },
        ],
        matchReason: "matched offering title; preferred genre: Dancehall",
        bestMatchingOffering: {
          offeringId: "of-runtime-1",
          title: "Haitian dancehall single production — remote",
          description: "Caribbean-flavored dancehall production.",
          primaryCategory: { key: "music-production", name: "Music Production" },
          includedServices: [],
          genreTags: ["Dancehall"],
          serviceMode: "Remote",
          serviceAreas: [{ city: "Brooklyn", region: "NY", countryCode: "US" }],
        },
        seller: {
          sellerId: "seller-runtime-1",
          professionalName: "Marc-André Pierre",
          specialties: ["Producer"],
          bio: "Brooklyn-based producer.",
          basedIn: { city: "Brooklyn", region: "NY", countryCode: "US" },
          caribbeanAffiliationCodes: ["HT"],
        },
        additionalMatchingOfferings: [],
      },
    ],
    totalResults: 1,
    strategy: "postgres-text-v1",
    fallbackNotice: "The AI interpretation used the deterministic fallback.",
    ...override,
  };
}

interface RecordedSubmission {
  readonly url: string;
  readonly body: Bg3SubmitBriefRequestV1;
}

let originalFetch: typeof fetch;
let recordedSubmissions: RecordedSubmission[];
let queuedResponse: Response | Error | null;

function installFetchStub(): void {
  originalFetch = globalThis.fetch;
  recordedSubmissions = [];
  queuedResponse = null;
  /* eslint-disable @typescript-eslint/require-await */
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: unknown = undefined;
    const rawBody = init?.body;
    if (typeof rawBody === "string" && rawBody.length > 0) {
      body = JSON.parse(rawBody);
    }
    recordedSubmissions.push({ url, body: body as Bg3SubmitBriefRequestV1 });
    if (queuedResponse instanceof Error) {
      throw queuedResponse;
    }
    if (queuedResponse instanceof Response) {
      return queuedResponse;
    }
    return new Response("{}", { status: 500 });
  };
  /* eslint-enable @typescript-eslint/require-await */
}

beforeEach(() => {
  installFetchStub();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("BG3 Matchmaker page runtime submit path", () => {
  test("a successful submission posts the buyer workspace + brief text and records the response", async () => {
    const controlled = buildResponse();
    queuedResponse = new Response(JSON.stringify(controlled), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const setErrorCalls: (string | null)[] = [];
    const setResponseCalls: (Bg3SubmitBriefResponseV1 | null)[] = [];
    const setSubmittingCalls: boolean[] = [];

    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-runtime",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: (value) => setErrorCalls.push(value),
      setResponse: (value) => setResponseCalls.push(value),
      setSubmitting: (value) => setSubmittingCalls.push(value),
    });

    // The runtime path emitted exactly one POST to the documented
    // endpoint with the buyer workspace + trimmed brief text. A
    // refactor that drops the workspace id or replaces the brief
    // text would fail this assertion.
    assert.equal(recordedSubmissions.length, 1);
    const recorded = recordedSubmissions[0]!;
    assert.equal(recorded.url, "/api/matchmaker/brief");
    assert.equal(recorded.body.actingWorkspaceId, "ws-buyer-runtime");
    assert.equal(
      recorded.body.briefText,
      "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
    );
    // The buyer Non-search requirements block is optional and the
    // page does not forward one, so the body must omit it.
    assert.equal(recorded.body.nonSearchRequirements, undefined);

    // The page receives the validated response and records it.
    // This is the assertion that fails if the page's submit
    // handler stops calling setResponse(result) — the recorded
    // state would stay null.
    // setError(null) is called once at the top of the seam to
    // clear stale state; the successful path does not invoke
    // setError again, so the array contains exactly one null.
    assert.equal(setErrorCalls.length, 1);
    assert.equal(setErrorCalls[0], null);
    // The handler clears any stale response before the fetch, so
    // two setResponse calls are expected: null (clear) and the
    // recorded response. The recorded value is the last entry.
    assert.equal(setResponseCalls.length, 2);
    const recordedResponse = setResponseCalls[1]!;
    bg3SubmitBriefResponseV1Schema.parse(recordedResponse);
    assert.equal(recordedResponse.totalResults, 1);
    assert.equal(recordedResponse.recommendations.length, 1);
    assert.equal(recordedResponse.recommendations[0]?.sellerId, "seller-runtime-1");

    // The submitting flag must toggle: true before the fetch, false
    // after. Without this, the submit button would never re-enable
    // and the buyer could not submit another brief.
    assert.deepEqual(setSubmittingCalls, [true, false]);
  });

  test("a failing submission surfaces the error and resets submitting so the form can be used again", async () => {
    queuedResponse = new Response(
      JSON.stringify({
        error: {
          code: "MATCHMAKER_INVALID_REQUEST",
          message: "ProjectBrief submission failed schema validation.",
          requestId: "req-runtime-1",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    const setErrorCalls: (string | null)[] = [];
    const setResponseCalls: (Bg3SubmitBriefResponseV1 | null)[] = [];
    const setSubmittingCalls: boolean[] = [];

    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-runtime",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: (value) => setErrorCalls.push(value),
      setResponse: (value) => setResponseCalls.push(value),
      setSubmitting: (value) => setSubmittingCalls.push(value),
    });

    // The fetch fired (the page attempts the request before
    // seeing the error), the response was discarded, and the
    // error message from the safe envelope was surfaced.
    assert.equal(recordedSubmissions.length, 1);
    // setError is called twice (null + the safe-envelope message).
    // setResponse is called once (null, BEFORE the fetch — the
    // catch block does not run setResponse because the fetch
    // throws before the success assignment). The submitting
    // flag toggles true → false.
    assert.equal(setResponseCalls.length, 1);
    assert.equal(setResponseCalls[0], null, "failed submission must not record a response");
    assert.equal(setErrorCalls.length, 2);
    assert.equal(setErrorCalls[0], null);
    assert.match(setErrorCalls[1] ?? "", /ProjectBrief submission failed schema validation/);
    assert.deepEqual(setSubmittingCalls, [true, false], "submitting flag must reset on failure");
  });

  test("a network failure surfaces the error and resets submitting", async () => {
    queuedResponse = new Error("network unreachable");
    const setErrorCalls: (string | null)[] = [];
    const setResponseCalls: (Bg3SubmitBriefResponseV1 | null)[] = [];
    const setSubmittingCalls: boolean[] = [];

    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-runtime",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: (value) => setErrorCalls.push(value),
      setResponse: (value) => setResponseCalls.push(value),
      setSubmitting: (value) => setSubmittingCalls.push(value),
    });

    // The network error throws inside the fetch before the
    // success branch runs. setError is called twice (null + the
    // thrown Error message). setResponse is called once (null,
    // before the fetch). The submitting flag toggles true →
    // false.
    assert.equal(setResponseCalls.length, 1);
    assert.equal(setResponseCalls[0], null);
    assert.equal(setErrorCalls.length, 2);
    assert.equal(setErrorCalls[0], null);
    assert.match(setErrorCalls[1] ?? "", /network unreachable/);
    assert.deepEqual(setSubmittingCalls, [true, false]);
  });

  test("missing workspace selection short-circuits with a validation error and no fetch", async () => {
    const setErrorCalls: (string | null)[] = [];
    const setResponseCalls: (Bg3SubmitBriefResponseV1 | null)[] = [];
    const setSubmittingCalls: boolean[] = [];

    await submitBriefFromForm({
      actingWorkspaceId: "",
      briefText: "I need a Brooklyn-based producer for a remote Haitian dancehall single.",
      setError: (value) => setErrorCalls.push(value),
      setResponse: (value) => setResponseCalls.push(value),
      setSubmitting: (value) => setSubmittingCalls.push(value),
    });

    assert.equal(
      recordedSubmissions.length,
      0,
      "must not issue a fetch without an acting workspace",
    );
    // Validation short-circuits before the fetch: setResponse is
    // called once (to clear stale state), setError is called
    // twice (null + the validation message), and no setSubmitting
    // transition occurs.
    assert.equal(setResponseCalls.length, 1);
    assert.equal(setResponseCalls[0], null);
    assert.equal(setErrorCalls.length, 2);
    assert.equal(setErrorCalls[0], null);
    assert.match(setErrorCalls[1] ?? "", /Pick an acting Workspace/);
    assert.deepEqual(
      setSubmittingCalls,
      [],
      "validation short-circuit must not toggle the submitting flag",
    );
  });

  test("an injection-mode submit function receives the buyer workspace + trimmed brief text", async () => {
    // The test seam accepts an injected submit function so the
    // UI test can validate the page's payload contract without
    // exercising the network. A refactor that drops the acting
    // workspace id or fails to trim the brief text would fail
    // this assertion.
    const captured: Bg3SubmitBriefRequestV1[] = [];
    /* eslint-disable @typescript-eslint/require-await */
    const fakeSubmit: typeof submitBriefFn = async (input) => {
      captured.push(input);
      return buildResponse();
    };
    /* eslint-enable @typescript-eslint/require-await */
    const setResponseCalls: (Bg3SubmitBriefResponseV1 | null)[] = [];

    await submitBriefFromForm({
      actingWorkspaceId: "ws-buyer-injected",
      briefText: "   Brooklyn-based producer for a remote Haitian dancehall single.   ",
      setError: () => {},
      setResponse: (value) => setResponseCalls.push(value),
      setSubmitting: () => {},
      submit: fakeSubmit,
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.actingWorkspaceId, "ws-buyer-injected");
    assert.equal(
      captured[0]!.briefText,
      "Brooklyn-based producer for a remote Haitian dancehall single.",
      "brief text must be trimmed before submission",
    );
    assert.equal(setResponseCalls.length, 2);
    const recordedResponse = setResponseCalls[1]!;
    bg3SubmitBriefResponseV1Schema.parse(recordedResponse);
  });
});

// ---------- Source-pattern contract tests ----------

describe("BG3 Matchmaker page source contract", () => {
  test("DEFAULT_BRIEF preserves the shipped Brooklyn-based phrasing (GS 14)", () => {
    // The buyer UI ships this exact brief text; the deterministic
    // adapter must recognise "Brooklyn-based" so the required
    // location survives interpretation. If a refactor changes the
    // phrasing, the deterministic adapter's LOCATION_PHRASES
    // table must keep up.
    const source = readMatchmakerPage();
    assert.match(
      source,
      /DEFAULT_BRIEF\s*=\s*"I need a Brooklyn-based producer[^"]*"/,
      "DEFAULT_BRIEF must use Brooklyn-based phrasing so the deterministic adapter preserves the required location",
    );
  });

  test("buyer submission delegates to the test seam and forwards actingWorkspaceId + briefText", () => {
    const source = readMatchmakerPage();
    // The page MUST route the form submit through the test seam
    // so the runtime UI test can exercise the full payload +
    // response + error handling path. Removing this delegation
    // would break the runtime UI test's success case.
    assert.match(
      source,
      /await submitBriefFromForm\(\{/,
      "buyer page must delegate to submitBriefFromForm test seam",
    );
    assert.match(
      source,
      /actingWorkspaceId,\s*briefText,\s*setError,\s*setResponse,\s*setSubmitting/,
      "buyer page must forward all five state setters + the form fields",
    );
  });

  test("buyer page filters workspaces by Buyer capability", () => {
    const source = readMatchmakerPage();
    assert.match(
      source,
      /capabilities\.includes\("Buyer"\)/,
      "buyer page must filter acting workspaces by Buyer capability",
    );
    assert.match(
      source,
      /data-testid="matchmaker-no-buyer-workspace"/,
      "buyer page must surface the empty-state when no Buyer-capable Workspace is available",
    );
  });

  test("buyer page surfaces AI provenance + fallback notice", () => {
    const source = readMatchmakerPage();
    assert.match(
      source,
      /data-testid="matchmaker-fallback-notice"/,
      "buyer page must surface the fallback notice when the deterministic fallback ran",
    );
    assert.match(
      source,
      /Provider: \{brief\.aiProvider\}[\s\S]*Fallback: \{brief\.aiFallbackUsed[^}]*\}/,
      "buyer page must render provider + fallback provenance on the persisted brief",
    );
  });

  test("buyer page renders factual explanations (no AI-invented text)", () => {
    const source = readMatchmakerPage();
    assert.match(
      source,
      /data-testid="matchmaker-explanation-item"/,
      "buyer page must render each explanation entry from the validated DTO",
    );
    assert.match(
      source,
      /recommendation\.explanations\.map\(/,
      "buyer page must drive the explanations list off the DTO, not a generated string",
    );
  });
});
