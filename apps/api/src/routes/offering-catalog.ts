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
// The catalog is the seeded `Active` and `Published` set the search
// repository already filters on, surfaced under
// `/api/metadata/services` as a public read-only list of
// `(workspaceId, workspaceName, professionalName, offeringId, title,
// status)` tuples. The seller UI filters this list client-side by
// the acting Workspace id. Authorization (WorkspaceMembership +
// Seller capability + offering ownership) is enforced again on every
// upload/list/remove command at the trusted boundary.

import { Router, type Request, type Response } from "express";
import {
  SellerProfileStatus,
  ServiceOfferingStatus,
  WorkspaceStatus,
  type PrismaClient,
} from "@soundhub/db";
import { buildSafeError, generateRequestId, writeSafeError } from "../lib/errors.js";

export interface OfferingCatalogRouteDeps {
  readonly prisma: PrismaClient;
}

export function createOfferingCatalogRouter(deps: OfferingCatalogRouteDeps): Router {
  const router = Router();
  router.get("/services", (_req: Request, res: Response) => {
    void handleServices(_req, res, deps);
  });
  return router;
}

interface OfferingSummary {
  readonly offeringId: string;
  readonly title: string;
  readonly status: string;
}

interface SellerSummary {
  readonly sellerId: string;
  readonly professionalName: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly offerings: readonly OfferingSummary[];
}

async function handleServices(
  _req: Request,
  res: Response,
  deps: OfferingCatalogRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  try {
    const profiles = await deps.prisma.sellerProfile.findMany({
      where: {
        status: SellerProfileStatus.Published,
        workspace: { is: { status: WorkspaceStatus.Active } },
      },
      include: {
        workspace: true,
        offerings: {
          orderBy: [{ id: "asc" }],
        },
      },
      orderBy: [{ id: "asc" }],
    });

    const sellers: SellerSummary[] = profiles.map((profile) => ({
      sellerId: profile.id,
      professionalName: profile.professionalName,
      workspaceId: profile.workspaceId,
      workspaceName: profile.workspace.name,
      offerings: profile.offerings
        .filter((offering) => offering.status === ServiceOfferingStatus.Active)
        .map((offering) => ({
          offeringId: offering.id,
          title: offering.title,
          status: offering.status,
        })),
    }));

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
