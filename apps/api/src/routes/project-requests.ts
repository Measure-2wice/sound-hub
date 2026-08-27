// Express ProjectRequest routes (BG4).
//
// Background: ticket #62 requires the API surface that lets an
// authorized buyer create a ProjectRequest, the seller accept or
// decline, and either side view / list requests they belong to. The
// routes follow the same patterns as the BG3 matchmaker routes:
//
//   - Express owns untrusted JSON parsing and the safe error
//     envelope.
//   - The application service owns authorization and state
//     transitions; the route never reads Workspace.ownerUserId.
//   - The route revalidates the authenticated session on every
//     request; a stale cookie fails closed with SESSION_INVALID.
//
// Shared helpers extracted from the handlers (P2-001) keep the route
// policy in one place: session resolution, body parsing, error
// translation, response-schema validation, and logging all live in
// `project-request-route-helpers.ts`. Endpoint-specific behavior
// remains in the handler bodies.
//
// Routes:
//
//   POST /api/project-requests
//     Body: { actingWorkspaceId, projectBriefId, serviceOfferingId }.
//     Response: { ok: true, projectRequest } (a Pending request;
//     never a Deal).
//
//   GET /api/project-requests/:projectRequestId?actingWorkspaceId=...
//     Response: { projectRequest }. Revalidates current membership
//     on every read.
//
//   GET /api/project-requests?actingWorkspaceId=...&status=Pending|...
//     Response: { projectRequests }. Seller inbox uses status=Pending.
//
//   POST /api/project-requests/:projectRequestId/accept
//     Body: { actingWorkspaceId }. Response: { ok: true,
//     projectRequest, deal }. Atomically transitions Pending to
//     Accepted and creates exactly one Negotiating Deal.
//
//   POST /api/project-requests/:projectRequestId/decline
//     Body: { actingWorkspaceId }. Response: { ok: true,
//     projectRequest }. Atomically transitions Pending to Declined
//     and creates NO Deal.

import { Router } from "express";
import {
  acceptProjectRequestResponseV1Schema,
  createProjectRequestRequestV1Schema,
  createProjectRequestResponseV1Schema,
  declineProjectRequestResponseV1Schema,
  getProjectRequestResponseV1Schema,
  listProjectRequestsResponseV1Schema,
  respondProjectRequestRequestV1Schema,
  projectRequestStatusValuesV1,
  type ApiErrorCodeV1,
} from "@soundhub/types";
import type { AuthenticationService } from "../services/authentication.service.js";
import {
  ProjectRequestError,
  type ProjectRequestService,
} from "../project-request/project-request.service.js";
import {
  acceptProjectRequest,
  createProjectRequest,
  declineProjectRequest,
  getProjectRequest,
  listProjectRequests,
} from "./project-request-handlers.js";

export interface ProjectRequestRouteDeps {
  readonly authenticationService: AuthenticationService;
  readonly projectRequestService: ProjectRequestService;
}

export function createProjectRequestRouter(deps: ProjectRequestRouteDeps): Router {
  const router = Router();

  // List BEFORE `:projectRequestId` so the literal route wins the
  // Express path match. (Express's path-to-regexp would otherwise
  // treat `pending` as a path param; this explicit ordering
  // prevents that ambiguity.)
  router.get("/", (req, res, next) => {
    void listProjectRequests(deps)(req, res).catch(next);
  });
  router.post("/", (req, res, next) => {
    void createProjectRequest(deps)(req, res).catch(next);
  });
  router.get("/:projectRequestId", (req, res, next) => {
    void getProjectRequest(deps)(req, res).catch(next);
  });
  router.post("/:projectRequestId/accept", (req, res, next) => {
    void acceptProjectRequest(deps)(req, res).catch(next);
  });
  router.post("/:projectRequestId/decline", (req, res, next) => {
    void declineProjectRequest(deps)(req, res).catch(next);
  });

  return router;
}

// Re-export for tests that want to assert error codes verbatim.
export type ProjectRequestApiErrorCode = ApiErrorCodeV1;
export {
  projectRequestStatusValuesV1,
  acceptProjectRequestResponseV1Schema,
  createProjectRequestRequestV1Schema,
  createProjectRequestResponseV1Schema,
  declineProjectRequestResponseV1Schema,
  getProjectRequestResponseV1Schema,
  listProjectRequestsResponseV1Schema,
  respondProjectRequestRequestV1Schema,
  ProjectRequestError,
};
// Internal helpers are exported so the per-handler modules can use
// them without re-creating the same primitives.
export {
  resolveRequestId,
  resolveSessionForProjectRequest,
  readJsonBodyForProjectRequest,
  readPathParamForProjectRequest,
  readActingWorkspaceIdFromQuery,
  validateProjectRequestBody,
  validateProjectRequestResponse,
  translateProjectRequestServiceError,
} from "./project-request-route-helpers.js";
