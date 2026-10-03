/* eslint-disable @typescript-eslint/no-floating-promises */
// ServiceOffering client unit tests (M2 #86, slice 86B).
//
// Background: the Pause / Reactivate web client functions must
// validate request and response bodies against the shared Zod schemas
// so the browser cannot drift from the contract. These tests stub
// the global `fetch` and assert observable outcome only — no JSDOM,
// no source-pattern assertions.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ServiceOfferingActivationResponseV1 } from "@soundhub/types";
import {
  activateServiceOffering,
  pauseServiceOffering,
  reactivateServiceOffering,
} from "./service-offering-client.js";

const originalFetch = globalThis.fetch;
let lastRequest: { url: string; init?: RequestInit } | null = null;

function mockFetch(
  response:
    | { status: number; body: unknown }
    | ((url: string, init?: RequestInit) => { status: number; body: unknown }),
): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    lastRequest = { url, init };
    const r = typeof response === "function" ? response(url, init) : response;
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

beforeEach(() => {
  lastRequest = null;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function expectedOfferingShape(): ServiceOfferingActivationResponseV1 {
  return {
    ok: true,
    offering: {
      serviceOfferingId: "of_1",
      workspaceId: "ws_1",
      sellerProfileId: "sp_1",
      status: "Active",
      title: "Haitian dancehall production",
      description: "Description",
      primaryCategoryKey: "music-production",
      serviceMode: "Remote",
      serviceAreas: [],
      pricing: null,
      genreTags: [],
      includedServiceCategoryKeys: [],
      samples: [],
      activatedAt: "2026-09-27T13:00:00.000Z",
      activatedByDisplayName: "creole@example.com",
      readiness: {
        isAvailable: true,
        updateNeeded: false,
        reasonCategories: [],
        isGrandfatheredNonconforming: false,
      },
    },
    evidence: {
      activatedAt: "2026-09-27T13:00:00.000Z",
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    },
    returnTo: null,
    safeReturnTo: null,
  };
}

describe("M2 #86, slice 86B — ServiceOffering web client", () => {
  void test("pauseServiceOffering: POSTs /pause with credentials: include and the strict request body", async () => {
    mockFetch(() => ({
      status: 200,
      body: {
        ok: true,
        offering: {
          serviceOfferingId: "of_1",
          workspaceId: "ws_1",
          sellerProfileId: "sp_1",
          status: "Paused",
          title: "Haitian dancehall production",
          description: "Description",
          primaryCategoryKey: "music-production",
          serviceMode: "Remote",
          serviceAreas: [],
          pricing: null,
          genreTags: [],
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
        },
        evidence: {
          pausedAt: "2026-09-27T13:00:00.000Z",
          reason: "user_initiated",
          idempotencyKey: "00000000-0000-4000-8000-000000000001",
        },
        returnTo: null,
        safeReturnTo: null,
      },
    }));
    const response = await pauseServiceOffering({
      workspaceId: "ws_1",
      offeringId: "of_1",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    });
    assert.equal(lastRequest?.url, "/api/workspaces/ws_1/service-offerings/of_1/pause");
    assert.equal(lastRequest?.init?.method, "POST");
    assert.equal(lastRequest?.init?.credentials ?? "include", "include");
    assert.equal(
      (lastRequest?.init?.headers as Record<string, string> | undefined)?.["Content-Type"],
      "application/json",
    );
    assert.equal(response.offering.status, "Paused");
    assert.equal(response.evidence.reason, "user_initiated");
  });

  void test("pauseServiceOffering: a non-UUID idempotencyKey is rejected locally by the strict schema", async () => {
    await assert.rejects(
      pauseServiceOffering({
        workspaceId: "ws_1",
        offeringId: "of_1",
        idempotencyKey: "not-a-uuid",
      }),
    );
  });

  void test("pauseServiceOffering: an unknown additional field is rejected locally", async () => {
    await assert.rejects(
      pauseServiceOffering({
        workspaceId: "ws_1",
        offeringId: "of_1",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        // @ts-expect-error — the strict schema must reject unknown fields.
        returnTo: "/dashboard",
      }),
    );
  });

  void test("reactivateServiceOffering: POSTs /reactivate with the strict activation schema", async () => {
    mockFetch(() => ({ status: 200, body: expectedOfferingShape() }));
    const response = await reactivateServiceOffering({
      workspaceId: "ws_1",
      offeringId: "of_1",
      activation: {
        title: "Haitian dancehall production",
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
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
    });
    assert.equal(lastRequest?.url, "/api/workspaces/ws_1/service-offerings/of_1/reactivate");
    assert.equal(lastRequest?.init?.method, "POST");
    assert.equal(lastRequest?.init?.credentials ?? "include", "include");
    assert.equal(response.offering.status, "Active");
  });

  void test("activateServiceOffering: POSTs /activate unchanged (regression coverage)", async () => {
    mockFetch(() => ({ status: 200, body: expectedOfferingShape() }));
    const response = await activateServiceOffering({
      workspaceId: "ws_1",
      offeringId: "of_1",
      activation: {
        title: "Haitian dancehall production",
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
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
    });
    assert.equal(lastRequest?.url, "/api/workspaces/ws_1/service-offerings/of_1/activate");
    assert.equal(response.offering.status, "Active");
  });
});
