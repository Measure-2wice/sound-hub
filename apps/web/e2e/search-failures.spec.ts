// M1.6 browser-visible search-failure and concurrency safety tracer.
//
// The M1.1 happy-path spec proves real sellers render through the
// proxy. The M1.3 negative-eligibility spec proves ineligible sellers
// stay out of the result list. The M1.4 required-constraints spec
// proves strict filters render correctly. This spec covers the M1.6
// acceptance criteria for the public buyer experience:
//
//   - Empty matches return a successful response and a distinct empty
//     UI state through the Next.js proxy (not a 4xx, not a silent
//     success).
//   - PostgreSQL unavailability maps to the retriable SEARCH_UNAVAILABLE
//     envelope and a UI state that preserves the buyer's brief AND
//     offers a one-click retry.
//   - Canceled or older responses cannot overwrite newer results or
//     clear the current loading state.
//   - Success and error behavior remain identical through Express
//     directly and the Next.js proxy.
//
// Most tests in this file exercise the real Next.js proxy, the real
// Express API, the real TalentSearchService, the real Prisma adapter,
// and the real disposable PostgreSQL end to end. The two scoped
// exceptions permitted by `playwright.config.ts` are:
//
//   - The retry-button affordance test (line 92) injects the safe
//     SEARCH_UNAVAILABLE envelope on the first attempt only and falls
//     through to the real proxy / API for every subsequent attempt.
//     The real PostgreSQL outage test (the last test in this file)
//     covers the same envelope through the real Prisma + PostgreSQL
//     path. This fault-injection mock exists because the assertion
//     under test is the UI affordance: a retry button must appear,
//     the buyer's brief must be preserved, and a successful retry
//     must yield results.
//
//   - The concurrency test (line 164) holds both in-flight responses
//     pending, releases the older one first, and lets BOTH responses
//     come from the real proxy / API. This time/ordering-control mock
//     exists because the assertion under test is the
//     `useTalentSearch` hook's monotonic requestIdRef guard, which
//     is only observable when the older response can be made to
//     land AFTER the newer submission is already in flight. The route
//     handler controls the resolution order of the two real requests;
//     it never fabricates a payload.
//
// Both mocks route at the Next.js proxy layer (not the Express layer)
// so the full browser surface, including the proxy transport, is
// verified. Both always `route.fallback()` for any request they do not
// specifically intercept.
//
// The real-PostgreSQL outage test is the LAST test in this file: it
// stops the approved disposable test container, drives a request
// through the proxy + Express + real Prisma client, and restarts the
// container before returning. The single-worker, sequential
// `playwright.config.ts` (workers: 1, fullyParallel: false) keeps
// subsequent test files from running while the database is offline.

import { execSync } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  test,
  expect,
  type Page,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";

async function loadHome(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Find Caribbean talent" })).toBeVisible();
}

// Distinct empty-state test through the Next.js proxy.
//
// A query that matches no canonical sellers must complete (200), the
// empty state must render with its distinct data-testid, and the
// buyer's input must be preserved in the form so the buyer can adjust
// without retyping.
test("M1.6: empty matches return 200 and a distinct empty state through the proxy", async ({
  page,
}) => {
  await loadHome(page);

  // "zzzzz-no-such-thing" matches no canonical seller/offering.
  await page.getByTestId("search-input").fill("zzzzz-no-such-thing");
  await page.getByTestId("search-submit").click();

  // Distinct empty state with its own data-testid (NOT a result card,
  // NOT a generic error envelope).
  const empty = page.getByTestId("search-empty");
  await expect(empty).toBeVisible({ timeout: 15_000 });

  // The empty state never renders an error card and never renders a
  // result card; the three states are mutually exclusive at the
  // page level.
  await expect(page.getByTestId("search-error")).toHaveCount(0);
  await expect(page.getByTestId("result-card")).toHaveCount(0);

  // The buyer's input is preserved so they can adjust and retry.
  await expect(page.getByTestId("search-input")).toHaveValue("zzzzz-no-such-thing");
});

