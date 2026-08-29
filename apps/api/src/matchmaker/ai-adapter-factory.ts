// Matchmaker AI adapter factory.
//
// Background: the BG3 ticket requires the AI boundary to be
// provider-neutral. The factory owns the runtime decision between
// the managed adapter and the deterministic fallback, mirroring
// the BG1 identity-adapter factory pattern.
//
// Selection rules (ticket #60):
//
//   1. An explicit override always wins (tests pass
//      `"deterministic-fallback"`).
//   2. The managed adapter is selected only when it is configured
//      AND its bounded configuration smoke succeeds (presence of
//      base URL, API key, and model).
//   3. Otherwise the deterministic fallback is the active adapter.
//      Per the buildathon Golden Slice spec, the deterministic
//      fallback is the approved path; it crosses the same
//      validation + TalentSearchService boundary, so a missing
//      managed adapter is not a regression in buyer-facing
//      behaviour.
//
// The API key is read from `IMPALA_API_KEY` and is never logged,
// echoed in error messages, or returned by any factory accessor.
// The factory's only externally observable state is the selection
// result and the adapter instance.

import type { AiAdapter } from "./ai-adapter.js";
import { DeterministicAiAdapter } from "./deterministic-ai-adapter.js";
import { ImpalaAiAdapter, type ImpalaAdapterConfig } from "./impala-ai-adapter.js";
import type { HttpTransport } from "./http-transport.js";

export type AiProviderSelection = "managed" | "deterministic-fallback";

export interface AiAdapterFactoryOptions {
  /**
   * Force a specific adapter regardless of configuration. Tests
   * pass `"deterministic-fallback"` to skip the managed adapter
   * entirely.
   */
  readonly override?: AiProviderSelection;
  /**
   * Explicit managed-adapter configuration. When unset, the
   * factory attempts to construct the managed adapter from
   * `IMPALA_BASE_URL`, `IMPALA_API_KEY`, and `IMPALA_MODEL` env
   * vars. If any are missing or invalid, the deterministic
   * fallback is selected.
   */
  readonly managedConfig?: ImpalaAdapterConfig;
  /**
   * HTTP transport override. Tests inject a fake transport so the
   * factory does not touch the network. Production code leaves
   * this unset; the adapter defaults to `FetchHttpTransport`.
   */
  readonly transport?: HttpTransport;
  /**
   * Optional logger sink. The factory emits a single line when it
   * decides between managed and deterministic so operators can act
   * on the deployed fallback decision. The log message never
   * includes the API key, the full URL, or any request header.
   */
  readonly log?: (message: string) => void;
}

export interface BuiltAiAdapters {
  readonly active: AiAdapter;
  /**
   * The constructed managed adapter (if configuration was valid),
   * OR `null` when the factory fell back to deterministic. The
   * type is `ImpalaAiAdapter | null` so callers can introspect
   * configuration without depending on the legacy stub class.
   */
  readonly managed: ImpalaAiAdapter | null;
  readonly deterministic: DeterministicAiAdapter;
  readonly selection: AiProviderSelection;
}

/**
 * Read the managed-adapter configuration from `process.env`. The
 * returned object is `null` when any of the three required env vars
 * are missing or empty so the factory selects the deterministic
 * fallback. The API key is intentionally named with `_ENV_ONLY_` in
 * the log path so a misconfigured log sink cannot accidentally
 * print it.
 */
export function readImpalaConfigFromEnv(): ImpalaAdapterConfig | null {
  const baseUrl = process.env.IMPALA_BASE_URL;
  const apiKey = process.env.IMPALA_API_KEY;
  const model = process.env.IMPALA_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  if (apiKey.trim().length === 0) return null;
  if (!/^https?:\/\//.test(baseUrl)) return null;
  return { baseUrl, apiKey, model };
}

export function buildAiAdapters(options: AiAdapterFactoryOptions = {}): BuiltAiAdapters {
  const log = options.log ?? ((message) => console.log(message));
  const deterministic = new DeterministicAiAdapter();

  if (options.override === "deterministic-fallback") {
    log("[matchmaker] Deterministic fallback selected via override.");
    return {
      active: deterministic,
      managed: null,
      deterministic,
      selection: "deterministic-fallback",
    };
  }

  const managedConfig = options.managedConfig;
  if (managedConfig && managedConfig.apiKey.trim().length > 0) {
    const managed = new ImpalaAiAdapter(managedConfig, options.transport);
    log("[matchmaker] Managed AI adapter is configured; using managed adapter.");
    if (options.override === "managed") {
      log(
        "[matchmaker] Managed AI adapter selected via override; managed provider is authoritative.",
      );
      return { active: managed, managed, deterministic, selection: "managed" };
    }
    return { active: managed, managed, deterministic, selection: "managed" };
  }

  if (options.override === "managed") {
    throw new Error("Managed AI adapter requested but not configured for this deployment.");
  }

  log(
    "[matchmaker] Managed AI adapter is not configured; using deterministic fallback " +
      "(the approved BG3 buildathon path).",
  );
  return {
    active: deterministic,
    managed: null,
    deterministic,
    selection: "deterministic-fallback",
  };
}
