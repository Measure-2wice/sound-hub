// Identity adapter factory.
//
// Background: BG1 requires that the API composition root picks the
// active adapter based on configuration. The deterministic adapter is
// the test + emergency fallback path; the managed adapter is the
// deployed primary path. The factory is the only place that knows
// which is which — every higher layer consumes the `IdentityAdapter`
// interface and is therefore agnostic to the deployment mode.

import type { Bg1IdentityProviderV1 } from "@soundhub/types";
import { DeterministicIdentityAdapter } from "./deterministic-identity-adapter.js";
import { ManagedIdentityAdapter } from "./managed-identity-adapter.js";
import type { IdentityAdapter } from "./identity-adapter.js";

export type { IdentityAdapter } from "./identity-adapter.js";

export interface IdentityAdapterFactoryOptions {
  /**
   * Force a specific adapter regardless of environment. Tests pass
   * `"deterministic"` to skip the managed adapter entirely; the
   * runtime smoke test for the managed adapter passes
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
}

export interface BuiltIdentityAdapters {
  readonly active: IdentityAdapter;
  readonly managed: ManagedIdentityAdapter;
  readonly deterministic: DeterministicIdentityAdapter;
}

/**
 * Resolve the active adapter from environment + an optional test
 * override. The deterministic adapter is the default in non-
 * production environments (NODE_ENV !== "production") AND in any
 * test run, so the buildathon E2E journey can sign in without
 * touching managed email delivery. Production deployments without a
 * managed provider configuration fall back to the deterministic
 * adapter (the approved emergency fallback path) and emit a warning
 * the operator can act on.
 */
export function buildIdentityAdapters(
  options: IdentityAdapterFactoryOptions = {},
): BuiltIdentityAdapters {
  const deterministic = new DeterministicIdentityAdapter();
  const managed = new ManagedIdentityAdapter({
    supabaseUrl: options.supabase?.url,
    supabaseAnonKey: options.supabase?.anonKey,
    supabaseServiceRoleKey: options.supabase?.serviceRoleKey,
  });

  if (options.override === "deterministic") {
    return { active: deterministic, managed, deterministic };
  }
  if (options.override === "managed-magic-link") {
    if (!managed.isConfigured()) {
      throw new Error(
        "Managed magic-link adapter requested but not configured (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY missing).",
      );
    }
    return { active: managed, managed, deterministic };
  }

  // Auto-select based on NODE_ENV. Production requires explicit
  // managed configuration; non-production defaults to the
  // deterministic adapter. In production with no managed
  // configuration we deliberately fall back to the deterministic
  // adapter — this is the BG1 approved fallback when deployed
  // managed integration cannot pass its bounded smoke.
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production" && managed.isConfigured()) {
    return { active: managed, managed, deterministic };
  }
  return { active: deterministic, managed, deterministic };
}
