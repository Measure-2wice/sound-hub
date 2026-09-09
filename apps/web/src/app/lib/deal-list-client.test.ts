/* eslint-disable @typescript-eslint/no-floating-promises */
// Deal-list client unit tests (ticket #74).
//
// Asserts: listDeals issues a GET to /api/deals with the acting
// Workspace as a query parameter and credentials included; the
// response is parsed through the shared listDealsResponseV1Schema; and
// safe-envelope error codes propagate so the page can refresh a stale
// session rather than showing a misleading error.

import assert from "node:assert/strict";
import test from "node:test";
import { listDeals } from "./deal-list-client.js";

const ORIGINAL_FETCH = globalThis.fetch;

type FetchCall = {
  readonly url: string;
  readonly init: RequestInit;
};

function installFetchMock(handler: (call: FetchCall) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return handler({ url, init: init ?? {} });
  };
  return calls;
}

function restoreFetch(): void {
  globalThis.fetch = ORIGINAL_FETCH;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_DEAL = {
  dealId: "deal-1",
  status: "Negotiating" as const,
  actingSide: "Buyer" as const,
  counterpartyWorkspaceName: "Blue Mountain Studio",
  serviceOfferingTitle: "Mixing & Mastering — Full Track",
  currentTermsVersion: 2,
  approvalState: "AwaitingSellerApproval" as const,
  fundingStatus: null,
  activatedAt: null,
  createdAt: "2026-02-01T10:00:00.000Z",
};

test("issues a GET to /api/deals with the acting Workspace and credentials", async () => {
  const calls = installFetchMock(() => jsonResponse(200, { ok: true, deals: [VALID_DEAL] }));
  try {
    await listDeals("ws-buyer");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "/api/deals?actingWorkspaceId=ws-buyer");
    assert.equal(calls[0]?.init.method, "GET");
    // The HttpOnly session cookie must ride along; without this the
    // API cannot identify the acting human.
    assert.equal(calls[0]?.init.credentials, "include");
  } finally {
    restoreFetch();
  }
});

test("url-encodes the acting Workspace id", async () => {
  const calls = installFetchMock(() => jsonResponse(200, { ok: true, deals: [] }));
  try {
    await listDeals("ws buyer&x=1");
    assert.equal(calls[0]?.url, "/api/deals?actingWorkspaceId=ws+buyer%26x%3D1");
  } finally {
    restoreFetch();
  }
});

test("parses a valid response through the shared schema", async () => {
  installFetchMock(() => jsonResponse(200, { ok: true, deals: [VALID_DEAL] }));
  try {
    const result = await listDeals("ws-buyer");
    assert.equal(result.ok, true);
    assert.equal(result.deals.length, 1);
    assert.equal(result.deals[0]?.dealId, "deal-1");
    assert.equal(result.deals[0]?.serviceOfferingTitle, "Mixing & Mastering — Full Track");
  } finally {
    restoreFetch();
  }
});

test("rejects a payload that does not match the contract", async () => {
  // A drifting server must fail loudly at the boundary rather than
  // letting an unvalidated shape reach the UI.
  installFetchMock(() =>
    jsonResponse(200, { ok: true, deals: [{ ...VALID_DEAL, approvalState: "Whenever" }] }),
  );
  try {
    await assert.rejects(listDeals("ws-buyer"));
  } finally {
    restoreFetch();
  }
});

test("rejects a response carrying an unknown extra field", async () => {
  // The list schema is strict: an added field means the contract moved
  // and the client must not silently accept it.
  installFetchMock(() =>
    jsonResponse(200, {
      ok: true,
      deals: [{ ...VALID_DEAL, paymentIntentId: "pi-1" }],
    }),
  );
  try {
    await assert.rejects(listDeals("ws-buyer"));
  } finally {
    restoreFetch();
  }
});

test("propagates the safe-envelope code for an authorization rejection", async () => {
  installFetchMock(() =>
    jsonResponse(403, {
      error: {
        code: "DEAL_LIST_FORBIDDEN",
        message: "You cannot view Deals for this Workspace.",
        requestId: "req-1",
      },
    }),
  );
  try {
    await assert.rejects(listDeals("ws-buyer"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, "DEAL_LIST_FORBIDDEN");
      assert.equal((err as { status?: number }).status, 403);
      assert.equal((err as { requestId?: string | null }).requestId, "req-1");
      return true;
    });
  } finally {
    restoreFetch();
  }
});

test("propagates SESSION_INVALID so the page can refresh the session", async () => {
  installFetchMock(() =>
    jsonResponse(401, {
      error: {
        code: "SESSION_INVALID",
        message: "Sign in is required to view your Deals.",
        requestId: "req-2",
      },
    }),
  );
  try {
    await assert.rejects(listDeals("ws-buyer"), (err: unknown) => {
      assert.equal((err as { code?: string }).code, "SESSION_INVALID");
      return true;
    });
  } finally {
    restoreFetch();
  }
});

test("falls back to a safe code when the error body is not JSON", async () => {
  installFetchMock(() => new Response("<html>gateway error</html>", { status: 502 }));
  try {
    await assert.rejects(listDeals("ws-buyer"), (err: unknown) => {
      assert.equal((err as { code?: string }).code, "DEAL_LIST_FAILED");
      // The raw upstream body must not become the user-facing message.
      assert.ok(!(err as Error).message.includes("<html>"));
      return true;
    });
  } finally {
    restoreFetch();
  }
});
