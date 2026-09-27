// Public metadata seam.
//
// The M1.4 metadata route returns the canonical category catalog so the
// browser can populate its required-filter selects without holding a
// second, independently deployable list. PostgreSQL is the source of
// truth; this route reads the canonical ServiceCategory records through
// the shared `MetadataRepository` (the same application-layer seam the
// TalentSearchService uses) and maps them through the shared
// `categoryMetadataResponseV1Schema` from `@soundhub/types`.
//
// M2 (#84) extends the same seam with `GET /api/metadata/seller-profile-taxonomy`
// which returns the canonical Specialty catalog (read from the Specialty
// table) and the closed Caribbean affiliation code list with display
// names (closed const in `@soundhub/types`). One round trip on editor
// mount; no second, independently deployable list lives in the browser.
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
import {
  categoryMetadataResponseV1Schema,
  sellerProfileTaxonomyResponseV1Schema,
} from "@soundhub/types";
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
  // M2 (#84): Professional Profile editor / publication review
  // controlled-values catalog. Read-only, public (no auth), no acting
  // Workspace — the same shape as the existing `/categories` route.
  router.get("/seller-profile-taxonomy", (_req: Request, res: Response) => {
    void handleSellerProfileTaxonomy(_req, res, deps);
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

async function handleSellerProfileTaxonomy(
  _req: Request,
  res: Response,
  deps: MetadataRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);

  try {
    const [specialties, caribbeanAffiliationCodes] = await Promise.all([
      deps.repository.getCanonicalSpecialties(),
      deps.repository.getCanonicalCaribbeanAffiliationCodes(),
    ]);
    const payload = {
      specialties: [...specialties],
      caribbeanAffiliationCodes: [...caribbeanAffiliationCodes],
    };
    const validated = sellerProfileTaxonomyResponseV1Schema.parse(payload);
    res.status(200).json(validated);
  } catch (err) {
    console.error(`[metadata] requestId=${requestId} unhandled:`, err);
    const safe = buildSafeError(
      "SEARCH_FAILED",
      "An unexpected error occurred while loading the seller profile taxonomy.",
      undefined,
      requestId,
    );
    writeSafeError(res, safe);
  }
}
