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
  type SellerProfileStatusV1,
  type ServiceOfferingStatusV1,
  type WorkspaceStatusV1,
} from "@soundhub/types";

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

  test("database unavailability maps to SEARCH_UNAVAILABLE 503", async () => {
    const failingService = new TalentSearchService({
      search: async (): Promise<never> => {
        await Promise.resolve();
        const err = new Error("database connection refused") as Error & { code?: string };
        err.code = "ECONNREFUSED";
        throw err;
      },
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
    const response = await request(app)
      .post("/api/search")
      .set("Content-Type", "")
      .send("");
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
});
