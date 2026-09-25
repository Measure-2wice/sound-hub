// Remembered acting-Workspace client convenience (M2 #83).
//
// Background: the browser stores a single remembered acting-Workspace
// id in localStorage. The remembered value is convenience only — it
// is NEVER an authority source. Every consequential command names
// its acting Workspace explicitly and the server revalidates current
// membership on every request via the existing #82
// `requireActingMembership` route, which accepts any current
// Owner/Admin/Member role (NOT Owner-only).
//
// Inaccessible remembered values fall back to the user's Personal
// Workspace (per the M2 spec: "The Personal Workspace is the default
// private name."). When no Personal Workspace is accessible, the
// selector surfaces no default and waits for an explicit selection.
//
// Cross-tab synchronization is intentionally NOT implemented —
// each tab reads localStorage on mount and on every selection event.
// A future improvement could subscribe to `storage` events for
// cross-tab synchronization; #83 keeps the surface minimal.

const STORAGE_KEY = "soundhub.actingWorkspaceId";

/**
 * Read the remembered acting-Workspace id from localStorage.
 * Returns `null` when localStorage is unavailable, when no value
 * was stored, or when the stored value is not a non-empty string.
 */
export function readRememberedActingWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // localStorage can throw in privacy-mode / disabled-cookies
    // contexts. The selector falls back to the Personal Workspace
    // default; the failure never escalates to a UI error.
    return null;
  }
}

/**
 * Persist the user's selected acting-Workspace id. The browser
 * calls this after the user explicitly picks a Workspace in the
 * selector. The server is the authority; this is a remembered
 * convenience for the next page load.
 */
export function writeRememberedActingWorkspaceId(workspaceId: string): void {
  if (typeof window === "undefined") return;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, workspaceId);
  } catch {
    // Best-effort. The next page load re-derives from
    // `useSession()` when localStorage is unavailable.
  }
}

/**
 * Clear the remembered acting-Workspace id (e.g., on sign-out or
 * when the remembered Workspace becomes inaccessible). The next
 * page load falls back to the Personal Workspace default.
 */
export function clearRememberedActingWorkspaceId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}