// Retry button affordance on retriable failures.
//
// When Express returns a retriable envelope (SEARCH_UNAVAILABLE),
// the page renders a retry button. Clicking it re-submits the
// exact same request. The fixture switches to a 200 response
// between attempts so we can prove the retry path actually drives
// the same payload to a fresh request.
//
// This test continues to mock at the Next.js proxy layer because
// the acceptance it covers is the UI affordance: a retriable
// envelope must produce a retry button, the brief must be
// preserved, and a successful retry must yield results. The real
// PostgreSQL outage path is covered by a dedicated test below.
test("M1.6: SEARCH_UNAVAILABLE surfaces a retry button that re-submits the preserved brief", async ({
  page,
}) => {
  // First call: SEARCH_UNAVAILABLE 503 with the safe envelope.
  // Second call onward: real canonical response (proxy passthrough).
  let attempt = 0;
  await page.route("**/api/search", (route) => {
    attempt += 1;
    if (attempt === 1) {
      void route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "x-request-id": "test-retry-request-id" },
        body: JSON.stringify({
          error: {
            code: "SEARCH_UNAVAILABLE",
            message: "Talent search is temporarily unavailable. Please try again.",
            requestId: "test-retry-request-id",
          },
        }),
      });
      return;
    }
    // Fall through to the real proxy / API for subsequent attempts.
    void route.fallback();
  });

  await loadHome(page);

  const query = "Haitian dancehall single production";
  await page.getByTestId("search-input").fill(query);
  await page.getByTestId("search-submit").click();

  // First attempt: the error card appears with the SEARCH_UNAVAILABLE
  // safe message and the retry button.
  const errorCard = page.getByTestId("search-error");
  await expect(errorCard).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("search-error-message")).toContainText(/temporarily unavailable/i);
  await expect(page.getByTestId("search-error-request-id")).toContainText("test-retry-request-id");
  const retryButton = page.getByTestId("search-retry");
  await expect(retryButton).toBeVisible();

  // The buyer's input is preserved across the failure.
  await expect(page.getByTestId("search-input")).toHaveValue(query);

  // Click the retry button. The real proxy/API now responds with the
  // canonical results.
  await retryButton.click();
  await expect(page.getByTestId("result-card").first()).toBeVisible({ timeout: 15_000 });

  // After a successful retry, the error card is gone (mutually
  // exclusive with results) and the request counter observed two
  // /api/search calls.
  await expect(page.getByTestId("search-error")).toHaveCount(0);
  expect(attempt).toBeGreaterThanOrEqual(2);
});

// Concurrent-request safety.
//
// The two subtests below control the resolution order of two
// overlapping submissions and prove:
//   (a) when an older in-flight response settles while a newer
//       submission is still pending, the loading indicator stays
//       visible and is only cleared once the newer response lands;
//   (b) when an older in-flight response settles AFTER the newer
//       submission has already rendered, the stale response cannot
//       overwrite the rendered newer result.
//
// (a) is the loading-state regression: the intermediate
// `search-loading` state must remain visible while an older
// response is being processed, so the buyer never sees a flicker
// of "results, then nothing, then results again."
//
// (b) is the result-overwrite regression: a late-arriving older
// response must not clobber the rendered DOM with the older
// submission's payload. Both subtests use two DISTINCT, real,
// non-empty queries so the rendered result for the newer request
// is observable, and so a successful overwrite would be visible
// as either a removed result card or the appearance of an
// unexpected seller card.
//
// The shared submission/route-waiter orchestration lives in
// `setupConcurrencyHarness` below. Each subtest provides its own
// queries, token, release order, and assertions.

interface ConcurrencyHarness {
  readonly releaseOlder: () => void;
  readonly releaseNewer: () => void;
}

