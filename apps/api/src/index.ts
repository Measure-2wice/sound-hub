import "dotenv/config";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { healthRoutes } from "./routes/health.js";
import { createSearchRouter } from "./routes/search.js";
import { TalentSearchService } from "./services/talent-search.service.js";
import { PrismaTalentSearchRepository } from "./repositories/prisma-talent-search.repository.js";
import { buildSafeError, generateRequestId, writeSafeError } from "./lib/errors.js";

export interface AppOptions {
  readonly service?: TalentSearchService;
  readonly prismaClient?: PrismaClient;
}

export interface BuiltApp {
  readonly app: Application;
  readonly prisma: PrismaClient;
  readonly service: TalentSearchService;
}

export function buildApp(options: AppOptions = {}): BuiltApp {
  const prisma = options.prismaClient ?? createPrismaClient();
  const service =
    options.service ?? new TalentSearchService(new PrismaTalentSearchRepository(prisma));

  const app: Application = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
      credentials: true,
    }),
  );

  app.use((req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : generateRequestId();
    res.setHeader("x-request-id", requestId);
    (req as Request & { requestId?: string }).requestId = requestId;
    next();
  });

  app.use("/api/health", healthRoutes);
  app.use("/api/search", createSearchRouter({ service }));

  // 404 fallback
  app.use((req: Request, res: Response) => {
    const requestId = (req as Request & { requestId?: string }).requestId ?? generateRequestId();
    const safe = buildSafeError(
      "INVALID_SEARCH_CRITERIA",
      "Route not found.",
      undefined,
      requestId,
    );
    writeSafeError(res, safe);
  });

  // Error middleware
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const requestId = (req as Request & { requestId?: string }).requestId ?? generateRequestId();
    console.error(`[talent-search] requestId=${requestId} unhandled:`, err);
    const safe = buildSafeError(
      "SEARCH_FAILED",
      "An unexpected error occurred while processing the request.",
      undefined,
      requestId,
    );
    writeSafeError(res, safe);
  });

  return { app, prisma, service };
}
