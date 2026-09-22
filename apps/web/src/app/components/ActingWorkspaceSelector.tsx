"use client";

// Acting-Workspace selector (M2 #83).
//
// Background: the browser remembers one acting Workspace id in
// localStorage (per the corrected plan: NO server-side persistence
// of remembered selection). The selector renders an inline button
// for desktop and a compact control outside the menu for mobile,
// consistent with the M2 UX addendum's "compact acting-Workspace
// control outside the menu" pattern.
//
// Authorization rules:
//
//   - The remembered value is CLIENT convenience only. The
//     selector's accessible label and accompanying copy state
//     this — the customer never reads "current acting Workspace"
//     as an authority claim.
//   - Every consequential command names its acting Workspace
//     explicitly and the server revalidates current membership on
//     every request via the existing #82
//     `WorkspaceAuthorizationService.requireActingMembership`,
//     which accepts any Owner/Admin/Member role (the route is
//     NOT Owner-only per ticket #82).
//   - An inaccessible remembered value falls back to the user's
//     Personal Workspace (or the first accessible Workspace when
//     no Personal Workspace is accessible).
//
// Visual rules:
//
//   - Desktop: inline button with full Workspace name (truncated
//     visually with the full name in `title` + `aria-label`).
//   - Mobile: compact control outside the menu, full name
//     available to assistive technology via `aria-label`.
//   - Clicking the selector reveals a dropdown of every accessible
//     Workspace; selecting a Workspace navigates to the
//     `/workspace/switch` interstitial when the target is
//     different from the current acting Workspace.

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useActingWorkspace, useSetActingWorkspace, useSession } from "./SessionProvider";
import { isLocallyValidReturnPath } from "../lib/return-path-shape";

interface ActingWorkspaceSelectorProps {
  /** Layout variant. `"desktop"` for inline nav, `"mobile-compact"` for the menu-external chrome. */
  readonly variant: "desktop" | "mobile-compact";
}

export function ActingWorkspaceSelector({ variant }: ActingWorkspaceSelectorProps) {
  const { user } = useSession();
  const { actingWorkspace, actingWorkspaceId } = useActingWorkspace();
  const { setPendingTarget } = useSetActingWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownId = useId();

  // If the page that mounted the selector carried a validated
  // `?return=` through (e.g., the dashboard "switch to your
  // Personal Workspace" link from the Organization empty-state),
  // thread it forward through the Workspace-switch interstitial.
  // The switch page reads this URL parameter at commit time and
  // passes it to the server, which re-resolves it under the
  // POST-COMMIT acting Workspace context. Cancel ignores it.
  const forwardReturnTo = useMemo(() => {
    const raw = searchParams.get("return");
    if (!raw) return null;
    return isLocallyValidReturnPath(raw) ? raw : null;
  }, [searchParams]);

  // Close the dropdown when the user clicks outside it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Close on Escape; return focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!user) return null;

  const accessibleWorkspaces = user.workspaces.filter((w) => w.workspaceStatus === "Active");
  if (accessibleWorkspaces.length === 0) return null;

  // Render a passive label when only one Workspace is accessible —
  // there is nothing to switch to.
  if (accessibleWorkspaces.length === 1) {
    const only = accessibleWorkspaces[0]!;
    if (variant === "desktop") {
      return (
        <span
          className="text-sm font-medium text-ink truncate max-w-[16rem]"
          data-testid="acting-workspace-label"
          title={only.name}
        >
          {only.name}
        </span>
      );
    }
    return (
      <span
        className="text-sm font-medium text-ink truncate max-w-[10rem]"
        data-testid="acting-workspace-compact-label"
        title={only.name}
      >
        {only.name}
      </span>
    );
  }

  const handleSelect = (targetId: string) => {
    setOpen(false);
    if (targetId === actingWorkspaceId) return;
    // Set the candidate in-memory only. The localStorage write
    // happens AFTER `commitPendingTarget` resolves successfully on
    // the switch page; Cancel never touches committed state.
    setPendingTarget(targetId);
    const params = new URLSearchParams({ target: targetId });
    if (forwardReturnTo !== null) {
      params.set("return", forwardReturnTo);
    }
    router.push(`/workspace/switch?${params.toString()}`);
  };

  const currentName = actingWorkspace?.name ?? "Choose a Workspace";

  if (variant === "desktop") {
    return (
      <div ref={containerRef} className="relative">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={dropdownId}
          aria-label={`Acting Workspace: ${currentName}. Select to switch.`}
          className="inline-flex items-center gap-2 min-h-[44px] px-3 py-2 text-sm font-medium text-ink bg-surface hover:bg-surface/80 border border-borderWarm rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine truncate max-w-[16rem]"
          data-testid="acting-workspace-selector"
        >
          <span className="truncate" data-testid="acting-workspace-selector-name">
            {currentName}
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            className="w-3 h-3 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M3 4.5L6 7.5L9 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <ul
            id={dropdownId}
            role="listbox"
            aria-label="Switch acting Workspace"
            className="absolute right-0 top-full mt-1 z-20 min-w-[14rem] bg-surface border border-borderWarm rounded shadow-lg py-1 max-h-72 overflow-auto"
            data-testid="acting-workspace-dropdown"
          >
            {accessibleWorkspaces.map((workspace) => {
              const selected = workspace.workspaceId === actingWorkspaceId;
              return (
                <li key={workspace.workspaceId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => handleSelect(workspace.workspaceId)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-canvas focus:bg-canvas focus:outline-none ${
                      selected ? "font-medium text-ink" : "text-muted"
                    }`}
                    data-testid={`acting-workspace-option-${workspace.workspaceId}`}
                  >
                    <span className="block truncate">{workspace.name}</span>
                    <span className="block text-xs text-muted">
                      {workspace.workspaceType}
                      {workspace.capabilities.length > 0
                        ? ` · ${workspace.capabilities.join(", ")}`
                        : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  // mobile-compact variant.
  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={dropdownId}
        aria-label={`Acting Workspace: ${currentName}. Select to switch.`}
        className="inline-flex items-center gap-1 min-h-[44px] min-w-[44px] px-2 py-1 text-sm font-medium text-ink bg-transparent hover:bg-surface border border-borderWarm rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine truncate max-w-[10rem]"
        data-testid="acting-workspace-compact-selector"
      >
        <span className="truncate" data-testid="acting-workspace-compact-name">
          {currentName}
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="w-3 h-3 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 4.5L6 7.5L9 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul
          id={dropdownId}
          role="listbox"
          aria-label="Switch acting Workspace"
          className="absolute right-0 top-full mt-1 z-20 min-w-[14rem] bg-surface border border-borderWarm rounded shadow-lg py-1 max-h-72 overflow-auto"
          data-testid="acting-workspace-compact-dropdown"
        >
          {accessibleWorkspaces.map((workspace) => {
            const selected = workspace.workspaceId === actingWorkspaceId;
            return (
              <li key={workspace.workspaceId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => handleSelect(workspace.workspaceId)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-canvas focus:bg-canvas focus:outline-none ${
                    selected ? "font-medium text-ink" : "text-muted"
                  }`}
                  data-testid={`acting-workspace-compact-option-${workspace.workspaceId}`}
                >
                  <span className="block truncate">{workspace.name}</span>
                  <span className="block text-xs text-muted">
                    {workspace.workspaceType}
                    {workspace.capabilities.length > 0
                      ? ` · ${workspace.capabilities.join(", ")}`
                      : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