// Set up two overlapping submissions routed through the real proxy
// and Express. The route handler installs body-token detection so
// the older and newer requests land in separate resolver queues
// (which lets each test settle them in its own chosen order). Both
// requests `route.fallback()` to the real proxy / API; the harness
// only controls the resolution ORDER of the two real requests, not
// their content.
//
// The buyer-facing UX disables the input and submit button while a
// request is in flight. That is correct production behaviour but
// blocks the second submission. The harness re-enables both
// controls via direct DOM manipulation so a regression test can
// inject the second submission while the first is still pending.
// This mirrors the same escape hatch the original spec used and is
// necessary to exercise the hook's monotonic requestIdRef guard.
async function setupConcurrencyHarness(
  page: Page,
  options: {
    olderQuery: string;
    newerQuery: string;
    olderToken: string;
  },
): Promise<ConcurrencyHarness> {
  const olderResolvers: Array<() => void> = [];
  const newerResolvers: Array<() => void> = [];

  await page.route("**/api/search", async (route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    const isOlderRequest = body.includes(options.olderToken);
    const resolverTarget = isOlderRequest ? olderResolvers : newerResolvers;
    const waiter = new Promise<void>((resolve) => {
      resolverTarget.push(resolve);
    });
    await waiter;
    void route.fallback();
  });

  await loadHome(page);

  // First submission (older).
  await page.getByTestId("search-input").fill(options.olderQuery);
  await page.getByTestId("search-submit").click();

  // Force form controls back to enabled so the second submission
  // can be injected while the first is still pending.
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
    const submit = document.querySelector<HTMLButtonElement>('[data-testid="search-submit"]');
    if (input) input.disabled = false;
    if (submit) submit.disabled = false;
  });

  // Second submission (newer).
  await page.getByTestId("search-input").fill(options.newerQuery);
  await page.getByTestId("search-submit").click();

  // Block until the route handler has entered BOTH waiters. This
  // proves both submissions have actually reached the network
  // layer and are queued behind their respective resolvers.
  await expect.poll(() => olderResolvers.length + newerResolvers.length).toBe(2);

  // Arrow functions so destructured callers cannot lose `this`
  // binding; the closures capture the resolver queues above.
  return {
    releaseOlder: () => {
      olderResolvers.splice(0).forEach((resolve) => {
        resolve();
      });
    },
    releaseNewer: () => {
      newerResolvers.splice(0).forEach((resolve) => {
        resolve();
      });
    },
  };
}

