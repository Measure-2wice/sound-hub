// Express Deal / TermsVersion / DealApproval router (BG5).
//
// Background: ticket #63 requires three API endpoints (draft terms,
// approve terms, view deal). The router wires them under
// /api/deals/:dealId and dispatches by URL suffix + HTTP method
// through the per-handler factories in `deal-terms-handlers.ts`.
//
// Per ticket #63 + the locked plan:
//   - The router never reads Workspace.ownerUserId.
//   - The router revalidates the BG1 session on every request.
//   - The safe error envelope is the single source of truth for the
//     response contract; no Prisma models cross this boundary.

import { Router } from "express";
import {
  createDealTermsRouter as buildHandler,
  type DealTermsRouteDeps,
} from "./deal-terms-handlers.js";

export type { DealTermsRouteDeps };

export function createDealTermsRouter(deps: DealTermsRouteDeps): Router {
  const router = Router();
  // All three endpoints share the same per-deal path. We dispatch by
  // method + path suffix inside the handler so a single Express
  // route is enough.
  router.all("/:dealId", (req, res, next) => {
    void buildHandler(deps)(req, res, next).catch(next);
  });
  router.all("/:dealId/terms-draft", (req, res, next) => {
    void buildHandler(deps)(req, res, next).catch(next);
  });
  router.all("/:dealId/approvals", (req, res, next) => {
    void buildHandler(deps)(req, res, next).catch(next);
  });
  return router;
}
