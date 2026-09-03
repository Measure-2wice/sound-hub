/* eslint-disable @typescript-eslint/no-floating-promises */
// DealTerms route-helpers unit tests (BG5).
//
// Background: ticket #63 requires the BG5 route helpers to surface
// every typed `DealTermsError` through the shared safe envelope and
// to refuse unsigned requests. These tests exercise the envelope
// translation + session helpers without booting Express — no
// source-pattern assertions, no JSDOM.

import { test } from "node:test";
import type { Request, Response } from "express";
import assert from "node:assert/strict";
import {
  readDealTermsPathParam,
  readDealTermsQueryParam,
  translateDealTermsServiceError,
  resolveDealTermsRequestId,
} from "./deal-terms-route-helpers.js";
import { DealTermsError } from "../deal-terms/deal-terms.service.js";

function makeRes() {
  const state: { status: number; body: unknown; headers: Record<string, string> } = {
    status: 0,
    body: null,
    headers: {},
  };
  const res: Record<string, unknown> = {};
  res["setHeader"] = (name: string, value: string) => {
    state.headers[name] = value;
  };
  res["status"] = (code: number) => {
    state.status = code;
    (res as { json: (payload: unknown) => void })["json"] = (payload: unknown) => {
      state.body = payload;
    };
    return res;
  };
  res["json"] = (payload: unknown) => {
    state.body = payload;
  };
  Object.defineProperty(res, "writableEnded", {
    get: () => state.status > 0,
  });
  return {
    res: res as unknown as Response,
    get status() {
      return state.status;
    },
    get body() {
      return state.body;
    },
    get headers() {
      return state.headers;
    },
  };
}

test("resolveDealTermsRequestId reads the inbound x-request-id header verbatim", () => {
  const req = { headers: { "x-request-id": "rid-abc" } } as unknown as Request;
  assert.equal(resolveDealTermsRequestId(req), "rid-abc");
});

test("resolveDealTermsRequestId falls back to a generated id when no header is supplied", () => {
  const req = { headers: {} } as unknown as Request;
  const id = resolveDealTermsRequestId(req);
  assert.match(id, /^[0-9a-f-]{36}$/);
});

test("readDealTermsPathParam surfaces BG5_DEAL_NOT_FOUND when missing", () => {
  const mock = makeRes();
  const result = readDealTermsPathParam(
    mock.res,
    { params: {} } as unknown as Request,
    "dealId",
    "rid-1",
  );
  assert.equal(result, null);
  assert.equal(mock.status, 404);
});

test("readDealTermsQueryParam surfaces BG5_TERMS_DRAFT_INVALID when missing", () => {
  const mock = makeRes();
  const result = readDealTermsQueryParam(
    mock.res,
    { query: {} } as unknown as Request,
    "actingWorkspaceId",
    "rid-2",
  );
  assert.equal(result, null);
  assert.equal(mock.status, 400);
});

test("translateDealTermsServiceError translates BG5_DEAL_NOT_FOUND to 404", () => {
  const mock = makeRes();
  const handled = translateDealTermsServiceError(
    mock.res,
    new DealTermsError("not found", "BG5_DEAL_NOT_FOUND"),
    "rid-3",
  );
  assert.equal(handled, true);
  assert.equal(mock.status, 404);
});

test("translateDealTermsServiceError translates BG5_TERMS_DRAFT_FORBIDDEN to 403", () => {
  const mock = makeRes();
  const handled = translateDealTermsServiceError(
    mock.res,
    new DealTermsError("forbidden", "BG5_TERMS_DRAFT_FORBIDDEN"),
    "rid-4",
  );
  assert.equal(handled, true);
  assert.equal(mock.status, 403);
});

test("translateDealTermsServiceError translates BG5_APPROVAL_NOT_CURRENT_VERSION to 422", () => {
  const mock = makeRes();
  const handled = translateDealTermsServiceError(
    mock.res,
    new DealTermsError("stale version", "BG5_APPROVAL_NOT_CURRENT_VERSION"),
    "rid-5",
  );
  assert.equal(handled, true);
  assert.equal(mock.status, 422);
});

test("translateDealTermsServiceError translates BG5_APPROVAL_ALREADY_RECORDED to 409", () => {
  const mock = makeRes();
  const handled = translateDealTermsServiceError(
    mock.res,
    new DealTermsError("dup", "BG5_APPROVAL_ALREADY_RECORDED"),
    "rid-6",
  );
  assert.equal(handled, true);
  assert.equal(mock.status, 409);
});

test("translateDealTermsServiceError translates BG5_DEAL_UNAVAILABLE to 503", () => {
  const mock = makeRes();
  const handled = translateDealTermsServiceError(
    mock.res,
    new DealTermsError("retry", "BG5_DEAL_UNAVAILABLE"),
    "rid-7",
  );
  assert.equal(handled, true);
  assert.equal(mock.status, 503);
});

test("translateDealTermsServiceError returns false for non-DealTermsError inputs", () => {
  const mock = makeRes();
  const handled = translateDealTermsServiceError(mock.res, new Error("not ours"), "rid-8");
  assert.equal(handled, false);
});

// ---------------------------------------------------------------------------
// P1-002: AI validation failures must produce a typed
// BG5_TERMS_DRAFT_INVALID envelope with a generic public-safe
// message. The public envelope must NOT carry the provider key,
// the Zod issue path, the expected/received type, or any raw
// candidate detail. Detailed diagnostics live only in the
// existing `console.error` server logging seam (asserted in the
// service test, not here).
// ---------------------------------------------------------------------------

test("P1-002: AI validation failure → 400 BG5_TERMS_DRAFT_INVALID with generic public-safe message", () => {
  const mock = makeRes();
  const handled = translateDealTermsServiceError(
    mock.res,
    new DealTermsError("The drafted terms were invalid.", "BG5_TERMS_DRAFT_INVALID"),
    "rid-9",
  );
  assert.equal(handled, true);
  assert.equal(mock.status, 400);
  // The body is a single field per the safe envelope schema: code
  // + message + requestId. The message must be the public-safe
  // string and must NOT include provider identity, Zod terminology,
  // field paths, or raw candidate values.
  const body = mock.body as { error: { code: string; message: string; requestId: string } };
  assert.equal(body.error.code, "BG5_TERMS_DRAFT_INVALID");
  assert.equal(body.error.message, "The drafted terms were invalid.");
  assert.equal(body.error.requestId, "rid-9");
  // The serialized body must contain only the public-safe fields;
  // nothing else.
  const json = JSON.stringify(body);
  for (const forbidden of [
    "provider",
    "impala",
    "deterministic-fallback",
    "ZodError",
    "expected",
    "received",
    "scope:",
    "deliverables:",
    "price:",
    "rogueField",
    "actual",
  ]) {
    assert.equal(
      json.includes(forbidden),
      false,
      `public envelope must not contain "${forbidden}"`,
    );
  }
});
