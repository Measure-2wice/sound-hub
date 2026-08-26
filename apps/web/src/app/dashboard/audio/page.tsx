"use client";

// Seller audio management page.
//
// Background: ticket #61 requires that an authenticated seller acting
// through a currently authorized Seller-capable Workspace can upload,
// list, play, and remove MP3 discovery samples on a ServiceOffering
// owned by that Workspace. The page is intentionally simple: the
// seller selects the acting Workspace (the BG1 acting-Workspace
// command revalidates current membership), picks a ServiceOffering
// owned by that Workspace from a search of the canonical seed
// sellers, and the `AudioSamplesPanel` handles upload/list/play/
// remove end-to-end.
//
// The page is the buildathon-required seller management UI. The
// Golden E2E may use a previously uploaded or seeded sample; the
// browser journey does not need to demonstrate seller audio
// management live.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "../../components/SessionProvider";
import { Card } from "../../components/ui/Card";
import { bg1ActingWorkspaceResponseV1Schema } from "@soundhub/types";
import { AudioSamplesPanel } from "../audio-samples-panel";

interface SellerOption {
  readonly sellerId: string;
  readonly professionalName: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly offerings: readonly SellerOfferingOption[];
}

interface SellerOfferingOption {
  readonly offeringId: string;
  readonly title: string;
  readonly status: string;
}

