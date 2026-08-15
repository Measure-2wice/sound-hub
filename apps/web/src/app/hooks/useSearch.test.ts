/* eslint-disable @typescript-eslint/no-floating-promises */
// `assert.equal(...)` returns `void` in @types/node but the project's
// flat config treats it as a floating promise; this file's assertions
// are pure synchronous comparisons and need the suppression above.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

// Unit tests for the `isRetriableErrorCode` predicate and the
// `dispatchSearch` stale-response guard.
//
// The `isRetriableErrorCode` predicate owns the buyer-facing decision
// of whether a given safe-envelope error code warrants a retry
// affordance. The page reads this exact function to render (or skip)
// the retry button; a refactor that adds or removes a code MUST
// update both this test and the page so the contract stays locked.
//
// The contract pins:
//   - 503 SEARCH_UNAVAILABLE → retriable (transient infra failure)
//   - 500 SEARCH_FAILED → retriable (recoverable on resubmission)
//   - 400 INVALID_SEARCH_CRITERIA / INVALID_JSON → NOT retriable
//     (the buyer's input must change before another submission
//     makes sense; the field-level error UI already guides them)
//   - 415 UNSUPPORTED_MEDIA_TYPE → NOT retriable (the request
//     format must change)
//   - 429 SEARCH_RATE_LIMITED → NOT retriable (the buyer must wait;
//     a retry would re-trigger the limit)
//   - null / unknown / empty → NOT retriable
//
// The `dispatchSearch` tests below pin the M1.6 contract that a stale
// (older) response cannot overwrite a newer rendered result. The
// fetch stub records but never honours the abort signal so the
// older fetch can resolve AFTER the newer response has been
// dispatched — exactly the ordering the prior browser coverage
// could not observe because `AbortController` short-circuited the
// older fetch before its response could reach the dispatch pipeline.
// These tests therefore act as the mutation check for the
// `requestIdRef.current !== currentRequest` guards: removing those
// guards would let the older response overwrite the newer payload.

import {
  apiErrorResponseV1Schema,
  talentSearchResponseV1Schema,
  type TalentSearchResponseV1,
} from "@soundhub/types";
import { dispatchSearch, isRetriableErrorCode, type DispatchSearchCallbacks } from "./useSearch";

describe("isRetriableErrorCode", () => {
  test("returns true for SEARCH_UNAVAILABLE", () => {
    assert.equal(isRetriableErrorCode("SEARCH_UNAVAILABLE"), true);
  });

  test("returns true for SEARCH_FAILED", () => {
    assert.equal(isRetriableErrorCode("SEARCH_FAILED"), true);
  });

  test("returns false for INVALID_SEARCH_CRITERIA", () => {
    assert.equal(isRetriableErrorCode("INVALID_SEARCH_CRITERIA"), false);
  });

  test("returns false for INVALID_JSON", () => {
    assert.equal(isRetriableErrorCode("INVALID_JSON"), false);
  });

  test("returns false for UNSUPPORTED_MEDIA_TYPE", () => {
    assert.equal(isRetriableErrorCode("UNSUPPORTED_MEDIA_TYPE"), false);
  });

  test("returns false for SEARCH_RATE_LIMITED", () => {
    assert.equal(isRetriableErrorCode("SEARCH_RATE_LIMITED"), false);
  });

  test("returns false for null", () => {
    assert.equal(isRetriableErrorCode(null), false);
  });

  test("returns false for an unknown code", () => {
    assert.equal(isRetriableErrorCode("SOMETHING_NEW"), false);
  });
});

