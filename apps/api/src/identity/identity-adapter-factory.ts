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

import type { Bg1IdentityProviderV1 } from "@soundhub/types";
import { DeterministicIdentityAdapter } from "./deterministic-identity-adapter.js";
import { ManagedIdentityAdapter, type SmokeResult } from "./managed-identity-adapter.js";
import type { IdentityAdapter } from "./identity-adapter.js";

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
   * without a real network round-trip.
   */
  readonly managedSmoke?: SmokeResult;
  /**
   * Optional logger sink. The factory emits a single line when it
   * decides between managed and deterministic so operators can act
   * on the deployed fallback decision without spelunking the code.
   */
  readonly log?: (message: string) => void;
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

/**
 * Resolve the active adapter from environment, smoke, and an optional
 * test override.
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
  const log = options.log ?? ((message) => console.log(message));

  if (options.override === "deterministic") {
    return {
      active: deterministic,
      managed,
      deterministic,
      smokeResult: { ok: false, reason: "unconfigured", detail: "override=deterministic" },
    };
  }
  if (options.override === "managed-magic-link") {
    if (!managed.isConfigured()) {
      throw new Error(
        "Managed magic-link adapter requested but not configured (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY missing).",
      );
    }
    return { active: managed, managed, deterministic, smokeResult: { ok: true } };
  }

  // The smoke runs unless the caller injected a deterministic result.
  // We resolve the smoke synchronously here by reading the optional
  // override; the caller can run `managed.smoke()` themselves when
  // they want a real probe before calling `buildIdentityAdapters`.
  const smokeResult = options.managedSmoke ?? {
    ok: false,
    reason: "unconfigured",
    detail: "no smoke result supplied",
  };

  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    if (managed.isConfigured() && smokeResult.ok) {
      log("[identity] Managed magic-link smoke succeeded; using managed-magic-link adapter.");
      return { active: managed, managed, deterministic, smokeResult };
    }
    log(
      `[identity] Managed magic-link smoke failed (${smokeResult.reason ?? "unknown"}: ${smokeResult.detail ?? ""}); ` +
        "falling back to deterministic adapter as the approved BG1 emergency path.",
    );
    return { active: deterministic, managed, deterministic, smokeResult };
  }
  // Non-production defaults to the deterministic adapter so tests
  // and the local browser journey never accidentally contact a
  // managed provider. Operators may opt in by injecting a
  // successful smoke result.
  return { active: deterministic, managed, deterministic, smokeResult };
}
