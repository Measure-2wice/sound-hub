import "dotenv/config";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { healthRoutes } from "./routes/health.js";
import { createSearchRouter } from "./routes/search.js";
import { createMetadataRouter } from "./routes/metadata.js";
import { createAuthRouter } from "./routes/auth.js";
import { createAudioSamplesRouter } from "./routes/audio-samples.js";
import { createOfferingCatalogRouter } from "./routes/offering-catalog.js";
import { createMatchmakerRouter } from "./routes/matchmaker.js";
import { PrismaOfferingCatalogRepository } from "./repositories/prisma-offering-catalog.repository.js";
import { createProjectRequestRouter } from "./routes/project-requests.js";
import { TalentSearchService } from "./services/talent-search.service.js";
import { AuthenticationService } from "./services/authentication.service.js";
import { WorkspaceAuthorizationService } from "./services/workspace-authorization.service.js";
import { AudioSampleService } from "./services/audio-sample.service.js";
import { MatchmakerService } from "./services/matchmaker.service.js";
import { ProjectRequestService } from "./project-request/project-request.service.js";
import { PrismaTalentSearchRepository } from "./repositories/prisma-talent-search.repository.js";
import { PrismaMetadataRepository } from "./repositories/prisma-metadata.repository.js";
import { PrismaAuthRepository } from "./auth-repository/prisma-auth-repository.js";
import { PrismaAudioRepository } from "./audio-repository/prisma-audio-repository.js";
import { PrismaProjectBriefRepository } from "./matchmaker/prisma-project-brief.repository.js";
import { PrismaProjectRequestRepository } from "./project-request/prisma-project-request.repository.js";
import type { ProjectBriefRepository } from "./matchmaker/project-brief.repository.js";
import type { ProjectRequestRepository } from "./project-request/project-request.repository.js";
import type { MetadataRepository } from "./repositories/metadata.repository.js";
import type { AuthRepository } from "./auth-repository/auth-repository.js";
import type { AudioRepository } from "./audio-repository/audio-repository.js";
import type { IdentityAdapter } from "./identity/identity-adapter.js";
import type { AiAdapter } from "./matchmaker/ai-adapter.js";
import type { StorageAdapter } from "./storage/storage-adapter.js";
import { buildStorageAdapters, type BuiltStorageAdapters } from "./storage/storage-factory.js";
import {
  buildIdentityAdapters,
  buildIdentityAdaptersAsync,
  type BuiltIdentityAdapters,
} from "./identity/identity-adapter-factory.js";
import {
  buildAiAdapters,
  readImpalaConfigFromEnv,
  type BuiltAiAdapters,
} from "./matchmaker/ai-adapter-factory.js";
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
  /**
   * Pre-built AI adapter bundle. The Matchmaker service uses the
   * active adapter as its primary path; the deterministic fallback
   * is always wired in. Tests can inject their own bundle to
   * exercise the managed path.
   */
  readonly aiAdapters?: BuiltAiAdapters;
  readonly projectBriefRepository?: ProjectBriefRepository;
  readonly matchmakerService?: MatchmakerService;
  readonly aiAdapter?: AiAdapter;
  /**
   * Override for the audio repository. When supplied, the composition
   * root does NOT construct the Prisma adapter; the override is
   * served directly. Tests pass the in-memory adapter.
   */
  readonly audioRepository?: AudioRepository;
  /**
   * Pre-built storage adapter bundle. When supplied, the composition
   * root uses the same instance the served factory built so tests
   * can assert object identity. The factory's default selection is
   * driven by `BG2_STORAGE_BACKEND` and the Supabase configuration.
   */
  readonly storageAdapters?: BuiltStorageAdapters;
  /**
   * Override for the active storage adapter. When supplied, the
   * composition root uses this adapter instead of the bundle's
   * `active`. Tests inject a deterministic adapter.
   */
  readonly storageAdapterOverride?: StorageAdapter;
  /**
   * Override for the audio sample service. When supplied, the
   * composition root uses this service instead of constructing one
   * from the repository and storage adapter.
   */
  readonly audioSampleService?: AudioSampleService;
  readonly projectRequestRepository?: ProjectRequestRepository;
  readonly projectRequestService?: ProjectRequestService;
}

