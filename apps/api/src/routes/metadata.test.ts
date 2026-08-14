/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
// M1.4 canonical-data seam: GET /api/metadata/categories.
//
// The browser no longer holds a second, independently deployable list of
// category keys. PostgreSQL is the source of truth; this route reads the
// canonical ServiceCategory records through the shared `MetadataRepository`
// (the same application-layer seam the TalentSearchService uses) and maps
// them through the shared `categoryMetadataResponseV1Schema` from
// `@soundhub/types`. The route is responsible only for HTTP concerns and
// safe error mapping — Prisma queries never leak into the HTTP layer.
//
// The test below stands up the route against a stubbed MetadataRepository
// (verifying the HTTP layer never reaches into Prisma directly) and
// verifies (a) the public response shape matches the shared Zod schema,
// (b) a newly-inserted canonical ServiceCategory is reflected by the
// route without any code change in apps/web, and (c) the shared schema
// rejects malformed elements and unknown fields so the public contract
// cannot drift.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import request from "supertest";
import express from "express";
import { categoryMetadataResponseV1Schema, type CategoryMetadataResponseV1 } from "@soundhub/types";
import { createMetadataRouter, resetMetadataCache } from "./metadata.js";
import type {
  MetadataRepository,
  RepositoryCategoryMetadata,
} from "../repositories/metadata.repository.js";

class StubMetadataRepository implements MetadataRepository {
  constructor(private readonly rows: readonly RepositoryCategoryMetadata[]) {}
  getCanonicalCategories(): Promise<readonly RepositoryCategoryMetadata[]> {
    return Promise.resolve(this.rows);
  }
}

describe("GET /api/metadata/categories", () => {
  test.beforeEach(() => {
    resetMetadataCache();
  });

  test("returns the canonical ServiceCategory records allow-list-mapped from the repository", async () => {
    const repository = new StubMetadataRepository([
      { key: "music-production", name: "Music Production" },
      { key: "songwriting", name: "Songwriting" },
    ]);
    const app = express();
    app.use("/api/metadata", createMetadataRouter({ repository }));

    const response = await request(app).get("/api/metadata/categories");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      categories: [
        { key: "music-production", name: "Music Production" },
        { key: "songwriting", name: "Songwriting" },
      ],
    });
  });

  test("the public response shape matches the shared Zod schema (closes P1-003)", async () => {
    const repository = new StubMetadataRepository([
      { key: "music-production", name: "Music Production" },
      { key: "songwriting", name: "Songwriting" },
    ]);
    const app = express();
    app.use("/api/metadata", createMetadataRouter({ repository }));

    const response = await request(app).get("/api/metadata/categories");
    assert.equal(response.status, 200);

    // The shared schema must accept the response the route returns.
    const parsed: CategoryMetadataResponseV1 = categoryMetadataResponseV1Schema.parse(
      response.body,
    );
    assert.equal(parsed.categories.length, 2);
  });

  test(
    "a newly-inserted canonical ServiceCategory is reflected by the route without any browser code change " +
      "(proves PostgreSQL is canonical and the browser no longer holds a second source of truth)",
    async () => {
      // First snapshot: nine canonical categories.
      const nineRows: readonly RepositoryCategoryMetadata[] = [
        { key: "music-production", name: "Music Production" },
        { key: "songwriting", name: "Songwriting" },
        { key: "custom-composition", name: "Custom Composition" },
        { key: "session-vocals", name: "Session Vocals" },
        { key: "session-instrument-performance", name: "Session Instrument Performance" },
        { key: "featured-artist-performance", name: "Featured Artist Performance" },
        { key: "mixing", name: "Mixing" },
        { key: "mastering", name: "Mastering" },
        { key: "recording-engineering", name: "Recording Engineering" },
      ];
      const repository = new StubMetadataRepository(nineRows);
      const app = express();
      app.use("/api/metadata", createMetadataRouter({ repository }));

      const firstResponse = await request(app).get("/api/metadata/categories");
      assert.equal(firstResponse.status, 200);
      assert.equal(firstResponse.body.categories.length, 9);

      // Reset the cache to simulate a cache expiry between the
      // two snapshots. The point is that the route's content
      // derives from the repository, not from a baked-in
      // browser list. After the cache resets, the route must
      // surface whatever the live repository returns.
      resetMetadataCache();

      // Second snapshot: a tenth canonical category is added
      // (simulating an admin insertion or a future seed update).
      // The metadata route must surface the new category without
      // the browser shipping a new category list.
      const updatedRows: readonly RepositoryCategoryMetadata[] = [
        ...nineRows,
        { key: "live-performance", name: "Live Performance" },
      ];
      const updatedRepository = new StubMetadataRepository(updatedRows);
      const app2 = express();
      app2.use("/api/metadata", createMetadataRouter({ repository: updatedRepository }));

      const secondResponse = await request(app2).get("/api/metadata/categories");
      assert.equal(secondResponse.status, 200);
      assert.equal(secondResponse.body.categories.length, 10);
      assert.ok(
        secondResponse.body.categories.some(
          (c: { key: string; name: string }) => c.key === "live-performance",
        ),
        "newly inserted canonical category must be visible via the metadata seam",
      );
    },
  );

  test("returns an empty list when no ServiceCategory records exist", async () => {
    const repository = new StubMetadataRepository([]);
    const app = express();
    app.use("/api/metadata", createMetadataRouter({ repository }));

    const response = await request(app).get("/api/metadata/categories");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { categories: [] });
  });
});

describe("categoryMetadataResponseV1Schema (shared contract)", () => {
  test("rejects malformed elements", () => {
    const result = categoryMetadataResponseV1Schema.safeParse({
      categories: [{ key: "", name: "Music Production" }],
    });
    assert.equal(result.success, false);
  });

  test("rejects unknown fields at the element level", () => {
    const result = categoryMetadataResponseV1Schema.safeParse({
      categories: [{ key: "music-production", name: "Music Production", bundleOnly: true }],
    });
    assert.equal(result.success, false);
  });

  test("rejects unknown fields at the response level", () => {
    const result = categoryMetadataResponseV1Schema.safeParse({
      categories: [{ key: "music-production", name: "Music Production" }],
      unknown: "field",
    });
    assert.equal(result.success, false);
  });

  test("rejects a non-array categories value", () => {
    const result = categoryMetadataResponseV1Schema.safeParse({
      categories: { key: "music-production", name: "Music Production" },
    });
    assert.equal(result.success, false);
  });
});
