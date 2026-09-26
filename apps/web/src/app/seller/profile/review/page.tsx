"use client";

// Professional Profile publication review (M2 #84).
//
// Background: the publication review is the read-only public
// preview + explicit Publish command surface. It is reachable
// from the editor (after a draft exists) and via the dashboard.
// The user confirms the versioned profile-publication attestation
// via a checkbox; the Publish command fires with a client-
// generated `idempotencyKey` that is RETAINED across the explicit
// Retry action and any uncertain transport outcome.
//
// Truthful post-publication state (the M2 #84 requirement):
//   - The Professional Profile is published.
//   - No ServiceOffering was created.
//   - No ServiceOffering was activated.
//   - Services are not yet available to buyers.
//   - The next step is to create the first service (#85).
//
// The success state renders this copy verbatim. No implicit
// redirect; the page stays on the success surface until the user
// dismisses.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { useActingWorkspace, useSession } from "../../../components/SessionProvider";
import { Alert } from "../../../components/ui/Alert";
import { Card } from "../../../components/ui/Card";
import {
  fetchSellerProfile,
  fetchSellerProfileTaxonomy,
  generateSellerProfileIdempotencyKey,
  publishSellerProfile,
  updatePublishedSellerProfile,
  asSellerProfileClientError,
} from "../../../lib/seller-profile-client";
import { navigateAfterPublish } from "../../../lib/navigate-after-publish";
import { SaveDraftActions, type SaveDraftActionState } from "../../../components/SaveDraftActions";
import { ErrorSummary, type ErrorSummaryItem } from "../../../components/ErrorSummary";
import type {
  ApiFieldErrorV1,
  SellerProfileOwnerViewV1,
  SellerProfileTaxonomyResponseV1,
} from "@soundhub/types";
import { isLocallyValidReturnPath } from "../../../lib/return-path-shape";

const CONFIRMATION_VERSION = "m2-profile-publication-v1" as const;

export default function ProfileReviewPage() {
  return (
    <Suspense fallback={<ReviewLoading />}>
      <ProfileReviewInner />
    </Suspense>
  );
}

function ReviewLoading() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
        <div className="max-w-3xl mx-auto" data-testid="profile-review-loading">
          <Alert role="status" variant="status" title="Loading your draft…">
            Just a moment.
          </Alert>
        </div>
      </div>
    </div>
  );
}

