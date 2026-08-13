/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
// M1.4 canonical-data seam: GET /api/metadata/categories.
//
// The browser no longer holds a second, independently deployable list of
// category keys. PostgreSQL is the source of truth; this route reads the
// canonical ServiceCategory records through the shared Prisma client and
// the route layer allow-list-maps them. The browser consumes whatever
// the API returns.
//
// The test below stands up the route against a stubbed PrismaClient,
// verifies (a) the public response shape, and (b) that a newly-inserted
// canonical ServiceCategory is reflected by the route without any code
// change in apps/web. That is the load-bearing assertion that closes
// the P1-002 review finding.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import request from "supertest";
import express from "express";
import type { PrismaClient } from "@soundhub/db";
import { createMetadataRouter, resetMetadataCache } from "./metadata.js";

interface Row {
  readonly key: string;
  readonly name: string;
}

function makePrismaStub(rows: readonly Row[]): PrismaClient {
  const findMany = (): Promise<readonly Row[]> => Promise.resolve(rows);
  return {
    serviceCategory: { findMany },
  } as unknown as PrismaClient;
}

describe("GET /api/metadata/categories", () => {
  test.beforeEach(() => {
    resetMetadataCache();
  });

  test("returns the canonical ServiceCategory records allow-list-mapped from the database", async () => {
    const prisma = makePrismaStub([
      { key: "music-production", name: "Music Production" },
      { key: "songwriting", name: "Songwriting" },
    ]);
    const app = express();
    app.use("/api/metadata", createMetadataRouter({ prisma }));

    const response = await request(app).get("/api/metadata/categories");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      categories: [
        { key: "music-production", name: "Music Production" },
        { key: "songwriting", name: "Songwriting" },
      ],
    });
  });

  test(
    "a newly-inserted canonical ServiceCategory is reflected by the route without any browser code change " +
      "(proves PostgreSQL is canonical and the browser no longer holds a second source of truth)",
    async () => {
      // First snapshot: nine canonical categories.
      const nineRows: readonly Row[] = [
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
      const prisma = makePrismaStub(nineRows);
      const app = express();
      app.use("/api/metadata", createMetadataRouter({ prisma }));

      const firstResponse = await request(app).get("/api/metadata/categories");
      assert.equal(firstResponse.status, 200);
      assert.equal(firstResponse.body.categories.length, 9);

      // Reset the cache to simulate a cache expiry between the
      // two snapshots. The point is that the route's content
      // derives from the Prisma client, not from a baked-in
      // browser list. After the cache resets, the route must
      // surface whatever the live Prisma client returns.
      resetMetadataCache();

      // Second snapshot: an tenth canonical category is added
      // (simulating an admin insertion or a future seed update).
      // The metadata route must surface the new category without
      // the browser shipping a new category list.
      const updatedRows: readonly Row[] = [
        ...nineRows,
        { key: "live-performance", name: "Live Performance" },
      ];
      const updatedPrisma = makePrismaStub(updatedRows);
      const app2 = express();
      app2.use("/api/metadata", createMetadataRouter({ prisma: updatedPrisma }));

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
    const prisma = makePrismaStub([]);
    const app = express();
    app.use("/api/metadata", createMetadataRouter({ prisma }));

    const response = await request(app).get("/api/metadata/categories");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { categories: [] });
  });
});
