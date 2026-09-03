// BG6 PaymentIntent + activation router.
//
// Per refinement feedback this PR does NOT extract a shared helper
// module; the BG5 helpers are reused by direct import. The route
// here mirrors the BG5 thin-router pattern.

import { Router } from "express";
import { createFundingRouter, type FundingRouteDeps } from "./funding-handlers.js";

export function createBg6FundingRouter(deps: FundingRouteDeps): Router {
  const router = Router();
  router.post("/:dealId/funding", (req, res, next) => {
    void createFundingRouter(deps)(req, res, next).catch(next);
  });
  return router;
}
