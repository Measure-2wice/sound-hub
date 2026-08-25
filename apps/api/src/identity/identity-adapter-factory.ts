// Identity adapter factory.
//
// Background: BG1 requires that the API composition root picks the
// active adapter based on configuration AND a bounded deployed-
// provider smoke. The deterministic adapter is the test + emergency
// fallback path; the managed adapter is the deployed primary path.
// The factory is the only place that knows which is which — every
// higher layer consumes the `IdentityAdapter` interface and is
// therefore agnostic to the deployment mode.
//
// Selection rules (ticket #59 GS 2):
//
//   1. An explicit override always wins.
//   2. Production requires the managed smoke to succeed. A
//      failing smoke falls back to the deterministic adapter and
//      records the decision in the factory log so the operator
//      can act on it. Per the ticket: "If deployed email
//      delivery, callback/session integration, or deployment
//      configuration cannot pass the bounded provider smoke
//      within that slice, the deterministic adapter is the
//      approved deployed fallback. This fallback changes
//      credential verification only and requires no redesign or
//      relaxation of Workspace authorization."
//
//   3. Non-production defaults to the deterministic adapter so
//      tests never accidentally contact a managed provider.
//
// Per ticket #59 P1-001, the async factory owns the smoke — the
// smoke runs on the SAME adapter instance the factory selects,
// so the smoke can never drift out of sync with the serving
// adapter. The sync factory is preserved for tests that want to
// inject a pre-computed smoke result.

import type { Bg1IdentityProviderV1 } from "@soundhub/types";
import { DeterministicIdentityAdapter } from "./deterministic-identity-adapter.js";
import { ManagedIdentityAdapter, type SmokeResult } from "./managed-identity-adapter.js";
import type { IdentityAdapter } from "./identity-adapter.js";
import { runStartupSmoke } from "./startup-smoke.js";

export type { IdentityAdapter } from "./identity-adapter.js";

export interface IdentityAdapterFactoryOptions {
  /**
   * Force a specific adapter regardless of environment. Tests pass
   * `"deterministic"` to skip the managed adapter entirely; the
   * bounded smoke for the managed adapter passes
   * `"managed-magic-link"` so it cannot be masked by a misconfigured
   * environment.
   */
  readonly override?: Bg1IdentityProviderV1;
  /**
   * Configuration for the managed adapter. Read once at composition
   * time so the deployed smoke test can verify the env-var contract
   * deterministically.
   */
  readonly supabase?: {
    readonly url?: string;
    readonly anonKey?: string;
    readonly serviceRoleKey?: string;
  };
  /**
   * Optional override for the managed smoke result. Tests pass an
   * explicit success/failure to exercise the factory decision
   * without a real network round-trip. The async factory ignores
   * this in favour of running the real smoke.
   */
  readonly managedSmoke?: SmokeResult;
  /**
   * Operator-injected captured magic-link token. Forwarded to the
   * startup smoke so the async factory can drive the verify step
   * end-to-end. Defaults to `process.env.BG1_SMOKE_TEST_TOKEN`
   * when unset; the async factory exposes the override so the
   * composition root can read the env var exactly once.
   */
  readonly smokeVerifyToken?: string;
  /**
   * Optional logger sink. The factory emits a single line when it
   * decides between managed and deterministic so operators can act
   * on the deployed fallback decision without spelunking the code.
   */
  readonly log?: (message: string) => void;
  /**
   * Operator-controlled escape hatch for the deterministic
   * fallback. When `true`, the deterministic adapter returns the
   * `devVerificationUrl` so the operator-driven recovery UI can
   * complete sign-in without email delivery. Defaults to `false`;
   * the deployed process enables it only when
   * `BG1_DETERMINISTIC_OPERATOR_MODE=1`. Tests pass `true` so the
   * existing automated journeys continue to work end to end.
   */
  readonly allowDeterministicOperatorMode?: boolean;
}

export interface BuiltIdentityAdapters {
  readonly active: IdentityAdapter;
  readonly managed: ManagedIdentityAdapter;
  readonly deterministic: DeterministicIdentityAdapter;
  /**
   * The smoke decision the factory made. Tests assert against this
   * to confirm the fallback selection logic.
   */
  readonly smokeResult: SmokeResult;
}