function ProfileReviewInner() {
  const { user, loading } = useSession();
  const { actingWorkspace } = useActingWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const validatedReturnTo = useMemo(() => {
    const raw = searchParams.get("return");
    if (!raw) return null;
    return isLocallyValidReturnPath(raw) ? raw : null;
  }, [searchParams]);

  const [taxonomy, setTaxonomy] = useState<SellerProfileTaxonomyResponseV1 | null>(null);
  const [profile, setProfile] = useState<SellerProfileOwnerViewV1 | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  // Submit state machine
  const [submitState, setSubmitState] = useState<SaveDraftActionState>("idle");
  const [submitErrorMessage, setSubmitErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<readonly ApiFieldErrorV1[]>([]);
  const [publishedSnapshot, setPublishedSnapshot] = useState<SellerProfileOwnerViewV1 | null>(null);

  // Per the approved retry lifecycle: the idempotencyKey is
  // generated when a new publication/update attempt begins and
  // retained across retries. Only definitive success OR user
  // abandonment clears it.
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    // Guard against running the bootstrap fetch before the acting
    // workspace resolves (StrictMode double-mount / first render).
    // Without this, the non-null assertion would throw and the
    // bootstrap-error state would persist even after the workspace
    // loads.
    if (!actingWorkspace) return;
    const workspaceId = actingWorkspace.workspaceId;
    let cancelled = false;
    void (async () => {
      try {
        const [taxonomyResult, profileResult] = await Promise.all([
          fetchSellerProfileTaxonomy(),
          fetchSellerProfile({ workspaceId }),
        ]);
        if (cancelled) return;
        setTaxonomy(taxonomyResult);
        setProfile(profileResult.profile);
      } catch (err) {
        if (cancelled) return;
        const cls = asSellerProfileClientError(err);
        setBootstrapError(cls?.message ?? "Could not load your professional profile.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actingWorkspace]);

  if (loading || !actingWorkspace) {
    return <ReviewLoading />;
  }
  if (actingWorkspace.workspaceType !== "Personal") {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <Alert role="alert" variant="failure" title="Personal Workspace required">
            Professional profile administration is available on a Personal Workspace only.
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
  if (bootstrapError) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <Alert role="alert" variant="failure" title="Could not load your draft">
            {bootstrapError}
          </Alert>
        </div>
      </div>
    );
  }
  if (!profile || !taxonomy) {
    return <ReviewLoading />;
  }

  if (publishedSnapshot) {
    return (
      <SuccessSurface
        profile={publishedSnapshot}
        onDismiss={() => {
          // After dismissal, navigate to dashboard (or safeReturnTo).
          router.replace((validatedReturnTo ?? "/dashboard") as Route);
        }}
      />
    );
  }

  const isPublished = profile.status === "Published";
  const isUpdate = isPublished;

  const summaryItems: ErrorSummaryItem[] = fieldErrors.map((err) => ({
    id: err.path.replace(/\./g, "-"),
    path: err.path,
    message: err.message,
  }));

  const performPublish = async (key: string) => {
    setSubmitState("saving");
    setSubmitErrorMessage(null);
    setFieldErrors([]);
    const payload = {
      identity: profile.identity,
      basedIn: profile.basedIn,
      disciplines: profile.disciplines,
      confirmationVersion: CONFIRMATION_VERSION,
      idempotencyKey: key,
    };
    try {
      const response = isUpdate
        ? await updatePublishedSellerProfile({
            workspaceId: actingWorkspace.workspaceId,
            update: payload,
          })
        : await publishSellerProfile({
            workspaceId: actingWorkspace.workspaceId,
            publish: payload,
          });
      setPublishedSnapshot(response.profile);
      // On definitive success, the user has reached the success
      // surface. The next attempt (if any) is a genuinely new
      // command — clear the retained key so the next Publish
      // generates a fresh one.
      idempotencyKeyRef.current = null;
      setSubmitState("saved");
      navigateAfterPublish({ router, response });
    } catch (err) {
      const cls = asSellerProfileClientError(err);
      if (cls) {
        setSubmitErrorMessage(cls.message);
        setFieldErrors(cls.fieldErrors);
      } else {
        setSubmitErrorMessage("Couldn't publish. Please try again.");
      }
      setSubmitState("error");
      void key; // keep the same idempotencyKey for Retry
    }
  };

  const handlePublish = () => {
    if (!confirmed) return;
    if (idempotencyKeyRef.current === null) {
      idempotencyKeyRef.current = generateSellerProfileIdempotencyKey();
    }
    void performPublish(idempotencyKeyRef.current);
  };

  const handleRetry = () => {
    if (idempotencyKeyRef.current === null) {
      idempotencyKeyRef.current = generateSellerProfileIdempotencyKey();
    }
    void performPublish(idempotencyKeyRef.current);
  };

  const handleAbandon = () => {
    // User-initiated abandonment. Clear the retained key so the
    // next attempt (if any) starts a fresh publication session.
    idempotencyKeyRef.current = null;
    router.replace((validatedReturnTo ?? "/seller/profile/edit") as Route);
  };

  const caribbeanNames = new Map(taxonomy.caribbeanAffiliationCodes.map((c) => [c.code, c.name]));
  const specialtyNames = new Map(taxonomy.specialties.map((s) => [s.key, s.name]));

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-8 space-y-6">
        <Card variant="parchment" data-testid="profile-review">
          <Card.Header>
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="font-label-sm uppercase tracking-widest text-muted">
                  {isUpdate ? "Update Professional Profile" : "Publish Professional Profile"}
                </span>
                <h1 className="text-3xl font-serif text-ink mt-1">
                  {isUpdate ? "Update Professional Profile" : "Review Professional Profile"}
                </h1>
                <p className="text-base text-muted mt-1">
                  Verify your marketplace identity before making it visible. Publishing establishes
                  your authenticated seller identity across SoundHub.
                </p>
              </div>
              <span
                className="font-label-md uppercase tracking-wider text-muted"
                data-testid="profile-review-status"
              >
                {isUpdate ? "Published · awaiting update" : "Private draft · awaiting publication"}
              </span>
            </div>
          </Card.Header>
          <Card.Content className="space-y-6">
            {summaryItems.length > 0 && (
              <ErrorSummary
                title="Publication could not be completed:"
                errors={summaryItems}
                testId="profile-review-error-summary"
              />
            )}

            <article className="bg-surface-container-lowest border border-borderWarm rounded-xl p-6 space-y-4">
              <header className="flex items-start gap-4">
                <div className="flex-1 flex flex-col gap-1">
                  <span className="font-label-sm uppercase tracking-wider text-muted">
                    Public Professional Identity
                  </span>
                  <h2 className="text-2xl font-serif text-ink">
                    {profile.identity.professionalName}
                  </h2>
                  <div className="flex items-center gap-2 text-muted">
                    <span aria-hidden="true">📍</span>
                    <span className="text-base text-ink">
                      {profile.basedIn.city ?? ""}
                      {profile.basedIn.city ? ", " : ""}
                      {profile.basedIn.region ?? ""}
                      {profile.basedIn.city || profile.basedIn.region ? ", " : ""}
                      {profile.basedIn.countryCode}
                    </span>
                  </div>
                  <span className="text-xs text-muted">Marketplace operational location only</span>
                </div>
              </header>
              <div>
                <span className="font-label-sm uppercase tracking-wider text-muted">
                  Professional Biography
                </span>
                <p className="text-base text-ink leading-relaxed mt-1">{profile.identity.bio}</p>
              </div>
              <div>
                <span className="font-label-sm uppercase tracking-wider text-muted">
                  Controlled Specialties
                </span>
                <div className="flex flex-wrap gap-2 mt-2" data-testid="profile-review-specialties">
                  {profile.disciplines.specialtyKeys.map((key) => (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-surface-container text-primary text-sm"
                      data-testid={`profile-review-specialty-${key}`}
                    >
                      {specialtyNames.get(key) ?? key}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <span className="font-label-sm uppercase tracking-wider text-muted">
                  Caribbean Connection (self-declared)
                </span>
                <div className="flex flex-wrap gap-2 mt-2" data-testid="profile-review-caribbean">
                  {profile.disciplines.caribbeanAffiliationCodes.map((code) => (
                    <span
                      key={code}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-surface-container text-primary text-sm"
                      data-testid={`profile-review-caribbean-${code}`}
                    >
                      {caribbeanNames.get(code) ?? code}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted mt-2">
                  Caribbean connection is self-declared and is not verified by SoundHub. It is
                  separate from where you currently live and does not represent verified
                  nationality, citizenship, ethnicity, or heritage.
                </p>
              </div>
            </article>

            <Card variant="parchment" data-testid="profile-review-publication-card">
              <Card.Header>
                <Card.Title>Publication Authorization</Card.Title>
              </Card.Header>
              <Card.Content className="space-y-4">
                <label className="flex items-start gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-1 w-5 h-5 min-h-[20px] min-w-[20px]"
                    data-testid="profile-review-confirm"
                  />
                  <span className="text-base text-ink" data-testid="profile-review-confirm-label">
                    I confirm that this professional profile is accurate to my knowledge and that I
                    am authorized to publish it for this Workspace.
                  </span>
                </label>
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t border-surface-variant">
                  <SaveDraftActions
                    state={submitState}
                    errorMessage={submitErrorMessage}
                    onRetry={handleRetry}
                    testIdPrefix="profile-review-publish"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleAbandon}
                      className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-4 text-base font-medium text-ink hover:text-aubergine bg-surface hover:bg-surface-container rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                      data-testid="profile-review-back"
                    >
                      Back to edit
                    </button>
                    <button
                      type="button"
                      onClick={handlePublish}
                      disabled={!confirmed || submitState === "saving"}
                      className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-coral hover:bg-coral-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid="profile-review-publish"
                    >
                      {isUpdate ? "Update profile" : "Publish profile"}
                    </button>
                  </div>
                </div>
              </Card.Content>
            </Card>

            <Link
              href={
                (validatedReturnTo
                  ? (`/seller/profile/edit?return=${encodeURIComponent(validatedReturnTo)}` as Route)
                  : "/seller/profile/edit")
              }
              className="text-aubergine hover:text-aubergine-hover font-medium"
              data-testid="profile-review-back-edit"
            >
              ← Back to edit
            </Link>
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}

function SuccessSurface({
  profile,
  onDismiss,
}: {
  readonly profile: SellerProfileOwnerViewV1;
  readonly onDismiss: () => void;
}) {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="profile-review-success">
        <Alert role="alert" variant="status" title="Professional Profile published">
          <p className="text-base text-ink">
            Your professional identity is now <strong>published</strong>.
          </p>
          <ul className="list-disc list-inside mt-2 space-y-1 text-sm text-ink">
            <li>No ServiceOffering was created.</li>
            <li>No ServiceOffering was activated.</li>
            <li>Your services are not yet available to buyers.</li>
            <li>Your next step is to create and activate your first service.</li>
          </ul>
        </Alert>
        <div className="mt-4 flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
            data-testid="profile-review-success-dismiss"
          >
            Continue
          </button>
          <Link
            href="/dashboard/audio"
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
            data-testid="profile-review-success-create-service"
          >
            Create your first service
          </Link>
        </div>
        <p className="text-xs text-muted mt-6">
          Published at {profile.publishedAt ? new Date(profile.publishedAt).toLocaleString() : "—"}.
        </p>
      </div>
    </div>
  );
}