test.describe("M1.6: concurrent submissions preserve newest result and loading", () => {
  test("older in-flight response cannot overwrite the newer submission's loading state", async ({
    page,
  }) => {
    // The older submission's query intentionally matches no
    // canonical seller so its real proxy/API response is an empty
    // results array. The newer submission's query matches the
    // seeded Marc-André Pierre fixture.
    const freshSeller = "Marc-André Pierre";
    const { releaseOlder, releaseNewer } = await setupConcurrencyHarness(page, {
      olderQuery: "first-submission-token",
      newerQuery: "Haitian dancehall single production",
      olderToken: "first-submission-token",
    });

    // The loading indicator is visible while the newer request is
    // pending (the older request is still pending at this point).
    await expect(page.getByTestId("search-loading")).toBeVisible({ timeout: 5_000 });

    // Release the OLDER request first while the newer request
    // remains pending. The hook's monotonic requestIdRef guard
    // ensures this late-arriving response cannot clear the
    // loading state.
    releaseOlder();

    // The loading indicator must still be visible after the older
    // response settles: the active request is still the newer one.
    await expect(page.getByTestId("search-loading")).toBeVisible({ timeout: 5_000 });

    // The older response must not cause a result card to render:
    // the newer request is still in flight, so the active loading
    // state is preserved and no seller card is shown until the
    // newer response lands.
    await expect(page.getByTestId("result-card")).toHaveCount(0);

    // Release the NEWER request. Only now may the loading
    // indicator clear and the newest result render.
    releaseNewer();

    await expect(page.getByTestId("result-card").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("search-loading")).toHaveCount(0);

    const bodyText = (await page.textContent("body")) ?? "";
    expect(bodyText).toContain(freshSeller);
  });

  // The result-overwrite half of the concurrency contract. The
  // prior subtest above only proved that the loading indicator
  // survives an early-arriving older response; it never let an
  // older response land AFTER the newer results had rendered, so
  // it could not detect a regression that lets the older payload
  // overwrite the rendered newer DOM. This subtest deliberately
  // releases the NEWER response first, waits for the newer
  // result card to render, and THEN releases the older response
  // — exercising the same `requestIdRef` guard against the
  // concrete post-render overwrite path.
  //
  // Both queries are DISTINCT and both match real canonical
  // sellers so the rendered result is non-empty for the newer
  // request and so an overwrite would manifest as either the
  // newer seller card disappearing or the older seller card
  // appearing in the same DOM the buyer is looking at.
  test("older in-flight response cannot overwrite the newer submission's rendered result", async ({
    page,
  }) => {
    const newerSeller = "Marc-André Pierre";
    const olderSeller = "Keisha Williams";
    const { releaseOlder, releaseNewer } = await setupConcurrencyHarness(page, {
      // The token identifies the older request to the route
      // handler but is not itself a search token; the canonical
      // "Afrobeats topline writing" tokens carry the match.
      olderQuery: "older-stale-overwrite-token Afrobeats topline writing",
      newerQuery: "Haitian dancehall single production",
      olderToken: "older-stale-overwrite-token",
    });

    // Release the NEWER request FIRST. The newer response reaches
    // the hook while the older request is still pending, so the
    // hook renders the newer results and clears its loading
    // indicator. The Marc-André Pierre result card must be
    // visible before the older response is released so the
    // assertion below has a concrete "newer rendered result" to
    // protect from overwrite.
    releaseNewer();

    const newerCard = page.getByTestId("result-card").filter({ hasText: newerSeller }).first();
    await expect(newerCard).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("search-loading")).toHaveCount(0);

    // Snapshot the rendered DOM after the newer result lands so
    // any overwrite caused by the older response would be visible
    // as either the newer card disappearing, the older card
    // appearing, or the total card count shifting. A regression
    // that drops the `requestIdRef` guard would let the older
    // response clobber the rendered state and any of these three
    // snapshots would diverge.
    const totalCountBefore = await page.getByTestId("result-card").count();

    // Release the OLDER request AFTER the newer result has
    // rendered. The hook's monotonic requestIdRef guard must
    // observe that the older request's id is stale and drop the
    // older response without touching React state. Both
    // responses are real — the older one carries Keisha Williams
    // results, the newer one carries Marc-André Pierre results
    // — so an unguarded overwrite would surface as a Keisha
    // Williams card appearing in the same DOM the buyer sees.
    releaseOlder();

    // Allow the older response time to settle. If the hook drops
    // the stale response correctly, the DOM is unchanged. If a
    // regression lets the older response through, one of the
    // assertions below will fail: either the newer card
    // disappears or a Keisha Williams card appears.
    await sleep(500);
    await page.waitForLoadState("networkidle");

    // The newer card must still be visible — the older response
    // must not have cleared it.
    await expect(newerCard).toBeVisible();

    // The result list must still belong to the newer submission:
    // Marc-André Pierre is rendered, and Keisha Williams (the
    // older submission's match) is NOT rendered. The exact card
    // count parity proves no row was inserted by the older
    // response.
    const newerCount = await page
      .getByTestId("result-card")
      .filter({ hasText: newerSeller })
      .count();
    const olderCount = await page
      .getByTestId("result-card")
      .filter({ hasText: olderSeller })
      .count();
    expect(newerCount).toBeGreaterThan(0);
    expect(olderCount).toBe(0);
    // No row was inserted by the older response: the total card
    // count is unchanged from the snapshot taken before the older
    // response settled. A regression that lets the older response
    // through would either replace the rendered list with the
    // older payload (changing the count) or append a Keisha
    // Williams card (changing the count upward).
    expect(await page.getByTestId("result-card").count()).toBe(totalCountBefore);

    const bodyText = (await page.textContent("body")) ?? "";
    expect(bodyText).toContain(newerSeller);
    expect(bodyText).not.toContain(olderSeller);
  });
});

