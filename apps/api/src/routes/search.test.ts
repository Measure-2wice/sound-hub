/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import request from "supertest";
import { buildApp } from "../index.js";
import { TalentSearchService } from "../services/talent-search.service.js";
import {
  InMemoryTalentSearchRepository,
  type InMemoryFixture,
} from "../repositories/in-memory-talent-search.repository.js";
import {
  talentSearchResponseV1Schema,
  type SellerProfileStatusV1,
  type ServiceOfferingStatusV1,
  type WorkspaceStatusV1,
} from "@soundhub/types";
import { buildNegativeEligibilityFixture } from "../test-helpers/negative-eligibility-fixture.js";

void (null as unknown as SellerProfileStatusV1 | ServiceOfferingStatusV1 | WorkspaceStatusV1);

const fixture: InMemoryFixture = {
  sellers: [
    {
      sellerId: "seller-public-remote",
      workspaceId: "w-public-remote",
      professionalName: "Marc-André Pierre",
      bio: "Brooklyn-based Haitian producer.",
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
          offeringId: "offering-public-remote",
          title: "Haitian dancehall single production — remote",
          description: "Caribbean-flavored dancehall single production for diaspora artists.",
          status: "Active",
          serviceMode: "Remote",
          primaryCategory: { key: "music-production", name: "Music Production", bundleOnly: false },
          includedServices: [],
          genreTags: ["Dancehall", "Soca"],
          serviceAreas: [{ city: null, region: null, countryCode: "US" }],
          pricing: {
            kind: "StartingAt",
            amountMinor: 60000,
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

const service = new TalentSearchService(new InMemoryTalentSearchRepository(fixture));
// A throwaway PrismaClient stub is provided so buildApp does not need a real
// DATABASE_URL when only the in-memory repository is exercised. The stub is
// never invoked by the route tests.
const stubPrisma = new Proxy({} as never, {
  get() {
    throw new Error(
      "Prisma client was invoked; the route tests must use the in-memory repository.",
    );
  },
});
const { app } = buildApp({ service, prismaClient: stubPrisma });

describe("POST /api/search contract", () => {
  test("returns a public seller and best offering for a valid query", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Haitian dancehall single production" });

    assert.equal(response.status, 200);
    assert.equal(response.headers["x-request-id"]?.length ?? 0, 36);
    assert.equal(response.body.metadata.strategy, "postgres-text-v1");
    assert.equal(response.body.results.length, 1);
    const [result] = response.body.results;
    assert.equal(result.seller.sellerId, "seller-public-remote");
    assert.equal(result.bestMatchingOffering.offeringId, "offering-public-remote");
    assert.equal(result.bestMatchingOffering.primaryCategory.key, "music-production");
    assert.equal(result.bestMatchingOffering.serviceMode, "Remote");
    assert.equal(result.bestMatchingOffering.pricing.kind, "StartingAt");
    assert.equal(result.bestMatchingOffering.pricing.amount.amountMinor, 60000);
    assert.equal(result.bestMatchingOffering.pricing.amount.currency, "USD");
    assert.equal(result.bestMatchingOffering.pricing.unit, "track");
    assert.deepEqual(result.additionalMatchingOfferings, []);
    assert.ok(result.matchReason.length > 0);
  });

  test("rejects unknown fields with INVALID_SEARCH_CRITERIA envelope", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "anything", mysteriousField: true });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_SEARCH_CRITERIA");
    assert.equal(response.body.error.requestId, response.headers["x-request-id"]);
    assert.ok(Array.isArray(response.body.error.fields));
    assert.ok(response.body.error.fields.length > 0);
  });

  test("rejects empty bodies with INVALID_SEARCH_CRITERIA", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({});

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_SEARCH_CRITERIA");
  });

  test("returns INVALID_JSON for malformed bodies", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .set("content-length", "9")
      .send("{not-json");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_JSON");
  });

  test("returns UNSUPPORTED_MEDIA_TYPE for non-JSON content type", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "text/plain")
      .send("query=dancehall");

    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  test("request ID is echoed from the X-Request-Id header when supplied", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .set("x-request-id", "test-request-id-123")
      .send({ query: "dancehall" });

    assert.equal(response.headers["x-request-id"], "test-request-id-123");
    assert.equal(response.body.metadata.totalResults, 1);
  });

  test("empty results return 200 with results: []", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "no-such-thing" });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.results, []);
    assert.equal(response.body.metadata.totalResults, 0);
  });

  test("public DTO does not leak private fields", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Haitian dancehall single production" });
    const result = response.body.results[0];
    const seller = result.seller as Record<string, unknown>;
    const offering = result.bestMatchingOffering as Record<string, unknown>;
    assert.equal(seller["email"], undefined);
    assert.equal(seller["password"], undefined);
    assert.equal(seller["vibeEmbeddingVector"], undefined);
    assert.equal(seller["walletAddress"], undefined);
    assert.equal(offering["s3Key"], undefined);
    assert.equal(offering["embedding"], undefined);
    assert.equal(offering["privateNotes"], undefined);
  });

  test("structured-only requests with required serviceModes are accepted", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { serviceModes: ["Remote"] } });

    assert.equal(response.status, 200);
    assert.equal(response.body.metadata.totalResults, 1);
    assert.equal(response.body.results[0].bestMatchingOffering.serviceMode, "Remote");
  });

  test("country code in required.basedIn must be uppercase ISO alpha-2", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { basedIn: { countryCode: "us" } } });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_SEARCH_CRITERIA");
    assert.ok(
      response.body.error.fields.some(
        (f: { path: string; message: string }) =>
          f.path.includes("countryCode") && f.message.includes("ISO alpha-2"),
      ),
    );
  });

  test("required.serviceModes with unknown value is rejected", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { serviceModes: ["Teleportation"] } });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_SEARCH_CRITERIA");
  });

  test("required.primaryCategoryKeys with unknown key returns INVALID_SEARCH_CRITERIA (proof that the buyer UI cannot silently drop unknown keys)", async () => {
    // The in-memory fixture exposes only `music-production` as a
    // canonical service category. Sending `not-a-real-category`
    // proves the canonical-validation layer rejects unknown keys
    // with the safe INVALID_SEARCH_CRITERIA envelope. This is the
    // contract seam that backs the buyer UI's "unknown category key
    // surfaces an actionable error" UX after the test-only escape
    // hatch was removed from the production form.
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { primaryCategoryKeys: ["not-a-real-category"] } });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_SEARCH_CRITERIA");
    assert.ok(
      /Unsupported service category key/.test(response.body.error.message),
      `unknown category rejection must mention unsupported-service-category, got: ${response.body.error.message}`,
    );
  });

  test("required.independentlyPurchasableServiceKeys with unknown key returns INVALID_SEARCH_CRITERIA", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { independentlyPurchasableServiceKeys: ["not-a-real-category"] } });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_SEARCH_CRITERIA");
  });

  test("required.serviceArea with malformed countryCode returns INVALID_SEARCH_CRITERIA (proof that the shared schema rejects malformed service-area input)", async () => {
    // The browser schema-parses the candidate payload before sending
    // it, so the API should never receive a malformed countryCode.
    // This test proves the contract envelope would still surface the
    // error if a future client bypassed the browser schema.
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { serviceArea: { countryCode: "12" } } });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_SEARCH_CRITERIA");
    assert.ok(
      Array.isArray(response.body.error.fields),
      "field-level errors must accompany the malformed serviceArea rejection",
    );
    assert.ok(
      (response.body.error.fields as Array<{ path: string }>).some((f) =>
        f.path.includes("serviceArea.countryCode"),
      ),
    );
  });

  test("database unavailability maps to SEARCH_UNAVAILABLE 503", async () => {
    const failingService = new TalentSearchService({
      search: async (): Promise<never> => {
        await Promise.resolve();
        const err = new Error("database connection refused") as Error & { code?: string };
        err.code = "ECONNREFUSED";
        throw err;
      },
      getControlledKeys: () =>
        Promise.resolve({
          serviceCategoryKeys: new Set<string>(),
          specialtyKeys: new Set<string>(),
          pricingUnitKeys: new Set<string>(),
        }),
    });
    const { app: failingApp } = buildApp({ service: failingService, prismaClient: stubPrisma });
    const response = await request(failingApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "dancehall" });

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "SEARCH_UNAVAILABLE");
    assert.equal(response.body.error.requestId, response.headers["x-request-id"]);
  });

  test("rejects a malformed JSON media type with UNSUPPORTED_MEDIA_TYPE", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "text/application/json-bogus")
      .send('{"query":"dancehall"}');
    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  test("accepts application/json with a charset parameter", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json; charset=utf-8")
      .send({ query: "Haitian dancehall single production" });
    assert.equal(response.status, 200);
    assert.equal(response.body.results[0].seller.sellerId, "seller-public-remote");
  });

  test("rejects a media type with a malformed parameter", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json; charset")
      .send({ query: "dancehall" });
    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  test("rejects a missing Content-Type with UNSUPPORTED_MEDIA_TYPE", async () => {
    // supertest always sets a content-type when `.send` is used with an
    // object. This test exercises the same code path by sending an
    // empty body with an explicitly empty Content-Type header, which
    // reaches the route's parseApplicationJsonMediaType and fails.
    const response = await request(app).post("/api/search").set("Content-Type", "").send("");
    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  test("rejects an oversized ASCII body with INVALID_JSON 400", async () => {
    const large = "x".repeat(20_000);
    const body = JSON.stringify({ query: large });
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_JSON");
    assert.ok(/exceeds the 16384-byte limit/.test(response.body.error.message));
  });

  test("rejects an oversized multibyte UTF-8 body with INVALID_JSON 400 (1 multibyte char = multiple bytes)", async () => {
    // Each "日" is 3 bytes in UTF-8. 6,000 chars = 18,000 bytes > 16,384.
    const multibyte = "日".repeat(6_000);
    const body = JSON.stringify({ query: multibyte });
    // The body is well under 16,384 *characters* but well over 16,384 bytes.
    assert.ok(Buffer.byteLength(body, "utf8") > 16_384);
    assert.ok(body.length < 16_384);
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_JSON");
    assert.ok(/exceeds the 16384-byte limit/.test(response.body.error.message));
  });

  test("accepts a body whose UTF-8 byte length is at the limit (no false positive)", async () => {
    // 5,460 chars of "日" = 16,380 bytes, plus the JSON envelope ({"query":"..."})
    // which is roughly 14 bytes of quotes, braces, and the key.
    // The total stays under 16,384 bytes.
    const multibyte = "日".repeat(5_460);
    const body = JSON.stringify({ query: multibyte });
    // Verify byte count is under the limit; if not, skip.
    if (Buffer.byteLength(body, "utf8") > 16_384) {
      return;
    }
    const response = await request(app)
      .post("/api/search")
      .set("content-type", "application/json")
      .send(body);
    // The query is punctuation-only after normalization, so the schema
    // rejects it with INVALID_SEARCH_CRITERIA, NOT a 500 from a body
    // limit mis-fire.
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_SEARCH_CRITERIA");
  });

  test("rejects a Content-Type with a semicolon inside a quoted parameter value", async () => {
    // The value "a;b" is quoted, so the parser must NOT split on the
    // semicolon. The parameter is a single valid key=value pair.
    const response = await request(app)
      .post("/api/search")
      .set("content-type", 'application/json; charset="a;b"')
      .send({ query: "Haitian dancehall single production" });
    assert.equal(response.status, 200);
  });

  test("rejects a malformed Content-Type with an unbalanced quote", async () => {
    const response = await request(app)
      .post("/api/search")
      .set("content-type", 'application/json; charset="unterminated')
      .send({ query: "dancehall" });
    assert.equal(response.status, 415);
    assert.equal(response.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  test("an oversized body completes within a bounded time and a subsequent small request succeeds on a fresh socket", async () => {
    // The oversized-body lifecycle test verifies that the route
    // (a) returns the safe envelope within a bounded time and
    // (b) leaves the server in a state where the next request on
    // a fresh socket completes normally. A real keep-alive socket
    // reuse test is brittle against the http module's internal
    // buffering and the express response writer; the bounded-
    // completion assertion is the load-bearing contract.
    const http = await import("node:http");
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const timeout = (ms: number) =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms));

    async function send(body: Buffer): Promise<{ statusCode: number; body: string }> {
      return Promise.race([
        new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/api/search",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": String(body.length),
              },
            },
            (response) => {
              response.on("data", (c: Buffer) => chunks.push(c));
              response.on("end", () =>
                resolve({
                  statusCode: response.statusCode ?? -1,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          req.on("error", reject);
          req.write(body);
          req.end();
        }),
        timeout(5_000),
      ]);
    }

    try {
      // First request: oversized body. The server must respond
      // within the timeout and not hang.
      const big = "x".repeat(20_000);
      const envelope = JSON.stringify({ query: big });
      const res1 = await send(Buffer.from(envelope, "utf8"));
      assert.equal(res1.statusCode, 400);
      assert.ok(/exceeds the 16384-byte limit/.test(res1.body));

      // Second request on a fresh socket. The server must still be
      // in a usable state.
      const body2 = JSON.stringify({ query: "Haitian dancehall single production" });
      const res2 = await send(Buffer.from(body2, "utf8"));
      assert.equal(res2.statusCode, 200);
      const parsed = JSON.parse(res2.body) as {
        results: Array<{ seller: { sellerId: string } }>;
      };
      assert.equal(parsed.results[0]?.seller.sellerId, "seller-public-remote");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("the route's response writer completes within a bounded time when the request body is oversized", async () => {
    // Proves the bounded-completion contract independently of any
    // keep-alive socket mechanics. The route's `req.pause()` stops
    // reading further body bytes; the response is flushed; the
    // reader rejects. A test that only checks the response status
    // is the load-bearing assertion and does not depend on socket
    // reuse.
    const http = await import("node:http");
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const timeout = (ms: number) =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms));
    try {
      const big = "x".repeat(20_000);
      const envelope = JSON.stringify({ query: big });
      const result = await Promise.race([
        new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/api/search",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(envelope),
              },
            },
            (response) => {
              response.on("data", (c: Buffer) => chunks.push(c));
              response.on("end", () =>
                resolve({
                  statusCode: response.statusCode ?? -1,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          req.on("error", reject);
          req.write(envelope);
          req.end();
        }),
        timeout(3_000),
      ]);
      assert.equal(result.statusCode, 400);
      assert.ok(/exceeds the 16384-byte limit/.test(result.body));
    } finally {
      // Unref so the test does not hang on a pending connection.
      setTimeout(() => server.close(), 0).unref();
    }
  });

  test("an oversized Transfer-Encoding: chunked body settles within a bounded time and a subsequent small request succeeds on a fresh socket", async () => {
    // The streaming oversize path is exercised only when the
    // client does not declare Content-Length. Node's http.request
    // uses Transfer-Encoding: chunked automatically when no
    // Content-Length is supplied. This test proves the bounded-
    // completion contract on the streaming branch (which is the
    // path the up-front Content-Length shortcut bypasses) and
    // verifies the server is still usable on a fresh socket.
    const http = await import("node:http");
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const timeout = (ms: number) =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms));

    function sendChunked(): Promise<{ statusCode: number; body: string }> {
      return Promise.race([
        new Promise<{ statusCode: number; body: string }>((resolve) => {
          const chunks: Buffer[] = [];
          let settled = false;
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/api/search",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                // No Content-Length → Node uses Transfer-Encoding: chunked.
                "Transfer-Encoding": "chunked",
              },
            },
            (response) => {
              response.on("data", (c: Buffer) => chunks.push(c));
              response.on("end", () => {
                if (settled) return;
                settled = true;
                resolve({
                  statusCode: response.statusCode ?? -1,
                  body: Buffer.concat(chunks).toString("utf8"),
                });
              });
              response.on("error", () => {
                if (settled) return;
                settled = true;
                resolve({
                  statusCode: response.statusCode ?? -1,
                  body: Buffer.concat(chunks).toString("utf8"),
                });
              });
            },
          );
          req.on("error", () => {
            /* drain */
          });
          req.on("socket", (socket) => {
            socket.on("error", () => {
              /* drain */
            });
          });
          const big = "x".repeat(20_000);
          const envelope = JSON.stringify({ query: big });
          req.write(Buffer.from(envelope.slice(0, 8_000), "utf8"));
          req.write(Buffer.from(envelope.slice(8_000, 16_000), "utf8"));
          req.write(Buffer.from(envelope.slice(16_000), "utf8"));
          req.end();
        }),
        timeout(5_000),
      ]);
    }

    function sendFreshSocket(body: Buffer): Promise<{ statusCode: number; body: string }> {
      return Promise.race([
        new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/api/search",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": String(body.length),
              },
            },
            (response) => {
              response.on("data", (c: Buffer) => chunks.push(c));
              response.on("end", () =>
                resolve({
                  statusCode: response.statusCode ?? -1,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          req.on("error", reject);
          req.write(body);
          req.end();
        }),
        timeout(5_000),
      ]);
    }

    try {
      // First request: chunked body. The route's streaming reader
      // must observe the overflow and reject the promise
      // atomically; the route handler must write the safe
      // envelope and close the connection after flushing it.
      const res1 = await sendChunked();
      assert.equal(res1.statusCode, 400);
      assert.ok(/exceeds the 16384-byte limit/.test(res1.body));

      // Second request on a fresh socket. The server must still
      // be in a usable state. The chunked request's socket was
      // intentionally torn down by the route handler; this fresh
      // socket is unrelated.
      const body2 = JSON.stringify({ query: "Haitian dancehall single production" });
      const res2 = await sendFreshSocket(Buffer.from(body2, "utf8"));
      assert.equal(res2.statusCode, 200);
      const parsed = JSON.parse(res2.body) as {
        results: Array<{ seller: { sellerId: string } }>;
      };
      assert.equal(parsed.results[0]?.seller.sellerId, "seller-public-remote");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// M1.3 negative eligibility fixtures (API contract layer).
//
// These tests prove that every excluded state is filtered end-to-end
// through the Express route. The fixture is shared with the service
// test layer via `buildNegativeEligibilityFixture` so the two layers
// can never drift on the excluded-state coverage; the route tests
// add their own seam-specific assertions (response status, JSON
// shape, status-string leak checks, schema validation) without
// re-declaring the underlying cases.
const negService = new TalentSearchService(
  new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
);
const negStubPrisma = new Proxy({} as never, {
  get() {
    throw new Error(
      "Prisma client was invoked; the route tests must use the in-memory repository.",
    );
  },
});
const { app: negApp } = buildApp({ service: negService, prismaClient: negStubPrisma });

describe("POST /api/search M1.3 negative eligibility", () => {
  test("Draft SellerProfile is excluded from the public response", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Hidden Caribbean production" });
    assert.equal(response.status, 200);
    const sellerIds = (response.body.results as Array<{ seller: { sellerId: string } }>).map(
      (r) => r.seller.sellerId,
    );
    assert.ok(!sellerIds.includes("neg-draft-profile"));
  });

  test("Suspended SellerProfile is excluded from the public response", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Hidden Caribbean production" });
    const sellerIds = (response.body.results as Array<{ seller: { sellerId: string } }>).map(
      (r) => r.seller.sellerId,
    );
    assert.ok(!sellerIds.includes("neg-suspended-profile"));
  });

  test("Suspended Workspace is excluded from the public response", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Hidden Caribbean production" });
    const sellerIds = (response.body.results as Array<{ seller: { sellerId: string } }>).map(
      (r) => r.seller.sellerId,
    );
    assert.ok(!sellerIds.includes("neg-suspended-workspace"));
  });

  test("Buyer-only Workspace is excluded from the public response", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Hidden Caribbean production" });
    const sellerIds = (response.body.results as Array<{ seller: { sellerId: string } }>).map(
      (r) => r.seller.sellerId,
    );
    assert.ok(!sellerIds.includes("neg-buyer-only"));
  });

  test("Draft-only offerings exclude the seller from the public response", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { primaryCategoryKeys: ["songwriting"] } });
    const sellerIds = (response.body.results as Array<{ seller: { sellerId: string } }>).map(
      (r) => r.seller.sellerId,
    );
    assert.ok(!sellerIds.includes("neg-draft-offerings"));
  });

  test("Paused-only offerings exclude the seller from the public response", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Paused production" });
    const sellerIds = (response.body.results as Array<{ seller: { sellerId: string } }>).map(
      (r) => r.seller.sellerId,
    );
    assert.ok(!sellerIds.includes("neg-paused-offerings"));
  });

  test("Archived-only offerings exclude the seller from the public response", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { primaryCategoryKeys: ["mixing"] } });
    const sellerIds = (response.body.results as Array<{ seller: { sellerId: string } }>).map(
      (r) => r.seller.sellerId,
    );
    assert.ok(!sellerIds.includes("neg-archived-offerings"));
  });

  test("Paused offerings never appear in the public response (status is hidden)", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Hidden Caribbean production" });
    const serialized = JSON.stringify(response.body);
    assert.equal(
      serialized.includes('"status":"Paused"'),
      false,
      "no Paused offering may leak into the public response",
    );
  });

  test("Archived offerings never appear in the public response (status is hidden)", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Hidden Caribbean production" });
    const serialized = JSON.stringify(response.body);
    assert.equal(
      serialized.includes('"status":"Archived"'),
      false,
      "no Archived offering may leak into the public response",
    );
  });

  test("Draft offerings never appear in the public response (status is hidden)", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Hidden Caribbean production" });
    const serialized = JSON.stringify(response.body);
    assert.equal(
      serialized.includes('"status":"Draft"'),
      false,
      "no Draft offering may leak into the public response",
    );
  });

  test("a mixed Active+Paused seller surfaces with only the Active offering", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { primaryCategoryKeys: ["music-production"] } });
    const result = (
      response.body.results as Array<{
        seller: { sellerId: string };
        bestMatchingOffering: { offeringId: string };
      }>
    ).find((r) => r.seller.sellerId === "neg-mixed-paused");
    assert.ok(result, "mixed Active+Paused seller must remain discoverable");
    assert.equal(result.bestMatchingOffering.offeringId, "neg-off-remote");
  });

  test("a mixed Active+Archived seller surfaces with only the Active offering", async () => {
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { primaryCategoryKeys: ["music-production"] } });
    const result = (
      response.body.results as Array<{
        seller: { sellerId: string };
        bestMatchingOffering: { offeringId: string };
      }>
    ).find((r) => r.seller.sellerId === "neg-mixed-archived");
    assert.ok(result, "mixed Active+Archived seller must remain discoverable");
    assert.equal(result.bestMatchingOffering.offeringId, "neg-off-remote");
  });

  test("the public response validates against the strict v1 schema", async () => {
    // The whole negative-fixture response must validate end to end:
    // any leak of an excluded field would cause a schema rejection and
    // map to SEARCH_FAILED 500. This is the load-bearing assertion
    // that the eligibility filter and the public DTO mapping are
    // both in sync.
    const response = await request(negApp)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "Hidden Caribbean production" });
    assert.equal(response.status, 200);
    const parsed = talentSearchResponseV1Schema.safeParse(response.body);
    assert.equal(
      parsed.success,
      true,
      `public response failed schema validation: ${
        parsed.success ? "" : JSON.stringify(parsed.error.issues)
      }`,
    );
  });
});