export interface BuiltApp {
  readonly app: Application;
  readonly prisma: PrismaClient;
  readonly service: TalentSearchService;
  readonly authenticationService: AuthenticationService;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  readonly authRepository: AuthRepository;
  readonly identityAdapter: IdentityAdapter;
  readonly matchmakerService: MatchmakerService;
  readonly aiAdapter: AiAdapter;
  readonly audioSampleService: AudioSampleService;
  readonly storageAdapter: StorageAdapter;
  readonly storageBackend: "supabase" | "deterministic";
  readonly projectRequestService: ProjectRequestService;
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

  // BG3 Matchmaker: build the AI adapter bundle (managed stub OR
  // deterministic fallback) and the project-brief repository, then
  // wire the MatchmakerService. The deterministic fallback is the
  // approved buildathon path; a future managed adapter slots in via
  // the factory without changing the service contract.
  //
  // The factory reads IMPALA_BASE_URL / IMPALA_API_KEY / IMPALA_MODEL
  // from the process env at composition time. The API key is held
  // inside the adapter instance and is never logged, returned by
  // the factory, or surfaced through any DTO.
  const aiAdapters =
    options.aiAdapters ??
    buildAiAdapters({
      managedConfig: readImpalaConfigFromEnv() ?? undefined,
      log: (message) => {
        console.log(`[matchmaker] ${message}`);
      },
    });
  const aiAdapter = options.aiAdapter ?? aiAdapters.active;
  const projectBriefRepository =
    options.projectBriefRepository ?? new PrismaProjectBriefRepository(prisma);
  const matchmakerService =
    options.matchmakerService ??
    new MatchmakerService({
      talentSearchService: service,
      workspaceAuthorizationService,
      projectBriefRepository,
      aiAdapter,
      fallbackAiAdapter: aiAdapters.deterministic,
    });

  // BG2: storage adapter bundle. The factory owns the
  // Supabase-vs-deterministic selection so the same env-var set
  // drives the identity adapter and the storage backend.
  const storageBundle =
    options.storageAdapters ??
    buildStorageAdapters({
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: process.env.SUPABASE_STORAGE_BUCKET,
      signedUrlExpiresInSeconds: process.env.SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS
        ? Number(process.env.SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS)
        : undefined,
      playbackBaseUrl: process.env.PUBLIC_API_BASE_URL ?? "http://localhost:4000",
    });
  const storageAdapter: StorageAdapter = options.storageAdapterOverride ?? storageBundle.active;

  const audioRepository = options.audioRepository ?? new PrismaAudioRepository(prisma);
  const audioSampleService =
    options.audioSampleService ??
    new AudioSampleService({
      repository: audioRepository,
      storage: storageAdapter,
      workspaceAuthorization: workspaceAuthorizationService,
      // The in-app playback route resolves relative to the API
      // origin. The browser fetches this URL for `<audio src=>`; the
      // route proxy-streams the bytes from the storage adapter.
      publicApiBaseUrl: process.env.PUBLIC_API_BASE_URL ?? "http://localhost:4000",
    });

