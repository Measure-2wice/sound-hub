/* eslint-disable @typescript-eslint/no-floating-promises */
// M2 (#86, slice 86F) — sanity smoke test for the
// `seedActiveServiceOffering` helper used by the slice 86F
// Playwright journeys. The helper writes the full Active state
// shape (Published SellerProfile + Active ServiceOffering + Live
// audio sample + activation evidence) directly to the disposable
// Prisma DB so the browser walk exercises ONLY the slice-specific
// UI surfaces.
//
// This is NOT the QA coverage; it is a smoke test that asserts the
// helper runs end-to-end against the approved disposable test DB
// and returns the expected shape.
//
// The `node:test` `test`/`describe` functions return Promises the
// runner awaits implicitly; the `@typescript-eslint/no-floating-
// promises` rule treats them as fire-and-forget without a comment.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { seedActiveServiceOffering } from "./service-offering-active.js";

describe("M2 (#86, slice 86F) — seedActiveServiceOffering helper", () => {
  test("seeds an Active offering + Live sample + returns the expected shape", async () => {
    const email = `slice-86f-helper-smoke-${Date.now()}@example.test`;
    const result = await seedActiveServiceOffering(email);
    assert.ok(result.userAccountId.length > 0, "userAccountId is non-empty");
    assert.ok(result.personalWorkspaceId.length > 0, "personalWorkspaceId is non-empty");
    assert.ok(result.sellerProfileId.length > 0, "sellerProfileId is non-empty");
    assert.ok(result.offeringId.length > 0, "offeringId is non-empty");
    assert.ok(result.offeringSlug.length > 0, "offeringSlug is non-empty");
    assert.ok(result.sampleId.length > 0, "sampleId is non-empty");
    assert.equal(result.email, email);
  });

  test("seeds a Paused offering when the paused flag is set", async () => {
    const email = `slice-86f-helper-paused-${Date.now()}@example.test`;
    const result = await seedActiveServiceOffering(email, { paused: true });
    assert.ok(result.offeringId.length > 0);
    assert.ok(result.sampleId.length > 0);
  });

  test("seeds a grandfathered offering when the stale-confirmation + omit-pricing + omit-sample flags are set", async () => {
    const email = `slice-86f-helper-grandfathered-${Date.now()}@example.test`;
    const result = await seedActiveServiceOffering(email, {
      staleConfirmation: true,
      omitPricing: true,
      omitSample: true,
    });
    assert.ok(result.offeringId.length > 0);
    assert.equal(result.sampleId, "", "sampleId is empty when omitSample is set");
  });

  test("seeds two samples when the multiple-samples flag is set", async () => {
    const email = `slice-86f-helper-multi-${Date.now()}@example.test`;
    const result = await seedActiveServiceOffering(email, { multipleSamples: true });
    assert.ok(result.sampleId.length > 0);
  });
});
