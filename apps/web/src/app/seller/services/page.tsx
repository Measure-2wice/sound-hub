"use client";

// ServiceOffering listing page (M2 #85).
//
// Background: the dashboard's Your Services surface lists the
// seller's ServiceOffering rows with their durable status aliased
// to the customer-facing presentation. Each row links into the
// editor surface. The page is read-only — activation, draft
// management, and audio management live on the editor surface
// (apps/web/src/app/seller/services/[offeringId]/edit/page.tsx).

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
            <h1 className="text-3xl font-serif text-ink">Your services</h1>
            <p className="text-base text-muted mt-1">
              Each row shows the current lifecycle status. Activate one to make it visible to
              buyers.
            </p>
          </Card.Header>
          <Card.Content>
            {error && (
              <Alert role="alert" variant="failure" title="Could not load your services">
                {error}
              </Alert>
            )}
            {loaded && offerings.length === 0 && !error && (
              <p className="text-sm text-muted" data-testid="services-list-empty">
                No services yet. Create your first service offering from the dashboard.
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
