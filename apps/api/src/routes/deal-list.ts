// Express Deal-discovery list router (ticket #74).
//
// Background: ticket #74 makes Deals discoverable from signed-in
// navigation. Before this ticket there was no collection endpoint —
// only the per-Deal routes under /api/deals/:dealId — so a user who
// left the creation workflow had to retain the raw Deal URL.
//
// The router exposes exactly one endpoint:
//
//   GET /api/deals?actingWorkspaceId=...
//
// It is mounted on the same "/api/deals" base as the BG5 terms router
// and the BG6 funding router, and must be registered BEFORE them:
// this router matches the collection path "/", which is distinct from
// their "/:dealId", but registering it first keeps the collection
// route unambiguously ahead of the per-Deal `router.all` dispatchers.
//
// Per ticket #74 + the accepted BG1/BG5 contracts:
//   - The router never reads Workspace.ownerUserId.
//   - The router revalidates the BG1 session on every request.
//   - Navigation visibility is never treated as authorization.
//   - The safe error envelope is the single source of truth for the
//     response contract; no Prisma models cross this boundary.

import { Router } from "express";
import { listDeals, type DealListRouteDeps } from "./deal-list-handlers.js";

export type { DealListRouteDeps };

export function createDealListRouter(deps: DealListRouteDeps): Router {
  const router = Router();
  router.get("/", (req, res, next) => {
    void listDeals(deps)(req, res).catch(next);
  });
  return router;
}
