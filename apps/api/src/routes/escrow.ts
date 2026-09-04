/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import express, { Router, type Request, type Response } from "express";
import {
  createEscrowRequestV1Schema,
  createEscrowResponseV1Schema,
  escrowStateResponseV1Schema,
  escrowActionResponseV1Schema,
  type EscrowStateV1,
} from "@soundhub/types";
import { ZodError } from "zod";
import * as defaultBackendService from "../services/backend.service.js";
import {
  buildFieldErrors,
  buildSafeError,
  generateRequestId,
  writeSafeError,
} from "../lib/errors.js";

export interface EscrowService {
  ensureInitialized(): Promise<void>;
  createEscrow(
    provider: string,
    arbitrator: string,
    duration: number,
    value?: string,
  ): Promise<{ contractAddress: string; blockHash: string }>;
  getState(targetAddress?: string): Promise<string>;
  releasePayment(targetAddress?: string): Promise<unknown>;
  refundClient(targetAddress?: string): Promise<unknown>;
  raiseDispute(targetAddress?: string): Promise<unknown>;
  getSignerAddress(): Promise<string>;
}

export interface EscrowRouteDeps {
  readonly service?: EscrowService;
}

export function createEscrowRouter(deps: EscrowRouteDeps = {}): Router {
  const service = deps.service ?? defaultBackendService;
  const router = Router();
  router.use(express.json());

  // GET /api/escrow/signer - get platform signer address
  router.get("/signer", (req: Request, res: Response) => {
    void (async () => {
      const requestId = (req as Request & { requestId?: string }).requestId ?? generateRequestId();
      res.setHeader("x-request-id", requestId);
      try {
        await service.ensureInitialized();
        const address = await service.getSignerAddress();
        res.status(200).json({ address });
      } catch (err) {
        console.error(`[escrow] requestId=${requestId} failed to get signer:`, err);
        const safe = buildSafeError(
          "SEARCH_UNAVAILABLE",
          "Blockchain node is currently unavailable.",
          undefined,
          requestId,
        );
        writeSafeError(res, safe);
      }
    })();
  });

  // POST /api/escrow/create - instantiate new escrow contract
  router.post("/create", (req: Request, res: Response) => {
    void (async () => {
      const requestId = (req as Request & { requestId?: string }).requestId ?? generateRequestId();
      res.setHeader("x-request-id", requestId);

      let parsedBody;
      try {
        parsedBody = createEscrowRequestV1Schema.parse(req.body);
      } catch (err) {
        if (err instanceof ZodError) {
          const fields = buildFieldErrors(err.issues);
          const safe = buildSafeError(
            "INVALID_SEARCH_CRITERIA",
            "Validation failed for escrow creation parameters.",
            fields,
            requestId,
          );
          writeSafeError(res, safe);
          return;
        }
        const safe = buildSafeError(
          "INVALID_JSON",
          "Malformed request body.",
          undefined,
          requestId,
        );
        writeSafeError(res, safe);
        return;
      }

      try {
        await service.ensureInitialized();
        const arbitrator = parsedBody.arbitrator ?? (await service.getSignerAddress());
        const result = await service.createEscrow(
          parsedBody.provider,
          arbitrator,
          parsedBody.duration,
          parsedBody.value,
        );
        const payload = createEscrowResponseV1Schema.parse(result);
        res.status(201).json(payload);
      } catch (err: unknown) {
        console.error(`[escrow] requestId=${requestId} createEscrow failed:`, err);
        const errStr = err instanceof Error ? err.message : String(err);
        const message = errStr.includes("Contract Reverted")
          ? errStr
          : "Failed to deploy escrow contract.";
        const safe = buildSafeError("SEARCH_FAILED", message, undefined, requestId);
        writeSafeError(res, safe);
      }
    })();
  });

  // GET /api/escrow/:address/state - query on-chain escrow state
  router.get("/:address/state", (req: Request, res: Response) => {
    void (async () => {
      const requestId = (req as Request & { requestId?: string }).requestId ?? generateRequestId();
      res.setHeader("x-request-id", requestId);
      const { address } = req.params;

      if (!address || address.length < 10) {
        const safe = buildSafeError(
          "INVALID_SEARCH_CRITERIA",
          "Invalid contract address.",
          undefined,
          requestId,
        );
        writeSafeError(res, safe);
        return;
      }

      try {
        await service.ensureInitialized();
        const rawState = await service.getState(address);
        const state: EscrowStateV1 =
          rawState === "Funded" ||
          rawState === "Disputed" ||
          rawState === "Released" ||
          rawState === "Refunded"
            ? rawState
            : "Unknown";
        const payload = escrowStateResponseV1Schema.parse({ address, state });
        res.status(200).json(payload);
      } catch (err) {
        console.error(`[escrow] requestId=${requestId} getState failed for ${address}:`, err);
        const safe = buildSafeError(
          "SEARCH_FAILED",
          "Failed to query escrow contract state.",
          undefined,
          requestId,
        );
        writeSafeError(res, safe);
      }
    })();
  });

  // Action helper
  const handleAction = (actionName: "release" | "refund" | "dispute") => {
    return (req: Request, res: Response) => {
      void (async () => {
        const requestId =
          (req as Request & { requestId?: string }).requestId ?? generateRequestId();
        res.setHeader("x-request-id", requestId);
        const { address } = req.params;

        if (!address || address.length < 10) {
          const safe = buildSafeError(
            "INVALID_SEARCH_CRITERIA",
            "Invalid contract address.",
            undefined,
            requestId,
          );
          writeSafeError(res, safe);
          return;
        }

        try {
          await service.ensureInitialized();
          let txResult: unknown;
          if (actionName === "release") {
            txResult = await service.releasePayment(address);
          } else if (actionName === "refund") {
            txResult = await service.refundClient(address);
          } else {
            txResult = await service.raiseDispute(address);
          }

          let blockHash = "0x";
          if (typeof txResult === "string") {
            blockHash = txResult;
          } else if (
            txResult &&
            typeof txResult === "object" &&
            "blockHash" in txResult &&
            typeof txResult.blockHash === "string"
          ) {
            blockHash = txResult.blockHash;
          }

          let latestState: EscrowStateV1 = "Unknown";
          try {
            const rawState = await service.getState(address);
            if (
              rawState === "Funded" ||
              rawState === "Disputed" ||
              rawState === "Released" ||
              rawState === "Refunded"
            ) {
              latestState = rawState;
            }
          } catch {
            // Ignore state-check failure after successful action tx
          }

          const payload = escrowActionResponseV1Schema.parse({
            address,
            action: actionName,
            blockHash,
            state: latestState,
          });
          res.status(200).json(payload);
        } catch (err: unknown) {
          console.error(
            `[escrow] requestId=${requestId} ${actionName} failed for ${address}:`,
            err,
          );
          const errStr = err instanceof Error ? err.message : String(err);
          const message = errStr.includes("Contract Reverted")
            ? errStr
            : `Failed to execute ${actionName} action on escrow contract.`;
          const safe = buildSafeError("SEARCH_FAILED", message, undefined, requestId);
          writeSafeError(res, safe);
        }
      })();
    };
  };

  router.post("/:address/release", handleAction("release"));
  router.post("/:address/refund", handleAction("refund"));
  router.post("/:address/dispute", handleAction("dispute"));

  return router;
}
