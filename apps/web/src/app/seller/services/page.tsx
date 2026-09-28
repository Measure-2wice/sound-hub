"use client";

// ServiceOffering listing page (M2 #85).
//
// Background: the dashboard's Your Services surface lists the
// seller's ServiceOffering rows with their durable status aliased
// to the customer-facing presentation. Each row links into the
// editor surface. The page provides a "Create service" affordance
// that NAVIGATES to /seller/services/new/edit without making any
// server call — M2 (#85) PR-review feedback (round 3): the
// stable identity is created on the first successful save, so the
// listing page must NOT persist an empty row when the user clicks
// "Create service". The empty-form editor on /seller/services/new/edit
// renders without an offeringId; the editor's first Save creates
// the offering atomically with the user's submitted fields.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActingWorkspace, useSession } from "../../components/SessionProvider";
import { Alert } from "../../components/ui/Alert";
import { Card } from "../../components/ui/Card";
import {
  listServiceOfferings,
  type ServiceOfferingClientError,
} from "../../lib/service-offering-client";
import type { ServiceOfferingOwnerViewV1 } from "@soundhub/types";

export default function ServicesListPage() {
  const { user, loading } = useSession();
  const { actingWorkspace } = useActingWorkspace();
  const router = useRouter();
  const [offerings, setOfferings] = useState<readonly ServiceOfferingOwnerViewV1[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      void router.replace(`/login?return=${encodeURIComponent("/seller/services")}`);
      return;
    }
    if (!actingWorkspace) return;
    if (actingWorkspace.workspaceType !== "Personal") {
      void router.replace("/dashboard");
    }
  }, [loading, user, actingWorkspace, router]);

  useEffect(() => {
    if (!actingWorkspace || actingWorkspace.workspaceType !== "Personal") return;
    if (!actingWorkspace.capabilities.includes("Seller")) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await listServiceOfferings({
          workspaceId: actingWorkspace.workspaceId,
        });
        if (cancelled) return;
        setOfferings(result.offerings);
        setLoaded(true);
      } catch (err) {
        if (cancelled) return;
        const cls = err as ServiceOfferingClientError | null;
        setError(cls?.message ?? "Could not load your services.");
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actingWorkspace]);

  const handleCreate = () => {
    // M2 (#85) PR-review feedback (round 3): no server call. The
    // listing page NAVIGATES to the editor with no offeringId so
    // the first Save action creates the offering atomically with
    // the submitted fields. An empty row is never persisted.
    if (!actingWorkspace) return;
    void router.push("/seller/services/new/edit");
  };

  if (loading || !actingWorkspace) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <Alert role="status" variant="status" title="Loading…">
            Just a moment.
          </Alert>
        </div>
      </div>
    );
  }
  if (actingWorkspace.workspaceType !== "Personal") {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <Alert role="alert" variant="failure" title="Personal Workspace required">
            Service administration is available on a Personal Workspace only.
          </Alert>
        </div>
      </div>
    );
  }
  if (!actingWorkspace.capabilities.includes("Seller")) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <Alert role="alert" variant="failure" title="Seller capability required">
            This Workspace does not have the Seller capability.
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-8 space-y-6">
        <Card variant="parchment">
          <Card.Header>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-3xl font-serif text-ink">Your services</h1>
                <p className="text-base text-muted mt-1">
                  Each row shows the current lifecycle status. Activate one to make it visible to
                  buyers.
                </p>
              </div>
              <button
                type="button"
                onClick={handleCreate}
                className="inline-flex items-center justify-center min-h-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                data-testid="services-list-create"
              >
                Create service
              </button>
            </div>
          </Card.Header>
          <Card.Content>
            {error && (
              <Alert role="alert" variant="failure" title="Could not load your services">
                {error}
              </Alert>
            )}
            {loaded && offerings.length === 0 && !error && (
              <p className="text-sm text-muted" data-testid="services-list-empty">
                No services yet. Click "Create service" to start a draft.
              </p>
            )}
            <ul className="space-y-3" data-testid="services-list">
              {offerings.map((o) => (
                <li
                  key={o.serviceOfferingId}
                  className="flex items-center justify-between gap-3 p-3 border border-surface-variant rounded-md"
                  data-testid="services-list-row"
                >
                  <div>
                    <p className="font-medium text-ink">{o.title || "Untitled service"}</p>
                    <p className="text-xs text-muted">
                      {o.status === "Active"
                        ? "Available"
                        : o.status === "Draft"
                          ? "Private draft"
                          : o.status}
                    </p>
                  </div>
                  <Link
                    href={
                      `/seller/services/${encodeURIComponent(o.serviceOfferingId)}/edit` as never
                    }
                    className="inline-flex items-center justify-center min-h-[44px] py-2 px-4 text-sm font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                  >
                    Edit
                  </Link>
                </li>
              ))}
            </ul>
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
