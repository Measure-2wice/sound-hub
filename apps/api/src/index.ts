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
  type BuiltIdentityAdapters,
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
   * Pre-built identity adapter bundle. Compose-time callers (the
   * async app builder below) construct the bundle once via the
   * factory and pass it here so the same managed adapter instance
   * the smoke probed is also the instance serving the request.
   * Per ticket #59 P1-002 the served adapter MUST be the same
   * instance the smoke validated — building a second adapter
   * would let the callback URL drift out of sync with the
   * smoke's validated configuration.
   */
  readonly identityAdapters?: BuiltIdentityAdapters;
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
  // Per ticket #59 P1-002: when the caller has already built the
  // identity adapter bundle (the deployed entry point does this via
  // `buildAppWithSmoke`), inject the SAME bundle here so the
  // serving routes use the EXACT adapter instance the smoke
  // validated. Falling back to a fresh bundle only happens for
  // test code that wants the factory to construct its own
  // adapters; the served adapter in that path is still driven by
  // the supplied `managedSmoke` so tests cannot drift.
  const identityAdapters =
    options.identityAdapters ??
    buildIdentityAdapters({
      override: options.identityAdapterOverride,
      supabase: {
        url: process.env.SUPABASE_URL,
        anonKey: process.env.SUPABASE_ANON_KEY,
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
      emailRedirectTo: process.env.AUTH_CALLBACK_URL,
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
 * #59 P1-001 / P1-002). The factory owns the smoke so production
 * startup never silently picks the deterministic fallback, and
 * the smoke can never drift out of sync with the serving adapter
 * — the served adapter is the SAME instance the smoke validated.
 *
 * Per ticket #59 P1-001 the smoke is fail-closed; the factory
 * only selects the managed adapter when the smoke has proven
 * EVERY step: provider health, OTP request, callback verify,
 * AND the SoundHub server-side session round-trip. If any step
 * fails the factory selects the deterministic adapter as the
 * approved fallback.
 *
 * Test code continues to call {@link buildApp} directly with
 * mocked services so the unit suite remains network-free.
 */
export async function buildAppWithSmoke(
  options: Omit<AppOptions, "managedSmoke" | "identityAdapterOverride" | "identityAdapters"> = {},
): Promise<BuiltApp> {
  const prisma = options.prismaClient ?? createPrismaClient();
  const authRepository = options.authRepository ?? new PrismaAuthRepository(prisma);
  // Build the managed adapter ONCE so the smoke and the serving
  // routes share the SAME instance (per ticket #59 P1-002). The
  // factory's `emailRedirectTo` defaults to AUTH_CALLBACK_URL so
  // the callback URL the smoke validates is the exact value
  // serving uses.
  const { ManagedIdentityAdapter } = await import("./identity/managed-identity-adapter.js");
  const managed = new ManagedIdentityAdapter({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    emailRedirectTo: process.env.AUTH_CALLBACK_URL,
  });
  // The composition root also wires a SoundHub server-side session
  // probe so the smoke proves the verified provider identity
  // resolves to a persisted UserAccount and a SoundHub session
  // (ticket #59 P1-001). The probe is built against a temporary
  // AuthenticationService that uses the managed adapter the
  // composition root just constructed — so the smoke exercises
  // the application boundary the serving routes will use.
  const probeService = new AuthenticationService({
    identityAdapter: managed,
    authRepository,
  });
  const { buildSessionProbe } = await import("./identity/startup-smoke.js");
  const sessionProbe = buildSessionProbe(probeService);
  // Run the smoke ONCE through the factory using the SAME managed
  // adapter instance the composition root will serve. The factory
  // returns the bundle whose `active` adapter is either the
  // managed adapter (smoke passed) or the deterministic adapter
  // (smoke failed) — and the bundle exposes the managed instance
  // so tests can assert object identity with the serving adapter.
  const bundle = await buildIdentityAdaptersAsync({
    managed,
    log: (message) => {
      console.log(`[bg1] ${message}`);
    },
    smokeMailbox: process.env.BG1_SMOKE_MAILBOX,
    smokeVerifyToken: process.env.BG1_SMOKE_TEST_TOKEN,
    sessionProbe,
  });
  return buildApp({ ...options, identityAdapters: bundle, authRepository });
}
