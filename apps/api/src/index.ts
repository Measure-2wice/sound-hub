import "dotenv/config";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { healthRoutes } from "./routes/health.js";
import { createSearchRouter } from "./routes/search.js";
import { createMetadataRouter } from "./routes/metadata.js";
import { createAuthRouter } from "./routes/auth.js";
import { TalentSearchService } from "./services/talent-search.service.js";
import { AuthenticationService } from "./services/authentication.service.js";
import { WorkspaceAuthorizationService } from "./services/workspace-authorization.service.js";
import { PrismaTalentSearchRepository } from "./repositories/prisma-talent-search.repository.js";
import { PrismaMetadataRepository } from "./repositories/prisma-metadata.repository.js";
import { PrismaAuthRepository } from "./auth-repository/prisma-auth-repository.js";
import type { MetadataRepository } from "./repositories/metadata.repository.js";
import type { AuthRepository } from "./auth-repository/auth-repository.js";
import type { IdentityAdapter } from "./identity/identity-adapter.js";
import {
  buildIdentityAdapters,
  buildIdentityAdaptersAsync,
} from "./identity/identity-adapter-factory.js";
import type { SmokeResult } from "./identity/managed-identity-adapter.js";
import { buildSafeError, generateRequestId, writeSafeError } from "./lib/errors.js";

export interface AppOptions {
  readonly service?: TalentSearchService;
  readonly metadataRepository?: MetadataRepository;
  readonly prismaClient?: PrismaClient;
  readonly authenticationService?: AuthenticationService;
  readonly workspaceAuthorizationService?: WorkspaceAuthorizationService;
  readonly authRepository?: AuthRepository;
  readonly identityAdapter?: IdentityAdapter;
  /**
   * Pre-computed bounded smoke result. Tests inject an explicit
   * success/failure to exercise the factory decision without a
   * real network round-trip. Production callers should leave this
   * unset and use {@link buildAppWithSmoke} so the factory runs
   * the smoke on its own managed adapter (per ticket #59 P1-001).
   */
  readonly managedSmoke?: SmokeResult;
  /**
   * Explicit override for the identity adapter selection. When
   * supplied, the factory bypasses the smoke-driven selection
   * entirely. The smoke is still skipped in this mode so test
   * harnesses can stay network-free.
   */
  readonly identityAdapterOverride?: "managed-magic-link" | "deterministic";
}

export interface BuiltApp {
  readonly app: Application;
  readonly prisma: PrismaClient;
  readonly service: TalentSearchService;
  readonly authenticationService: AuthenticationService;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  readonly authRepository: AuthRepository;
  readonly identityAdapter: IdentityAdapter;
}

export function buildApp(options: AppOptions = {}): BuiltApp {
  const prisma = options.prismaClient ?? createPrismaClient();
  const service =
    options.service ?? new TalentSearchService(new PrismaTalentSearchRepository(prisma));
  const metadataRepository = options.metadataRepository ?? new PrismaMetadataRepository(prisma);

  const authRepository = options.authRepository ?? new PrismaAuthRepository(prisma);
  const identityAdapters = buildIdentityAdapters({
    override: options.identityAdapterOverride,
    supabase: {
      url: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_ANON_KEY,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
    log: (message) => {
      console.log(`[bg1] ${message}`);
    },
    managedSmoke: options.managedSmoke,
  });
  const identityAdapter = options.identityAdapter ?? identityAdapters.active;
  const authenticationService =
    options.authenticationService ?? new AuthenticationService({ identityAdapter, authRepository });
  const workspaceAuthorizationService =
    options.workspaceAuthorizationService ?? new WorkspaceAuthorizationService({ authRepository });

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
  app.use("/api/metadata", createMetadataRouter({ repository: metadataRepository }));
  app.use(
    "/api/auth",
    createAuthRouter({
      authenticationService,
      workspaceAuthorizationService,
      authRepository,
    }),
  );

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

  return {
    app,
    prisma,
    service,
    authenticationService,
    workspaceAuthorizationService,
    authRepository,
    identityAdapter,
  };
}

/**
 * Run the bounded deployed-provider smoke AND assemble the app,
 * using the same managed adapter the smoke probed (per ticket
 * #59 P1-001). This is the deployed-process entry point; the
 * factory owns the smoke so production startup never silently
 * picks the deterministic fallback, and the smoke can never
 * drift out of sync with the serving adapter. Test code
 * continues to call {@link buildApp} directly with mocked
 * services so the unit suite remains network-free.
 */
export async function buildAppWithSmoke(
  options: Omit<AppOptions, "managedSmoke" | "identityAdapterOverride"> = {},
): Promise<BuiltApp> {
  const identityAdapters = await buildIdentityAdaptersAsync({
    supabase: {
      url: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_ANON_KEY,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
    log: (message) => {
      console.log(`[bg1] ${message}`);
    },
    smokeVerifyToken: process.env.BG1_SMOKE_TEST_TOKEN,
  });
  return buildApp({ ...options, managedSmoke: identityAdapters.smokeResult });
}