export default function SellerAudioPage() {
  const { user, loading } = useSession();
  const [sellerOptions, setSellerOptions] = useState<readonly SellerOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [selectedWorkspaceName, setSelectedWorkspaceName] = useState<string>("");
  const [selectedOfferingId, setSelectedOfferingId] = useState<string>("");
  const [selectedOfferingTitle, setSelectedOfferingTitle] = useState<string>("");
  const [actingVerified, setActingVerified] = useState<boolean>(false);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      setLoadingOptions(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Use the public metadata seam to enumerate canonical
        // ServiceOfferings. Sellers (and the buildathon demo
        // operators) pick from the same canonical set the search
        // results emit; no parallel list is held in the browser.
        const response = await fetch("/api/metadata/services", {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        if (!response.ok) {
          throw new Error(`Could not load offering catalog (${response.status}).`);
        }
        const body: unknown = await response.json();
        const parsed = parseMetadataServicesResponse(body);
        if (cancelled) return;
        setSellerOptions(parsed);
        setOptionsError(null);
      } catch (err) {
        if (cancelled) return;
        setOptionsError(err instanceof Error ? err.message : "Could not load offering catalog.");
      } finally {
        if (!cancelled) setLoadingOptions(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading]);

  const sellerWorkspaces = useMemo(
    () => user?.workspaces.filter((workspace) => workspace.capabilities.includes("Seller")) ?? [],
    [user],
  );

  const handleVerifyActing = async () => {
    if (!selectedWorkspaceId) return;
    try {
      const response = await fetch("/api/auth/acting-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ actingWorkspaceId: selectedWorkspaceId }),
      });
      const body: unknown = await response.json();
      const parsed = bg1ActingWorkspaceResponseV1Schema.parse(body);
      setSelectedWorkspaceName(parsed.actingWorkspace.name);
      setActingVerified(true);
    } catch (err) {
      setOptionsError(
        err instanceof Error ? err.message : "Acting-Workspace command was rejected.",
      );
      setActingVerified(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12" data-testid="seller-audio-loading">
        <p className="text-gray-600">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12" data-testid="seller-audio-signed-out">
        <Card>
          <Card.Content>
            <p className="text-gray-700">
              You are not signed in.{" "}
              <Link href="/login" className="text-blue-600 hover:text-blue-700 font-medium">
                Sign in
              </Link>{" "}
              to manage discovery samples.
            </p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  if (sellerWorkspaces.length === 0) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12" data-testid="seller-audio-no-workspace">
        <Card>
          <Card.Content>
            <p className="text-gray-700">
              You do not currently belong to a Seller-capable Workspace. The seller management UI is
              only available to authorized seller Workspace members.
            </p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6" data-testid="seller-audio-page">
      <Card>
        <Card.Header>
          <Card.Title>Seller discovery samples</Card.Title>
          <p className="text-sm text-gray-600 mt-1">
            Pick the Workspace you are acting for and the ServiceOffering whose samples you want to
            manage.
          </p>
        </Card.Header>
        <Card.Content>
          <label className="block text-sm font-medium text-gray-800">
            <span>Acting Workspace</span>
            <select
              value={selectedWorkspaceId}
              onChange={(e) => {
                setSelectedWorkspaceId(e.currentTarget.value);
                setActingVerified(false);
              }}
              className="mt-1 w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
              data-testid="seller-audio-workspace-select"
            >
              <option value="">— select a Workspace —</option>
              {sellerWorkspaces.map((workspace) => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>
                  {workspace.name} ({workspace.workspaceType})
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            disabled={!selectedWorkspaceId}
            onClick={() => {
              void handleVerifyActing();
            }}
            className="mt-3 bg-emerald-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            data-testid="seller-audio-verify-acting"
          >
            Verify acting Workspace
          </button>

          {actingVerified && (
            <label className="block text-sm font-medium text-gray-800 mt-4">
              <span>ServiceOffering</span>
              <select
                value={selectedOfferingId}
                onChange={(e) => {
                  const next = e.currentTarget.value;
                  setSelectedOfferingId(next);
                  const offer = sellerOptions
                    .flatMap((s) => s.offerings)
                    .find((o) => o.offeringId === next);
                  setSelectedOfferingTitle(offer?.title ?? "");
                }}
                disabled={!selectedWorkspaceId}
                className="mt-1 w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
                data-testid="seller-audio-offering-select"
              >
                <option value="">— select a ServiceOffering —</option>
                {sellerOptions
                  .filter((s) => s.workspaceId === selectedWorkspaceId)
                  .flatMap((s) => s.offerings)
                  .map((offering) => (
                    <option key={offering.offeringId} value={offering.offeringId}>
                      {offering.title} ({offering.status})
                    </option>
                  ))}
              </select>
            </label>
          )}
        </Card.Content>
      </Card>

      {optionsError && (
        <Card
          variant="outlined"
          className="border-red-200 bg-red-50"
          data-testid="seller-audio-error"
        >
          <Card.Content>
            <p className="text-red-800">{optionsError}</p>
          </Card.Content>
        </Card>
      )}

      {loadingOptions ? (
        <p className="text-sm text-gray-600" data-testid="seller-audio-options-loading">
          Loading ServiceOffering catalog…
        </p>
      ) : null}

      {actingVerified && selectedOfferingId ? (
        <AudioSamplesPanel
          actingWorkspaceId={selectedWorkspaceId}
          actingWorkspaceName={selectedWorkspaceName}
          offeringId={selectedOfferingId}
          offeringTitle={selectedOfferingTitle}
        />
      ) : null}
    </div>
  );
}

function parseMetadataServicesResponse(body: unknown): readonly SellerOption[] {
  // The metadata seam is intentionally permissive here so a contract
  // drift surfaces as a visible message rather than a crash. The
  // shape returned by `/api/metadata/services` is owned by the same
  // shared Zod surface that drives the search result cards; if it
  // changes, the seller UI is updated in lockstep.
  if (!body || typeof body !== "object") return [];
  const candidate = body as { sellers?: unknown };
  if (!Array.isArray(candidate.sellers)) return [];
  const out: SellerOption[] = [];
  for (const entry of candidate.sellers) {
    if (!entry || typeof entry !== "object") continue;
    const seller = entry as {
      sellerId?: unknown;
      professionalName?: unknown;
      workspaceId?: unknown;
      workspaceName?: unknown;
      offerings?: unknown;
    };
    if (
      typeof seller.sellerId !== "string" ||
      typeof seller.workspaceId !== "string" ||
      typeof seller.workspaceName !== "string" ||
      typeof seller.professionalName !== "string" ||
      !Array.isArray(seller.offerings)
    ) {
      continue;
    }
    const offerings: SellerOfferingOption[] = [];
    for (const offering of seller.offerings) {
      if (!offering || typeof offering !== "object") continue;
      const o = offering as {
        offeringId?: unknown;
        title?: unknown;
        status?: unknown;
      };
      if (
        typeof o.offeringId === "string" &&
        typeof o.title === "string" &&
        typeof o.status === "string"
      ) {
        offerings.push({ offeringId: o.offeringId, title: o.title, status: o.status });
      }
    }
    out.push({
      sellerId: seller.sellerId,
      professionalName: seller.professionalName,
      workspaceId: seller.workspaceId,
      workspaceName: seller.workspaceName,
      offerings,
    });
  }
  return out;
}