// Proxy-vs-direct preservation.
//
// The Next.js rewrite must transparently forward the buyer's POST to
// Express: status, response body, and request ID must round-trip
// identically. To prove the proxy preserves content rather than
// merely self-consistently producing some valid response, we send
// a CONTROLLED `x-request-id` header through BOTH surfaces and
// assert the body, status, and `x-request-id` response header agree
// across them. A proxy that rewrites or drops the header, the
// status, or the body would cause the cross-surface equality
// assertions to fail.
//
// The cases cover:
//   - INVALID_SEARCH_CRITERIA (malformed body)
//   - Successful canonical search
//
// Both surfaces run in the same Playwright request context so they
// share the same network namespace and the same `x-request-id`
// propagation; the controlled ID is the deterministic seam that
// makes the proxy preservation observable.
test.describe("M1.6: success and error envelopes are preserved identically through the proxy and Express directly", () => {
  const apiBase = process.env.API_URL ?? "http://localhost:4000";

  // Strip the non-deterministic per-query `processingTimeMs` field
  // from a parsed response body so deep equality across two parallel
  // queries is observable. Every other field is part of the v1
  // contract and must round-trip identically through both surfaces.
  function stripTiming(body: unknown): unknown {
    if (body === null || typeof body !== "object") return body;
    if (Array.isArray(body)) return body.map(stripTiming);
    const clone: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (key === "processingTimeMs") continue;
      clone[key] = stripTiming(value);
    }
    return clone;
  }

  // Send the same payload through both surfaces and return both
  // responses + parsed bodies. The caller compares them.
  async function runCaseOnBothTransports(
    request: APIRequestContext,
    payload: string,
    headers: Record<string, string>,
  ): Promise<{
    proxy: APIResponse;
    direct: APIResponse;
    proxyBody: unknown;
    directBody: unknown;
  }> {
    const proxyResponse = await request.post("/api/search", {
      headers,
      data: payload,
    });
    const directResponse = await request.fetch(`${apiBase}/api/search`, {
      method: "POST",
      headers,
      data: payload,
    });
    const proxyBody: unknown = await proxyResponse.json();
    const directBody: unknown = await directResponse.json();
    return {
      proxy: proxyResponse,
      direct: directResponse,
      proxyBody,
      directBody,
    };
  }

  test("malformed body: identical status, body, and propagated request ID across proxy and direct", async ({
    request,
    page,
  }) => {
    // `required.basedIn.countryCode: "12"` is rejected by the
    // shared schema with INVALID_SEARCH_CRITERIA. Both surfaces
    // must surface the SAME status and envelope.
    const malformed = JSON.stringify({ required: { basedIn: { countryCode: "12" } } });
    const controlledRequestId = `m1-6-proxy-fidelity-error-${Date.now()}`;
    const headers = {
      "content-type": "application/json",
      "x-request-id": controlledRequestId,
    };

    const { proxy, direct, proxyBody, directBody } = await runCaseOnBothTransports(
      request,
      malformed,
      headers,
    );

    // Status equality. A proxy that downgraded to 200 (silent
    // acceptance) or upgraded to 500 (extra wrapper) would diverge.
    expect(proxy.status()).toBe(direct.status());
    expect(proxy.status()).toBe(400);

    // Body equality (deep). A proxy that injected a wrapper, dropped
    // a field, or rewrote a value would diverge.
    expect(proxyBody).toEqual(directBody);

    const errorBody = (proxyBody as { error: { code: string; requestId: string } }).error;
    expect(errorBody.code).toBe("INVALID_SEARCH_CRITERIA");

    // Controlled request ID reached the EXPRESS handler on both
    // surfaces AND is reflected in BOTH the body and the response
    // header. A proxy that strips x-request-id would let Express
    // generate a fresh one and the equality assertions below would
    // fail.
    expect(errorBody.requestId).toBe(controlledRequestId);
    const directErrorBody = (directBody as { error: { code: string; requestId: string } }).error;
    expect(directErrorBody.requestId).toBe(controlledRequestId);
    expect(proxy.headers()["x-request-id"]).toBe(controlledRequestId);
    expect(direct.headers()["x-request-id"]).toBe(controlledRequestId);

    await loadHome(page);
  });

  test("canonical search: identical status, body, and request ID across proxy and direct", async ({
    request,
    page,
  }) => {
    const validPayload = JSON.stringify({ query: "Haitian dancehall single production" });
    const controlledRequestId = `m1-6-proxy-fidelity-success-${Date.now()}`;
    const headers = {
      "content-type": "application/json",
      "x-request-id": controlledRequestId,
    };

    const { proxy, direct, proxyBody, directBody } = await runCaseOnBothTransports(
      request,
      validPayload,
      headers,
    );

    // Status equality.
    expect(proxy.status()).toBe(direct.status());
    expect(proxy.status()).toBe(200);

    // Body equality (deep), with the non-deterministic per-query
    // timing field excluded. `processingTimeMs` is measured at the
    // service layer and varies by milliseconds between two parallel
    // queries; the proxy must not be measured differently from the
    // direct path because both routes reach the same Express
    // service. Every other field — result order, relevance scores,
    // normalized query, strategy, applied criteria, request ID —
    // must round-trip byte-identically through both surfaces. A
    // proxy that rewrote, reordered, or dropped any of those
    // fields would diverge.
    expect(stripTiming(proxyBody)).toEqual(stripTiming(directBody));

    // Sanity: the canonical fixture is on top of the result list
    // through both surfaces. Both surfaces produced the same
    // body (asserted above via `expect(proxyBody).toEqual(directBody)`)
    // so a single check against one surface is sufficient — but
    // the per-surface checks below make the assertion intent
    // explicit and self-documenting.
    const proxyResults = (
      proxyBody as {
        results: Array<{
          seller: { professionalName: string };
          bestMatchingOffering: { title: string };
        }>;
      }
    ).results;
    const directResults = (
      directBody as {
        results: Array<{
          seller: { professionalName: string };
          bestMatchingOffering: { title: string };
        }>;
      }
    ).results;
    expect(proxyResults.length).toBeGreaterThan(0);
    expect(directResults.length).toBeGreaterThan(0);
    const proxyTop = proxyResults[0]!;
    const directTop = directResults[0]!;
    expect(proxyTop.seller.professionalName).toBe("Marc-André Pierre");
    expect(proxyTop.bestMatchingOffering.title).toBe(
      "Haitian dancehall single production — remote",
    );
    expect(directTop.seller.professionalName).toBe("Marc-André Pierre");
    expect(directTop.bestMatchingOffering.title).toBe(
      "Haitian dancehall single production — remote",
    );

    // Controlled request ID propagated through both surfaces.
    expect(proxy.headers()["x-request-id"]).toBe(controlledRequestId);
    expect(direct.headers()["x-request-id"]).toBe(controlledRequestId);

    await loadHome(page);
  });
});