function buildAdaptersInternal(options: IdentityAdapterFactoryOptions): {
  deterministic: DeterministicIdentityAdapter;
  managed: ManagedIdentityAdapter;
  log: (message: string) => void;
  operatorMode: boolean;
} {
  const operatorMode =
    options.allowDeterministicOperatorMode ?? process.env.BG1_DETERMINISTIC_OPERATOR_MODE === "1";
  const deterministic = new DeterministicIdentityAdapter({
    allowDevVerificationUrl: operatorMode,
  });
  const managed = new ManagedIdentityAdapter({
    supabaseUrl: options.supabase?.url,
    supabaseAnonKey: options.supabase?.anonKey,
    supabaseServiceRoleKey: options.supabase?.serviceRoleKey,
  });
  return {
    deterministic,
    managed,
    log: options.log ?? ((message) => console.log(message)),
    operatorMode,
  };
}

function selectActive(input: {
  readonly managed: ManagedIdentityAdapter;
  readonly deterministic: DeterministicIdentityAdapter;
  readonly smokeResult: SmokeResult;
  readonly override: Bg1IdentityProviderV1 | undefined;
  readonly log: (message: string) => void;
}): { active: IdentityAdapter; smokeResult: SmokeResult } {
  const { managed, deterministic, override, log, smokeResult } = input;
  if (override === "deterministic") {
    return {
      active: deterministic,
      smokeResult: { ok: false, reason: "unconfigured", detail: "override=deterministic" },
    };
  }
  if (override === "managed-magic-link") {
    if (!managed.isConfigured()) {
      throw new Error(
        "Managed magic-link adapter requested but not configured (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY missing).",
      );
    }
    return { active: managed, smokeResult };
  }
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    if (managed.isConfigured() && smokeResult.ok) {
      log(
        `[identity] Managed magic-link smoke succeeded; using managed-magic-link adapter ` +
          `(${smokeResult.detail ?? "no detail"}).`,
      );
      return { active: managed, smokeResult };
    }
    log(
      `[identity] Managed magic-link smoke failed (${smokeResult.reason ?? "unknown"}: ` +
        `${smokeResult.detail ?? ""}); falling back to deterministic adapter as the approved ` +
        "BG1 emergency path.",
    );
    return { active: deterministic, smokeResult };
  }
  // Non-production defaults to the deterministic adapter so tests
  // and the local browser journey never accidentally contact a
  // managed provider. Operators may opt in by injecting a
  // successful smoke result.
  return { active: deterministic, smokeResult };
}

/**
 * Resolve the active adapter from environment, smoke, and an optional
 * test override. The smoke result is supplied by the caller (tests
 * inject a synthetic result); production code uses the async
 * variant below so the factory itself runs the smoke on its own
 * adapter instance.
 */
export function buildIdentityAdapters(
  options: IdentityAdapterFactoryOptions = {},
): BuiltIdentityAdapters {
  const { managed, deterministic, log } = buildAdaptersInternal(options);
  const smokeResult: SmokeResult = options.managedSmoke ?? {
    ok: false,
    reason: "unconfigured",
    detail: "no smoke result supplied",
  };
  const { active } = selectActive({
    managed,
    deterministic,
    smokeResult,
    override: options.override,
    log,
  });
  return { active, managed, deterministic, smokeResult };
}

/**
 * Async factory that owns the bounded deployed-provider smoke. Per
 * ticket #59 P1-001 the smoke MUST run on the SAME adapter instance
 * the serving application uses so the smoke can never drift out of
 * sync with the production selection. Tests should keep using the
 * synchronous `buildIdentityAdapters` with an injected smoke result.
 */
export async function buildIdentityAdaptersAsync(
  options: IdentityAdapterFactoryOptions = {},
): Promise<BuiltIdentityAdapters> {
  const { managed, deterministic, log } = buildAdaptersInternal(options);
  let smokeResult: SmokeResult;
  if (options.managedSmoke) {
    smokeResult = options.managedSmoke;
  } else {
    smokeResult = await runStartupSmoke({
      managed,
      verifyToken: options.smokeVerifyToken ?? process.env.BG1_SMOKE_TEST_TOKEN,
    });
  }
  const { active } = selectActive({
    managed,
    deterministic,
    smokeResult,
    override: options.override,
    log,
  });
  return { active, managed, deterministic, smokeResult };
}