// Build a fake `Response`-shaped object whose `json()` resolves with
// the supplied body and whose `headers.get("x-request-id")` reads
// from a `Map`-backed header bag. The dispatch helper reads the
// `x-request-id` header via `response.headers.get(...)` so a Map
// lookup with the case-insensitive key is required.
function makeFakeResponse(body: unknown, options: { ok?: boolean; requestId?: string } = {}) {
  const ok = options.ok ?? true;
  const headers = new Map<string, string>();
  if (options.requestId !== undefined) headers.set("x-request-id", options.requestId);
  return {
    ok,
    status: ok ? 200 : 503,
    statusText: ok ? "OK" : "Service Unavailable",
    headers: {
      get(name: string): string | null {
        const lower = name.toLowerCase();
        for (const [key, value] of headers) {
          if (key.toLowerCase() === lower) return value;
        }
        return null;
      },
    },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Sample success payload using the public v1 contract so the parse
// step takes the real schema path. The seller name is what each test
// uses to assert which response "won".
const olderPayload: TalentSearchResponseV1 = {
  results: [
    {
      seller: {
        sellerId: "seller-older",
        professionalName: "Older Seller",
        specialties: ["Producer"],
        bio: "",
        basedIn: { countryCode: "HT" },
        caribbeanAffiliationCodes: ["HT"],
      },
      bestMatchingOffering: {
        offeringId: "offering-older",
        title: "Older offering",
        description: "",
        primaryCategory: { key: "music-production", name: "Music production" },
        includedServices: [],
        genreTags: [],
        serviceMode: "Remote",
        serviceAreas: [{ countryCode: "HT" }],
        pricing: {
          kind: "StartingAt",
          amount: { amountMinor: 10000, currency: "USD" },
          unit: "per-song",
        },
      },
      additionalMatchingOfferings: [],
      matchReason: "Older match",
      relevanceScore: 0.5,
    },
  ],
  metadata: {
    normalizedQuery: "older",
    totalResults: 1,
    processingTimeMs: 1,
    strategy: "postgres-text-v1",
    appliedRequiredCriteria: {},
    appliedPreferredCriteria: {},
  },
};

const newerPayload: TalentSearchResponseV1 = {
  results: [
    {
      ...olderPayload.results[0]!,
      seller: {
        ...olderPayload.results[0]!.seller,
        sellerId: "seller-newer",
        professionalName: "Newer Seller",
      },
      bestMatchingOffering: {
        ...olderPayload.results[0]!.bestMatchingOffering,
        offeringId: "offering-newer",
        title: "Newer offering",
      },
      matchReason: "Newer match",
      relevanceScore: 0.9,
    },
  ],
  metadata: {
    ...olderPayload.metadata,
    normalizedQuery: "newer",
  },
};

const deps = {
  fetch: () => Promise.resolve(makeFakeResponse(newerPayload)),
  parseSuccess: (data: unknown) => {
    const parsed = talentSearchResponseV1Schema.safeParse(data);
    return parsed.success ? parsed.data : null;
  },
  parseError: (data: unknown) => {
    const parsed = apiErrorResponseV1Schema.safeParse(data);
    return parsed.success ? parsed.data.error : null;
  },
};

describe("dispatchSearch stale-response guard", () => {
  test("a later-arriving older response cannot overwrite the newer rendered result", async () => {
    // Two pending fetches, each controlled by an external resolver.
    // The fetch stub records but never honours the abort signal so
    // the older response can be made to settle AFTER the newer
    // response has dispatched — the exact ordering the browser
    // concurrency test cannot reproduce because abort cancels the
    // older fetch before its response reaches the pipeline.
    let olderResolver: (response: Response) => void = () => {};
    let newerResolver: (response: Response) => void = () => {};
    const olderPromise = new Promise<Response>((resolve) => {
      olderResolver = resolve;
    });
    const newerPromise = new Promise<Response>((resolve) => {
      newerResolver = resolve;
    });
    let fetchCall = 0;
    const observedAbortSignals: AbortSignal[] = [];
    const fetchStub: typeof fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      fetchCall += 1;
      const signal = init?.signal ?? null;
      if (signal) observedAbortSignals.push(signal);
      const responsePromise = fetchCall === 1 ? olderPromise : newerPromise;
      return responsePromise;
    };

    // Capture every callback the pipeline emits so the assertions
    // can prove the older response never produced a state-mutating
    // dispatch after the newer response landed.
    const observedResults: string[] = [];
    const observedErrors: string[] = [];
    const observedLoadingChanges: boolean[] = [];
    const callbacks: DispatchSearchCallbacks = {
      onResults: (results) => {
        observedResults.push(results.results[0]!.seller.professionalName);
      },
      onError: (params) => {
        observedErrors.push(params.code);
      },
      onLoadingChange: (loading) => {
        observedLoadingChanges.push(loading);
      },
    };

    // Simulate the hook's monotonic counter AND its abort-the-previous-
    // controller behavior. Each search increments the counter;
    // `isStale` returns true when the counter has moved past the
    // request id captured at submission time. The older controller
    // is aborted when the newer search starts so the model mirrors
    // the production hook exactly.
    let currentRequest = 0;
    const olderId = ++currentRequest;
    const olderController = new AbortController();
    const olderDispatch = dispatchSearch(
      { query: "older" },
      olderController.signal,
      () => currentRequest !== olderId,
      { fetch: fetchStub, parseSuccess: deps.parseSuccess, parseError: deps.parseError },
      callbacks,
    );

    const newerId = ++currentRequest;
    // Mirror the hook's `abortControllerRef.current.abort()` before
    // assigning the newer controller — the older controller's signal
    // is now aborted, but the fetch stub ignores it so the older
    // promise can still resolve with a real response later.
    olderController.abort();
    const newerController = new AbortController();
    const newerDispatch = dispatchSearch(
      { query: "newer" },
      newerController.signal,
      () => currentRequest !== newerId,
      { fetch: fetchStub, parseSuccess: deps.parseSuccess, parseError: deps.parseError },
      callbacks,
    );

    // Resolve the NEWER response first. The newer request is still
    // current, so its response must dispatch.
    newerResolver(makeFakeResponse(newerPayload, { requestId: "newer-req" }));
    await newerDispatch;
    assert.deepEqual(observedResults, ["Newer Seller"]);

    // Resolve the OLDER response second. The hook has already moved
    // on to the newer request (and could move on further); the
    // older request's id is no longer the active one, so the
    // pipeline must drop the older payload WITHOUT invoking
    // `onResults` or `onLoadingChange(false)`. The fetch is allowed
    // to have received an abort signal (the hook will have aborted
    // the older controller on the newer submission), but the
    // stub ignored it so the response still resolves.
    olderResolver(makeFakeResponse(olderPayload, { requestId: "older-req" }));
    await olderDispatch;

    // The newer payload must remain the only observed result. A
    // regression that drops the `isStale()` guards would either
    // append the older payload to `observedResults` or replace the
    // last entry — both diverge from the expected array.
    assert.deepEqual(observedResults, ["Newer Seller"]);
    assert.deepEqual(observedErrors, []);

    // The older resolution must not have cleared the newer
    // request's loading state: the newer request is the active
    // one, so its own success path produced exactly one
    // `onLoadingChange(false)`. An older resolution that cleared
    // loading prematurely would either inject a second
    // `onLoadingChange(false)` (for the older request) or omit
    // the newer request's clear entirely.
    assert.deepEqual(observedLoadingChanges, [false]);

    // The hook aborted the older controller on the newer submission
    // (mirroring `abortControllerRef.current.abort()`), and the
    // newer controller remained un-aborted. This proves the test
    // exercised the same abort-before-fetch ordering the real
    // hook uses, AND the fetch stub demonstrably ignored the
    // older abort — the older dispatch did not throw, did not
    // reject, and completed after the response was released.
    assert.equal(observedAbortSignals.length, 2);
    assert.equal(observedAbortSignals[0]!.aborted, true);
    assert.equal(observedAbortSignals[1]!.aborted, false);
  });

  test("the active request's loading state is cleared by its OWN response, not by a stale resolution", async () => {
    // Single-flight variant of the above: a stale error response
    // arriving after a newer success response must not flip loading
    // back to false via the stale path, and must not overwrite the
    // newer results with an error envelope.
    let olderErrorResolver: (response: Response) => void = () => {};
    let newerResolver: (response: Response) => void = () => {};
    const olderErrorPromise = new Promise<Response>((resolve) => {
      olderErrorResolver = resolve;
    });
    const newerPromise = new Promise<Response>((resolve) => {
      newerResolver = resolve;
    });
    let fetchCall = 0;
    const fetchStub: typeof fetch = async (): Promise<Response> => {
      fetchCall += 1;
      return fetchCall === 1 ? olderErrorPromise : newerPromise;
    };

    const observedResults: string[] = [];
    const observedErrors: string[] = [];
    const observedLoadingChanges: boolean[] = [];
    const callbacks: DispatchSearchCallbacks = {
      onResults: (results) => observedResults.push(results.results[0]!.seller.professionalName),
      onError: (params) => observedErrors.push(params.code),
      onLoadingChange: (loading) => observedLoadingChanges.push(loading),
    };

    let currentRequest = 0;
    const olderId = ++currentRequest;
    const newerId = ++currentRequest;
    const olderStale = () => currentRequest !== olderId;
    const newerStale = () => currentRequest !== newerId;

    const olderDispatch = dispatchSearch(
      { query: "older" },
      new AbortController().signal,
      olderStale,
      { fetch: fetchStub, parseSuccess: deps.parseSuccess, parseError: deps.parseError },
      callbacks,
    );
    const newerDispatch = dispatchSearch(
      { query: "newer" },
      new AbortController().signal,
      newerStale,
      { fetch: fetchStub, parseSuccess: deps.parseSuccess, parseError: deps.parseError },
      callbacks,
    );

    // Newer success lands first.
    newerResolver(makeFakeResponse(newerPayload));
    await newerDispatch;
    assert.deepEqual(observedResults, ["Newer Seller"]);

    // Older 503 envelope lands second. Must be dropped.
    olderErrorResolver(
      makeFakeResponse(
        {
          error: {
            code: "SEARCH_UNAVAILABLE",
            message: "stale",
            requestId: "older-error-req",
          },
        },
        { ok: false, requestId: "older-error-req" },
      ),
    );
    await olderDispatch;

    // No error envelope, no overwrite, exactly one loading-clear.
    assert.deepEqual(observedResults, ["Newer Seller"]);
    assert.deepEqual(observedErrors, []);
    assert.deepEqual(observedLoadingChanges, [false]);
  });
});