// Real PostgreSQL unavailability through Express and the proxy.
//
// Acceptance: "PostgreSQL unavailability returns the safe retriable
// SEARCH_UNAVAILABLE response and UI state." The previous spec
// fabricated the 503 at the browser route layer, which never
// exercised PostgreSQL, Express, or the Next.js proxy at all.
//
// This test stops the approved disposable test container
// (`soundhub_postgres_test` on localhost:5433) so the real Prisma
// client held by the long-running Express process sees
// ECONNREFUSED / P1001 on its next query. The buyer's request goes
// through the real Next.js proxy to the real Express to the real
// Prisma client. Express's safe-envelope path then maps the
// Prisma connection error to SEARCH_UNAVAILABLE 503, which the
// browser renders as a retry card with the buyer's preserved
// brief.
//
// The container is restarted in `afterAll` so subsequent test files
// in the same Playwright session (and the global teardown) run
// against a live database. The serial ordering inside this
// describe guarantees the stop/start operations are not interleaved
// with other tests.
//
// Fail-closed guards:
//   - The docker compose file path is hardcoded to the approved
//     `docker-compose.test.yml` in the repo root.
//   - The container name is the approved `postgres_test` service.
//   - If any assertion fails, the `try/finally` restarts the
//     container before re-throwing so the suite does not leave
//     the database offline.
const DOCKER_COMPOSE_FILE = `${process.cwd()}/../../docker-compose.test.yml`;
const TEST_DB_HOST = "localhost";
const TEST_DB_PORT = 5433;

