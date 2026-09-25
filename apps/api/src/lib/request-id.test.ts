// Unit tests for the shared request-id allow-list + canonical
// accessor (`apps/api/src/lib/request-id.ts`).
//
// These tests exercise the helper in isolation, with a
// hand-built `Request`-like object — independent of any HTTP
// transport. The integration coverage lives in
// `apps/api/src/routes/intent.test.ts` (route + boundary
// middleware + global error middleware round-trip).

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Request } from "express";
import {
  getRequestId,
  type RequestWithRequestId,
  resolveRequestId,
  SAFE_REQUEST_ID_MAX_LENGTH,
  SAFE_REQUEST_ID_PATTERN,
  storeRequestId,
} from "./request-id.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fakeRequest(headerValue: unknown): Request {
  return {
    headers: { "x-request-id": headerValue as string | string[] | undefined },
  } as unknown as Request;
}

function withSlot(req: Request): RequestWithRequestId {
  return req as RequestWithRequestId;
}

describe("request-id shared lib (M2 #83 CodeQL hardening)", () => {
  test("exports the bounded allow-list constants", () => {
    assert.ok(SAFE_REQUEST_ID_PATTERN instanceof RegExp);
    assert.equal(SAFE_REQUEST_ID_MAX_LENGTH, 128);
    assert.match("safe-id_value.0-9", SAFE_REQUEST_ID_PATTERN);
    assert.doesNotMatch("evil%s", SAFE_REQUEST_ID_PATTERN);
    assert.doesNotMatch("evil o", SAFE_REQUEST_ID_PATTERN);
  });

  test("resolveRequestId: normal UUID passes through unchanged", () => {
    const req = fakeRequest("550e8400-e29b-41d4-a716-446655440000");
    assert.equal(resolveRequestId(req), "550e8400-e29b-41d4-a716-446655440000");
  });

  test("resolveRequestId: missing header falls back to a generated UUID", () => {
    const req = fakeRequest(undefined);
    const result = resolveRequestId(req);
    assert.match(result, UUID_RE);
  });

  test("resolveRequestId: invalid character falls back to a generated UUID", () => {
    const req = fakeRequest("evil%s");
    const result = resolveRequestId(req);
    assert.match(result, UUID_RE);
    assert.notEqual(result, "evil%s");
  });

  test("storeRequestId: canonical writer — sanitizes and stores on the request", () => {
    const req = withSlot(fakeRequest("550e8400-e29b-41d4-a716-446655440000"));
    const result = storeRequestId(req);
    assert.equal(result, "550e8400-e29b-41d4-a716-446655440000");
    assert.equal(req.requestId, "550e8400-e29b-41d4-a716-446655440000");
  });

  test("storeRequestId: invalid header generates a UUID and stores it on the request", () => {
    const req = withSlot(fakeRequest("evil%s"));
    const result = storeRequestId(req);
    assert.match(result, UUID_RE);
    assert.equal(req.requestId, result, "the stored id MUST equal the returned id");
  });

  test("getRequestId: returns the boundary-stored value when present", () => {
    const req = withSlot(fakeRequest("550e8400-e29b-41d4-a716-446655440000"));
    storeRequestId(req);
    assert.equal(getRequestId(req), "550e8400-e29b-41d4-a716-446655440000");
  });

  // The core invariant the round-8 review flagged: repeated
  // calls to `getRequestId` with an absent or invalid header
  // MUST return the SAME generated id (memoization). Without
  // memoization, a directly mounted router (no boundary
  // middleware) that calls `getRequestId` from a body parser
  // and a handler would produce two distinct correlation ids
  // for the same request, recreating the divergence the
  // canonical accessor is supposed to prevent.

  test("getRequestId: repeated calls with an absent header return the same generated UUID", () => {
    const req = withSlot(fakeRequest(undefined));
    const first = getRequestId(req);
    const second = getRequestId(req);
    const third = getRequestId(req);
    assert.match(first, UUID_RE);
    assert.equal(second, first, "the second call MUST return the SAME id (memoization invariant)");
    assert.equal(third, first, "the third call MUST return the SAME id (memoization invariant)");
  });

  test("getRequestId: repeated calls with an invalid header return the same generated UUID", () => {
    const req = withSlot(fakeRequest("evil%s"));
    const first = getRequestId(req);
    const second = getRequestId(req);
    const third = getRequestId(req);
    assert.match(first, UUID_RE);
    assert.notEqual(first, "evil%s");
    assert.equal(second, first, "the second call MUST return the SAME id (memoization invariant)");
    assert.equal(third, first, "the third call MUST return the SAME id (memoization invariant)");
  });

  test("getRequestId: memoized fallback equals the stored value on subsequent reads", () => {
    const req = withSlot(fakeRequest(undefined));
    const first = getRequestId(req);
    assert.equal(req.requestId, first, "the fallback MUST memoize by storing on req.requestId");
    assert.equal(getRequestId(req), first);
  });

  test("getRequestId: a header that the boundary already sanitized is NOT regenerated", () => {
    // If a previous consumer stored UUID A via `storeRequestId`
    // and a later consumer calls `getRequestId`, the later
    // consumer MUST observe the same UUID A — NOT generate a
    // fresh one based on the raw header. This is the
    // correlation invariant between the boundary and downstream
    // readers.
    const req = withSlot(fakeRequest("550e8400-e29b-41d4-a716-446655440000"));
    storeRequestId(req);
    assert.equal(req.requestId, "550e8400-e29b-41d4-a716-446655440000");
    assert.equal(getRequestId(req), "550e8400-e29b-41d4-a716-446655440000");
  });
});
