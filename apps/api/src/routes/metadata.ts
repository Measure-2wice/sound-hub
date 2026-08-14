// Public metadata seam for the M1 buyer UI.
//
// The browser NEVER holds a second, independently deployable list of
// category keys. It calls `GET /api/metadata/categories` on mount and
// uses the returned list to populate the `RequiredFilters` selects.
// PostgreSQL is the only source of truth; this route reads the
// canonical ServiceCategory records through the shared `MetadataRepository`
// and maps them through an allow-listed DTO that the browser parses
// with the shared `categoryMetadataResponseV1Schema` from `@soundhub/types`.
//
// The route is read-only, public, and never exposes private fields,
// controlled internal flags, or storage details. It depends only on the
// repository interface — Prisma queries never leak into the HTTP layer
// per the contract rule that routes and agents never query Prisma
// directly. The response is cached for a short window so the page does
// not refetch on every navigation; the cache key is the canonical
// service categories snapshot, which is server-controlled.

import { Router, type Request, type Response } from "express";
import { categoryMetadataResponseV1Schema, type CategoryMetadataResponseV1 } from "@soundhub/types";
import { buildSafeError, generateRequestId, writeSafeError } from "../lib/errors.js";
import type { MetadataRepository } from "../repositories/metadata.repository.js";

export interface MetadataRouteDeps {
  readonly repository: MetadataRepository;
}

const CACHE_TTL_MS = 60_000;
let cache: { readonly fetchedAt: number; readonly payload: CategoryMetadataResponseV1 } | null =
  null;

// Reset the in-memory cache. Exported for tests so they can
// observe the seeded catalog without waiting for the TTL to
// expire. Production code never calls this.
export function resetMetadataCache(): void {
  cache = null;
}

export function createMetadataRouter(deps: MetadataRouteDeps): Router {
  const router = Router();
  router.get("/categories", (_req: Request, res: Response) => {
    void handleCategories(_req, res, deps);
  });
  return router;
}

async function handleCategories(
  _req: Request,
  res: Response,
  deps: MetadataRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);

  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    res.status(200).json(cache.payload);
    return;
  }

  try {
    const rows = await deps.repository.getCanonicalCategories();
    const payload: CategoryMetadataResponseV1 = { categories: [...rows] };
    // Validate our own payload against the shared schema before
    // sending it. This catches drift between the repository
    // contract and the public contract the browser parses.
    const validated = categoryMetadataResponseV1Schema.parse(payload);
    cache = { fetchedAt: now, payload: validated };
    res.status(200).json(validated);
  } catch (err) {
    console.error(`[metadata] requestId=${requestId} unhandled:`, err);
    const safe = buildSafeError(
      "SEARCH_FAILED",
      "An unexpected error occurred while loading the category catalog.",
      undefined,
      requestId,
    );
    writeSafeError(res, safe);
  }
}