  // BG4 ProjectRequest service. The composition root owns the
  // Prisma adapter; the service is the only boundary the route
  // and tests depend on.
  const projectRequestRepository =
    options.projectRequestRepository ?? new PrismaProjectRequestRepository(prisma);
  const projectRequestService =
    options.projectRequestService ??
    new ProjectRequestService({
      projectRequestRepository,
    });

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
  const catalogRepository = new PrismaOfferingCatalogRepository(prisma);
  app.use("/api/metadata", createOfferingCatalogRouter({ catalogRepository }));
  app.use(
    "/api/auth",
    createAuthRouter({
      authenticationService,
      workspaceAuthorizationService,
      authRepository,
    }),
  );
  app.use(
    "/api/matchmaker",
    createMatchmakerRouter({
      authenticationService,
      matchmakerService,
    }),
  );
  app.use(
    "/api",
    createAudioSamplesRouter({
      service: audioSampleService,
      authenticationService,
    }),
  );
  app.use(
    "/api/project-requests",
    createProjectRequestRouter({
      authenticationService,
      projectRequestService,
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
    matchmakerService,
    aiAdapter,
    audioSampleService,
    storageAdapter,
    storageBackend: storageBundle.backend,
    projectRequestService,
  };
}

/**
 * Run the bounded deployed-provider configuration smoke AND assemble
 * the app, using the same managed adapter the smoke probed. The
 * factory owns the smoke so production startup never silently
 * picks the deterministic fallback, and the smoke can never drift
 * out of sync with the serving adapter — the served adapter is the
 * SAME instance the smoke validated.
 *
 * Per ticket #59 the configuration smoke is a bounded,
 * non-destructive probe of the managed provider's `/auth/v1/health`
 * endpoint. It does NOT request, consume, or revoke a live
 * Supabase OTP. End-to-end managed email verification is validated
 * by an explicit bounded operational smoke procedure (see
 * `docs/deployment/managed-provider-smoke.md`), not by
 * application startup.
 *
 * Test code continues to call {@link buildApp} directly with
 * mocked services so the unit suite remains network-free.
 */
export async function buildAppWithSmoke(
  options: Omit<AppOptions, "managedSmoke" | "identityAdapterOverride" | "identityAdapters"> = {},
): Promise<BuiltApp> {
  const prisma = options.prismaClient ?? createPrismaClient();
  const authRepository = options.authRepository ?? new PrismaAuthRepository(prisma);
  // Build the managed adapter ONCE so the configuration smoke and
  // the serving routes share the SAME instance. The factory's
  // `emailRedirectTo` defaults to AUTH_CALLBACK_URL so the
  // callback URL the smoke validates is the exact value serving
  // uses.
  const { ManagedIdentityAdapter } = await import("./identity/managed-identity-adapter.js");
  const managed = new ManagedIdentityAdapter({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    emailRedirectTo: process.env.AUTH_CALLBACK_URL,
  });
  // Run the bounded configuration smoke ONCE through the factory
  // using the SAME managed adapter instance the composition root
  // will serve. The factory returns the bundle whose `active`
  // adapter is either the managed adapter (smoke passed) or the
  // deterministic adapter (smoke failed) — and the bundle exposes
  // the managed instance so tests can assert object identity with
  // the serving adapter.
  const bundle = await buildIdentityAdaptersAsync({
    managed,
    log: (message) => {
      console.log(`[bg1] ${message}`);
    },
  });
  // Per review nitpick: forward the Prisma client we created (and
  // bound `authRepository` to) into `buildApp`. Without this,
  // `buildApp` would call `options.prismaClient ?? createPrismaClient()`
  // and create a SECOND, unrelated client — the served repository
  // graph would split across two pools and only one of them would
  // ever be disconnected on shutdown.
  //
  // BG2: build the storage adapter bundle using the same Supabase
  // configuration the BG1 smoke probed, so the served routes use
  // the configured Supabase bucket (or the deterministic fallback)
  // without a second selection round.
  const storageBundle =
    options.storageAdapters ??
    buildStorageAdapters({
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: process.env.SUPABASE_STORAGE_BUCKET,
      signedUrlExpiresInSeconds: process.env.SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS
        ? Number(process.env.SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS)
        : undefined,
      playbackBaseUrl: process.env.PUBLIC_API_BASE_URL ?? "http://localhost:4000",
    });
  return buildApp({
    ...options,
    prismaClient: prisma,
    identityAdapters: bundle,
    authRepository,
    storageAdapters: storageBundle,
  });
}