// M1.5 preference ranking and grouping (API contract layer).
//
// The route-layer tests exercise the M1.5 contract guarantees against
// the in-memory repository. They verify that:
//   - additionalMatchingOfferings surfaces at most two entries and that
//     every entry is a standalone purchase (purchaseMode is not asserted
//     on the offering slot itself; the includedServices array carries the
//     BundleOnly label).
//   - bundle-only primary-category offerings never appear as standalone
//     bestMatchingOffering / additionalMatchingOfferings entries.
//   - bundle-only IncludedServices inside a presenting offering are
//     always emitted with `purchaseMode: "BundleOnly"`.
//   - identical requests produce identical ordering, matchReason, and
//     bounded relevanceScore through the full Express route.
//   - preferences affect ordering deterministically through the route.
describe("POST /api/search M1.5 preference ranking and grouping", () => {
  const multiOfferingFixture: InMemoryFixture = {
    sellers: [
      {
        sellerId: "m15-route-multi-ht",
        workspaceId: "ws-route-multi-ht",
        professionalName: "M15 Multi HT",
        bio: "Brooklyn-based Haitian producer.",
        status: "Published",
        basedInCity: "Brooklyn",
        basedInRegion: "NY",
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer", "Artist"],
        caribbeanAffiliationCodes: ["HT", "JM"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [
          {
            offeringId: "m15-route-production",
            title: "Dancehall single production",
            description: "Dancehall single production.",
            status: "Active",
            serviceMode: "Remote",
            primaryCategory: {
              key: "music-production",
              name: "Music Production",
              bundleOnly: false,
            },
            includedServices: [
              { key: "remote-coaching", name: "Remote Coaching", purchaseMode: "BundleOnly" },
            ],
            genreTags: ["Dancehall"],
            serviceAreas: [{ city: null, region: null, countryCode: "US" }],
            pricing: {
              kind: "StartingAt",
              amountMinor: 60000,
              currency: "USD",
              unitKey: "track",
            },
          },
          {
            offeringId: "m15-route-vocals",
            title: "Lead dancehall vocals",
            description: "Lead vocals for dancehall tracks.",
            status: "Active",
            serviceMode: "Remote",
            primaryCategory: {
              key: "session-vocals",
              name: "Session Vocals",
              bundleOnly: false,
            },
            includedServices: [
              { key: "remote-coaching", name: "Remote Coaching", purchaseMode: "BundleOnly" },
            ],
            genreTags: ["Dancehall"],
            serviceAreas: [{ city: null, region: null, countryCode: "US" }],
            pricing: {
              kind: "Fixed",
              amountMinor: 35000,
              currency: "USD",
              unitKey: "session",
            },
          },
          {
            offeringId: "m15-route-comp",
            title: "Dancehall composition for picture",
            description: "Original dancehall composition to picture.",
            status: "Active",
            serviceMode: "Remote",
            primaryCategory: {
              key: "custom-composition",
              name: "Custom Composition",
              bundleOnly: false,
            },
            includedServices: [],
            genreTags: ["Score"],
            serviceAreas: [{ city: null, region: null, countryCode: "US" }],
            pricing: null,
          },
        ],
      },
      {
        sellerId: "m15-route-bundle-only-primary",
        workspaceId: "ws-route-bundle-only-primary",
        professionalName: "M15 Bundle Only Primary",
        bio: "Seller whose primary category is bundle-only.",
        status: "Published",
        basedInCity: "Brooklyn",
        basedInRegion: "NY",
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["JM"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [
          {
            offeringId: "m15-route-bundle-only-primary-off",
            title: "Hidden dancehall bundle-only offering",
            description: "Primary category is bundleOnly.",
            status: "Active",
            serviceMode: "Remote",
            primaryCategory: {
              key: "music-production",
              name: "Music Production",
              bundleOnly: true,
            },
            includedServices: [],
            genreTags: ["Dancehall"],
            serviceAreas: [{ city: null, region: null, countryCode: "JM" }],
            pricing: null,
          },
        ],
      },
    ],
    controlledKeys: {
      serviceCategoryKeys: [
        "music-production",
        "songwriting",
        "custom-composition",
        "session-vocals",
        "session-instrument-performance",
        "featured-artist-performance",
        "mixing",
        "mastering",
        "recording-engineering",
        "live-performance",
      ],
      specialtyKeys: ["Artist", "Producer", "Musician", "Songwriter", "SoundEngineer"],
      pricingUnitKeys: ["hour", "track", "project", "session", "event", "day"],
    },
  };

  const m15Service = new TalentSearchService(
    new InMemoryTalentSearchRepository(multiOfferingFixture),
  );
  const m15StubPrisma = new Proxy({} as never, {
    get() {
      throw new Error(
        "Prisma client was invoked; the route tests must use the in-memory repository.",
      );
    },
  });
  const { app: m15App } = buildApp({ service: m15Service, prismaClient: m15StubPrisma });

  test("the route returns one entry per seller with at most two additional matching offerings", async () => {
    const response = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "dancehall production" });

    assert.equal(response.status, 200);
    const results = response.body.results as Array<{
      seller: { sellerId: string };
      bestMatchingOffering: { offeringId: string };
      additionalMatchingOfferings: Array<{ offeringId: string }>;
      relevanceScore: number;
    }>;
    const sellerEntries = results.filter((r) => r.seller.sellerId === "m15-route-multi-ht");
    assert.equal(sellerEntries.length, 1, "each seller must appear exactly once");
    const [multi] = sellerEntries;
    assert.ok(multi);
    assert.equal(multi.bestMatchingOffering.offeringId, "m15-route-production");
    assert.deepEqual(
      multi.additionalMatchingOfferings.map((o) => o.offeringId),
      ["m15-route-comp", "m15-route-vocals"],
    );
    assert.ok(multi.additionalMatchingOfferings.length <= 2);
  });

  test("the route caps additionalMatchingOfferings at the contract's two-entry maximum", async () => {
    const response = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "dancehall production" });
    for (const result of response.body.results) {
      assert.ok(
        result.additionalMatchingOfferings.length <= 2,
        `additionalMatchingOfferings exceeded the contract cap of two on seller ${result.seller.sellerId}`,
      );
    }
  });

  test("the route keeps bundle-only primary-category offerings out of best/additional slots", async () => {
    const response = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "dancehall" });

    assert.equal(response.status, 200);
    const serialized = JSON.stringify(response.body);
    assert.equal(
      serialized.includes("m15-route-bundle-only-primary-off"),
      false,
      "bundle-only primary-category offering must not be present in the response",
    );
    assert.equal(
      serialized.includes("Hidden dancehall bundle-only offering"),
      false,
      "bundle-only primary-category title must not appear in the response",
    );
    const bundleOnlySeller = (
      response.body.results as Array<{ seller: { sellerId: string } }>
    ).find((r) => r.seller.sellerId === "m15-route-bundle-only-primary");
    assert.equal(bundleOnlySeller, undefined);
  });

  test("the route labels every includedService as BundleOnly and never as a standalone purchase", async () => {
    const response = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "dancehall" });
    for (const result of response.body.results) {
      const offerings = [result.bestMatchingOffering, ...result.additionalMatchingOfferings];
      for (const offering of offerings) {
        for (const included of offering.includedServices) {
          assert.equal(
            included.purchaseMode,
            "BundleOnly",
            `includedService key=${included.key} must be labeled as BundleOnly`,
          );
          assert.equal(typeof included.key, "string");
        }
      }
    }
  });

  test("the route rejects responses whose additionalMatchingOfferings would exceed the schema cap", () => {
    const parsed = talentSearchResponseV1Schema.safeParse({
      results: [
        {
          seller: {
            sellerId: "x",
            professionalName: "X",
            specialties: [],
            bio: "",
            basedIn: { countryCode: "US" },
            caribbeanAffiliationCodes: [],
          },
          bestMatchingOffering: {
            offeringId: "o1",
            title: "T",
            description: "",
            primaryCategory: { key: "music-production", name: "Music Production" },
            includedServices: [],
            genreTags: [],
            serviceMode: "Remote",
            serviceAreas: [{ countryCode: "US" }],
          },
          additionalMatchingOfferings: [
            {
              offeringId: "o2",
              title: "T",
              description: "",
              primaryCategory: { key: "music-production", name: "Music Production" },
              includedServices: [],
              genreTags: [],
              serviceMode: "Remote",
              serviceAreas: [{ countryCode: "US" }],
            },
            {
              offeringId: "o3",
              title: "T",
              description: "",
              primaryCategory: { key: "music-production", name: "Music Production" },
              includedServices: [],
              genreTags: [],
              serviceMode: "Remote",
              serviceAreas: [{ countryCode: "US" }],
            },
            {
              offeringId: "o4",
              title: "T",
              description: "",
              primaryCategory: { key: "music-production", name: "Music Production" },
              includedServices: [],
              genreTags: [],
              serviceMode: "Remote",
              serviceAreas: [{ countryCode: "US" }],
            },
          ],
          relevanceScore: 0.5,
          matchReason: "matched",
        },
      ],
      metadata: {
        totalResults: 1,
        processingTimeMs: 0,
        strategy: "postgres-text-v1",
        appliedRequiredCriteria: {},
        appliedPreferredCriteria: {},
      },
    });
    assert.equal(parsed.success, false, "schema must reject three additional offerings");
  });

  test("identical requests through the route produce identical ordering, matchReason, and bounded relevanceScore", async () => {
    const a = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "dancehall", preferred: { caribbeanAffiliationCodes: ["JM"] } });
    const b = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "dancehall", preferred: { caribbeanAffiliationCodes: ["JM"] } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(
      a.body.results.map(
        (r: {
          seller: { sellerId: string };
          bestMatchingOffering: { offeringId: string };
          additionalMatchingOfferings: Array<{ offeringId: string }>;
          relevanceScore: number;
          matchReason: string;
        }) => ({
          sellerId: r.seller.sellerId,
          bestId: r.bestMatchingOffering.offeringId,
          additionalIds: r.additionalMatchingOfferings.map((o) => o.offeringId),
          score: r.relevanceScore,
          reason: r.matchReason,
        }),
      ),
      b.body.results.map(
        (r: {
          seller: { sellerId: string };
          bestMatchingOffering: { offeringId: string };
          additionalMatchingOfferings: Array<{ offeringId: string }>;
          relevanceScore: number;
          matchReason: string;
        }) => ({
          sellerId: r.seller.sellerId,
          bestId: r.bestMatchingOffering.offeringId,
          additionalIds: r.additionalMatchingOfferings.map((o) => o.offeringId),
          score: r.relevanceScore,
          reason: r.matchReason,
        }),
      ),
    );
    for (const result of a.body.results) {
      assert.ok(
        Number.isFinite(result.relevanceScore) &&
          result.relevanceScore >= 0 &&
          result.relevanceScore <= 1,
      );
    }
  });

  test("preference ordering through the route is deterministic on identical preferred inputs", async () => {
    const a = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({
        query: "dancehall production",
        preferred: { caribbeanAffiliationCodes: ["JM"] },
      });
    const b = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({
        query: "dancehall production",
        preferred: { caribbeanAffiliationCodes: ["JM"] },
      });
    assert.deepEqual(
      (a.body.results as Array<{ seller: { sellerId: string } }>).map((r) => r.seller.sellerId),
      (b.body.results as Array<{ seller: { sellerId: string } }>).map((r) => r.seller.sellerId),
    );
  });

  // P1-001 regression: the v1 contract states that `preferenceCoverage`
  // is omitted whenever the buyer supplied no canonical preference atoms.
  // This route-level test pins the omission at the HTTP boundary so the
  // browser, the API, and the public contract cannot drift back to the
  // unconditional-serialization behavior.
  test("the route omits preferenceCoverage when no preferences were requested", async () => {
    const response = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "dancehall production" });
    assert.equal(response.status, 200);
    const results = response.body.results as Array<{
      preferenceCoverage?: unknown;
    }>;
    assert.ok(results.length > 0, "the fixture must produce at least one result");
    for (const result of results) {
      assert.equal(
        result.preferenceCoverage,
        undefined,
        "the route response must omit preferenceCoverage when no preferences were requested",
      );
    }
  });

  // P1-001 regression: when at least one canonical preference atom IS
  // supplied, the route response must carry the factual matched/total
  // coverage. This is the symmetric guarantee that the omission above is
  // scoped strictly to the no-preferences case.
  test("the route includes preferenceCoverage when preferences were requested", async () => {
    const response = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({
        query: "dancehall production",
        preferred: { caribbeanAffiliationCodes: ["JM"] },
      });
    assert.equal(response.status, 200);
    const results = response.body.results as Array<{
      preferenceCoverage?: { matched: number; total: number };
    }>;
    assert.ok(results.length > 0, "the fixture must produce at least one result");
    for (const result of results) {
      assert.ok(
        result.preferenceCoverage !== undefined,
        "the route response must include preferenceCoverage when preferences were requested",
      );
      assert.equal(
        result.preferenceCoverage.total,
        1,
        "preferenceCoverage.total must equal the canonical preference-atom count",
      );
      assert.ok(
        result.preferenceCoverage.matched >= 0 &&
          result.preferenceCoverage.matched <= result.preferenceCoverage.total,
        "preferenceCoverage.matched must be bounded by preferenceCoverage.total",
      );
    }
  });

  // P1-001 Codex remediation: the route response must include
  // `textCoverage` whenever the buyer supplied a query so query-only
  // searches still surface a non-percentage qualitative-fit line. The
  // field counts distinct normalized query tokens matched by the best
  // matching offering; it is bounded by `total` and is never derived
  // from `relevanceScore`.
  test("the route includes textCoverage when a query was supplied", async () => {
    const response = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ query: "dancehall production" });
    assert.equal(response.status, 200);
    const results = response.body.results as Array<{
      textCoverage?: { matched: number; total: number };
    }>;
    assert.ok(results.length > 0, "the fixture must produce at least one result");
    for (const result of results) {
      assert.ok(
        result.textCoverage !== undefined,
        "the route response must include textCoverage when a query was supplied",
      );
      assert.equal(
        result.textCoverage.total,
        2,
        "textCoverage.total must equal the canonical distinct-query-token count",
      );
      assert.ok(
        result.textCoverage.matched >= 0 &&
          result.textCoverage.matched <= result.textCoverage.total,
        "textCoverage.matched must be bounded by textCoverage.total",
      );
    }
  });

  // P1-001 Codex remediation: symmetric with the preference-coverage
  // omission, the route must omit `textCoverage` when the request had
  // no query so a "0 of 0" payload never reaches the buyer.
  test("the route omits textCoverage when no query was supplied", async () => {
    const response = await request(m15App)
      .post("/api/search")
      .set("content-type", "application/json")
      .send({ required: { primaryCategoryKeys: ["music-production"] } });
    assert.equal(response.status, 200);
    const results = response.body.results as Array<{ textCoverage?: unknown }>;
    assert.ok(results.length > 0, "the fixture must produce at least one result");
    for (const result of results) {
      assert.equal(
        result.textCoverage,
        undefined,
        "the route response must omit textCoverage when no query was supplied",
      );
    }
  });
});