function runDockerCompose(args: string): void {
  execSync(`docker compose -f ${DOCKER_COMPOSE_FILE} ${args}`, {
    cwd: `${process.cwd()}/../..`,
    stdio: "pipe",
    timeout: 30_000,
  });
}

// Poll the test database's TCP port until it reaches the desired
// availability (true = accepting, false = refusing) or the deadline
// elapses. The disposable PostgreSQL outage test uses this to wait
// for the container to stop accepting connections after `docker
// compose stop` and to wait for it to come back up after `start` /
// `up`. The last observed socket error is reported in the timeout
// message so a real diagnosis is visible from CI logs.
async function waitForTcpState(
  desiredAvailable: boolean,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: TEST_DB_HOST, port: TEST_DB_PORT }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", (err) => {
        socket.destroy();
        lastError = err;
        resolve(false);
      });
      socket.setTimeout(1_000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable === desiredAvailable) return;
    await sleep(pollIntervalMs);
  }
  const direction = desiredAvailable ? "accept" : "stop accepting";
  throw new Error(
    `Test database at ${TEST_DB_HOST}:${TEST_DB_PORT} did not ${direction} TCP within ${timeoutMs}ms (last error: ${String(
      lastError,
    )})`,
  );
}

// Bring the disposable PostgreSQL container back up and wait for it
// to accept TCP connections. Used by both `afterAll` (to recover
// after a passing test) and the test's `finally` block (to recover
// after a failing test). If the container was removed entirely,
// recreate it via `up -d` so subsequent test files still find it.
async function restoreTestDatabase(): Promise<void> {
  try {
    runDockerCompose("start postgres_test");
  } catch {
    // If the container was removed entirely, recreate it via `up`.
    runDockerCompose("up -d postgres_test");
  }
  await waitForTcpState(true, 60_000, 500);
}

test.describe.serial("M1.6: real PostgreSQL unavailability through Express and the proxy", () => {
  test.afterAll(async () => {
    // Always bring the container back up before exiting this
    // describe block, even if the test below failed.
    await restoreTestDatabase();
  });

  test("stops PostgreSQL, drives a search through the proxy + Express + real Prisma, and renders SEARCH_UNAVAILABLE with a retry affordance", async ({
    page,
    request,
  }) => {
    // Sanity: the database is up at the start so this test's
    // preconditions are visible in the failure output.
    const sanity = await request.get(
      `${process.env.API_URL ?? "http://localhost:4000"}/api/health`,
    );
    expect(sanity.status()).toBe(200);

    try {
      // Stop the disposable PostgreSQL container. The Prisma
      // client's existing pool entries get ECONNREFUSED on the
      // next query attempt.
      runDockerCompose("stop postgres_test");
      await waitForTcpState(false, 15_000, 250);

      // Drive a search through the browser: Next.js proxy →
      // Express → real Prisma client → PostgreSQL (down) →
      // connection failure → safe envelope.
      await loadHome(page);
      const query = "Haitian dancehall single production";
      await page.getByTestId("search-input").fill(query);
      await page.getByTestId("search-submit").click();

      // The retriable error card must appear with the safe
      // SEARCH_UNAVAILABLE envelope.
      const errorCard = page.getByTestId("search-error");
      await expect(errorCard).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("search-error-message")).toContainText(
        /temporarily unavailable/i,
      );
      // The error envelope carries a non-empty requestId; the
      // proxy must not have rewritten it to empty.
      const requestIdText = (
        (await page.getByTestId("search-error-request-id").textContent()) ?? ""
      ).trim();
      expect(requestIdText.length).toBeGreaterThan(0);

      // The retry affordance must be visible and the buyer's
      // brief must be preserved so the buyer can recover without
      // retyping.
      await expect(page.getByTestId("search-retry")).toBeVisible();
      await expect(page.getByTestId("search-input")).toHaveValue(query);

      // No result card and no empty state; the error envelope is
      // mutually exclusive with both.
      await expect(page.getByTestId("result-card")).toHaveCount(0);
      await expect(page.getByTestId("search-empty")).toHaveCount(0);
    } finally {
      // Restart the container in the finally block so a failure
      // above does not leave the database offline for the next
      // test file.
      await restoreTestDatabase();
    }
  });
});
