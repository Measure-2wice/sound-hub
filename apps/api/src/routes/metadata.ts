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
// directly. The route reads through the repository on every request so
// PostgreSQL stays canonical without a process-global cache or an
// exported reset hook that could mask stale reads across separate
// `buildApp` instances.

import { Router, type Request, type Response } from "express";
import { categoryMetadataResponseV1Schema } from "@soundhub/types";
import { buildSafeError, generateRequestId, writeSafeError } from "../lib/errors.js";
import type { MetadataRepository } from "../repositories/metadata.repository.js";

export interface MetadataRouteDeps {
  readonly repository: MetadataRepository;
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

  try {
    const rows = await deps.repository.getCanonicalCategories();
    const payload = { categories: [...rows] };
    // Validate our own payload against the shared schema before
    // sending it. This catches drift between the repository
    // contract and the public contract the browser parses.
    const validated = categoryMetadataResponseV1Schema.parse(payload);
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
