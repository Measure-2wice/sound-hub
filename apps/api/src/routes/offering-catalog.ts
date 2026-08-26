// Canonical ServiceOffering catalog seam.
//
// Background: ticket #61 introduces the seller management UI which
// needs to let an authenticated seller pick the ServiceOffering they
// want to manage. The seller can only manage offerings owned by their
// current Workspace, but a public canonical catalog is a stable
// foundation so the page does not duplicate the seed. The buyer
// already trusts the canonical list — the search results emit the
// same shape.
//
// Per the Standards review (P2-001), the catalog read/filter lives in
// the repository seam; this route is responsible only for HTTP
// handling and the validated allow-listed output.

import { Router, type Request, type Response } from "express";
import type { OfferingCatalogRepository } from "../repositories/offering-catalog.repository.js";
import { buildSafeError, generateRequestId, writeSafeError } from "../lib/errors.js";

export interface OfferingCatalogRouteDeps {
  readonly catalogRepository: OfferingCatalogRepository;
}

export function createOfferingCatalogRouter(deps: OfferingCatalogRouteDeps): Router {
  const router = Router();
  router.get("/services", (_req: Request, res: Response) => {
    void handleServices(_req, res, deps);
  });
  return router;
}

async function handleServices(
  _req: Request,
  res: Response,
  deps: OfferingCatalogRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  try {
    const sellers = await deps.catalogRepository.getCanonicalCatalog();
    res.status(200).json({ sellers });
  } catch (err) {
    console.error(`[offering-catalog] requestId=${requestId} unhandled:`, err);
    writeSafeError(
      res,
      buildSafeError(
        "SEARCH_FAILED",
        "An unexpected error occurred while loading the offering catalog.",
        undefined,
        requestId,
      ),
    );
  }
}
