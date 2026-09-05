// Deal-discovery list route handler (ticket #74).
//
// Route (mounted under /api/deals):
//
//   GET /api/deals?actingWorkspaceId=...
//     Returns the Deals discoverable through the acting Workspace:
//     the Deals where that EXACT Workspace is the buyer or seller
//     party. Every row carries human-readable context (offering
//     title, counterparty Workspace name), the Deal status, the
//     derived approval state, and the slim derived funding status.
//
// Authorization: the session cookie identifies the human; the
// `actingWorkspaceId` query parameter names the Workspace. The
// service revalidates current membership for that EXACT tuple inside
// the same transaction that reads the Deals, so a revoked member
// fails closed. Navigation visibility is never authorization — this
// route authorizes independently of what the UI chose to render.
//
// This handler reuses the BG5 session-resolution primitive. Request
// validation, response validation, and the internal-error envelope are
// local so every failure carries this surface's own DEAL_LIST_* code
// rather than a BG5 code.

import type { Request, Response } from "express";
import { ZodError } from "zod";
import { listDealsRequestV1Schema, listDealsResponseV1Schema } from "@soundhub/types";
import { buildFieldErrors, buildSafeError, writeSafeError } from "../lib/errors.js";
import { resolveSessionForDealTerms } from "./deal-terms-route-helpers.js";
import { DealListError, type DealListService } from "../deal-list/deal-list.service.js";

export interface DealListRouteDeps {
  readonly authenticationService: {
    resolveSession(id: string | undefined): Promise<unknown>;
  };
  readonly dealListService: Pick<DealListService, "listDeals">;
}

/**
 * Translate a typed `DealListError` into the safe envelope. Returns
 * true when the envelope was written so the caller can stop.
 */
function translateDealListServiceError(res: Response, err: unknown, requestId: string): boolean {
  if (err instanceof DealListError) {
    console.error(`[deal-list] requestId=${requestId} code=${err.code}:`, err);
    writeSafeError(res, buildSafeError(err.code, err.message, undefined, requestId));
    return true;
  }
  return false;
}

/**
 * Envelope an unexpected failure. Kept local (rather than reusing the
 * BG5 helper) so the log prefix and the error code identify the Deal
 * list rather than the BG5 terms slice. The underlying exception is
 * logged server-side and never echoed to the caller.
 */
function writeDealListInternalError(
  res: Response,
  err: unknown,
  requestId: string,
  contextLabel: string,
): void {
  console.error(`[deal-list] requestId=${requestId} ${contextLabel} unhandled:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "DEAL_LIST_FAILED",
      `An unexpected error occurred while ${contextLabel}.`,
      undefined,
      requestId,
    ),
  );
}

export function listDeals(deps: DealListRouteDeps): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    const resolved = await resolveSessionForDealTerms(
      req,
      res,
      deps.authenticationService,
      "view your Deals",
    );
    if (resolved === null) return;
    const { session, requestId } = resolved;

    // Validate the query against the shared contract so the schema
    // stays the single source of truth for the field name and bounds.
    const rawWorkspaceId = req.query["actingWorkspaceId"];
    let parsed: { readonly actingWorkspaceId: string };
    try {
      parsed = listDealsRequestV1Schema.parse({
        actingWorkspaceId: typeof rawWorkspaceId === "string" ? rawWorkspaceId : undefined,
      });
    } catch (err) {
      if (err instanceof ZodError) {
        writeSafeError(
          res,
          buildSafeError(
            "DEAL_LIST_INVALID",
            "Deal list request failed schema validation.",
            buildFieldErrors(err.issues),
            requestId,
          ),
        );
        return;
      }
      throw err;
    }

    try {
      const result = await deps.dealListService.listDeals({
        userAccountId: session.userAccountId,
        actingWorkspaceId: parsed.actingWorkspaceId,
      });
      // Validate the outgoing body against the shared contract before
      // it leaves the process. Deliberately NOT the BG5
      // `validateDealTermsResponse` helper: that one reports schema
      // drift as BG5_DEAL_INTERNAL_FAILED, which would be the wrong
      // surface's code for this route.
      const validated = listDealsResponseV1Schema.safeParse({
        ok: true as const,
        deals: [...result.deals],
      });
      if (!validated.success) {
        writeDealListInternalError(res, validated.error, requestId, "listing Deals");
        return;
      }
      res.status(200).json(validated.data);
    } catch (err) {
      if (translateDealListServiceError(res, err, requestId)) return;
      writeDealListInternalError(res, err, requestId, "listing Deals");
    }
  };
}
