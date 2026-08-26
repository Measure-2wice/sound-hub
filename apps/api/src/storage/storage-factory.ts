// Storage adapter factory.
//
// Background: ticket #61 requires that the deployed primary storage
// path is Supabase Storage while deterministic fixtures satisfy the
// same application-facing contract in automated tests. The factory
// owns the selection so the composition root does not silently
// choose the wrong adapter.
//
// Selection rules:
//
//   - When `BG2_STORAGE_BACKEND` is set to `deterministic` (or
//     `BG2_SUPABASE_STORAGE_DISABLED=1`), the factory returns the
//     deterministic adapter. This is the explicit override used by
//     the deterministic browser journey and the unit/integration
//     tests that need storage semantics without a network round-trip.
//
//   - When the override is absent and the Supabase adapter reports
//     configured, the factory returns the Supabase adapter. The
//     configuration check is the same one `ManagedIdentityAdapter`
//     uses so a single env-var set drives both providers.
//
//   - When neither applies, the factory returns the deterministic
//     adapter. The application never silently disables storage; the
//     operator who left Supabase unconfigured gets a working
//     in-process backend with the same contract.

import { DeterministicStorageAdapter } from "./deterministic-storage-adapter.js";
import { SupabaseStorageAdapter } from "./supabase-storage-adapter.js";
import type { StorageAdapter } from "./storage-adapter.js";

export type StorageBackend = "supabase" | "deterministic";

export interface StorageFactoryDeps {
  readonly supabaseUrl?: string;
  readonly supabaseServiceRoleKey?: string;
  readonly bucket?: string;
  readonly signedUrlExpiresInSeconds?: number;
  readonly fetchImpl?: typeof fetch;
  readonly playbackBaseUrl?: string;
  readonly playbackTtlMs?: number;
  readonly now?: () => number;
}

export interface BuiltStorageAdapters {
  readonly active: StorageAdapter;
  readonly backend: StorageBackend;
  readonly supabase: SupabaseStorageAdapter;
  readonly deterministic: DeterministicStorageAdapter;
}

export function buildStorageAdapters(deps: StorageFactoryDeps = {}): BuiltStorageAdapters {
  const supabase = new SupabaseStorageAdapter({
    supabaseUrl: deps.supabaseUrl,
    supabaseServiceRoleKey: deps.supabaseServiceRoleKey,
    bucket: deps.bucket,
    signedUrlExpiresInSeconds: deps.signedUrlExpiresInSeconds,
    fetchImpl: deps.fetchImpl,
  });
  const deterministic = new DeterministicStorageAdapter({
    playbackBaseUrl: deps.playbackBaseUrl,
    playbackTtlMs: deps.playbackTtlMs,
    now: deps.now,
  });
  const backend = selectBackend({ supabase, explicit: process.env.BG2_STORAGE_BACKEND });
  const active: StorageAdapter = backend === "supabase" ? supabase : deterministic;
  return { active, backend, supabase, deterministic };
}

function selectBackend(input: {
  readonly supabase: SupabaseStorageAdapter;
  readonly explicit: string | undefined;
}): StorageBackend {
  if (input.explicit === "deterministic") return "deterministic";
  if (input.explicit === "supabase") return "supabase";
  if (input.supabase.isConfigured()) return "supabase";
  return "deterministic";
}
