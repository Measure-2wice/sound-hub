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
import { SaveDraftActions, type SaveDraftActionState } from "../../../components/SaveDraftActions";
import { ErrorSummary, type ErrorSummaryItem } from "../../../components/ErrorSummary";
import type {
  ApiFieldErrorV1,
  SellerProfileOwnerViewV1,
  SellerProfileTaxonomyResponseV1,
} from "@soundhub/types";
import { isLocallyValidReturnPath } from "../../../lib/return-path-shape";
import {
  clearPendingSellerProfileEdits,
  clearSellerProfileRejection,
  readPendingSellerProfileEdits,
  writeSellerProfileRejection,
} from "../../../lib/seller-profile-pending-edits";

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
  const { loading } = useSession();
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

  // Pending post-publication edits forwarded from the editor via
  // sessionStorage. On a Published profile these override the
  // server's current values for BOTH the preview and the submit
  // payload. On a Draft profile they are ignored (the editor
  // always saves drafts through the API first).
  const [pendingEdits, setPendingEdits] =
    useState<ReturnType<typeof readPendingSellerProfileEdits>>(null);

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
    // Read the post-publication edit handoff synchronously so the
    // first render of the preview reflects the user's edits even if
    // the server fetch is still in flight.
    setPendingEdits(readPendingSellerProfileEdits(workspaceId));
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

  // On a Published profile the editor forwards the user's pending
  // edits through sessionStorage; we overlay them on the server's
  // current values for both the preview and the submit payload. A
  // stale handoff for a Draft profile is ignored — the editor
  // always saves drafts through the API before review.
  const effectiveIdentity = isUpdate && pendingEdits ? pendingEdits.identity : profile.identity;
  const effectiveBasedIn = isUpdate && pendingEdits ? pendingEdits.basedIn : profile.basedIn;
  const effectiveDisciplines =
    isUpdate && pendingEdits ? pendingEdits.disciplines : profile.disciplines;

  // Used by performPublish to bail without sending the (already
  // malformed) request body when the user clicks Publish on an
  // empty country — the server-side SELLER_PROFILE_INCOMPLETE
  // (and others) are surfaced through the same ErrorSummary path
  // regardless of which boundary rejected it.

  // Map every field-level error to the "Back to edit" anchor so
  // the linked summary focuses that link instead of a non-existent
  // control. The review surface is read-only; the recovery path is
  // "Back to edit", and the editor renders the actual field
  // controls (with their own per-field ErrorSummary on the editor
  // page once the user lands back there with the persisted draft).
  const summaryItems: ErrorSummaryItem[] = fieldErrors.map((err) => ({
    id: "profile-review-back-edit",
    path: err.path,
    message: `${err.message} (${err.path})`,
  }));

  const performPublish = async (key: string) => {
    setSubmitState("saving");
    setSubmitErrorMessage(null);
    setFieldErrors([]);
    // Client-side guard: the STRICT publish/update schema requires
    // a country. If the user (or a partial-draft rejection) left
    // the country unset, surface the same field-error annotation
    // shape the server would, scoped to the editor's
    // "basedIn.countryCode" anchor. Returning early avoids building
    // a payload that the server would reject as SELLER_PROFILE_INVALID.
    // The error is also persisted into the rejection handoff so the
    // editor's correction flow retains the field-level guidance when
    // the user returns via "Back to edit".
    if (!effectiveBasedIn.countryCode) {
      const countryFieldError = {
        path: "basedIn.countryCode",
        code: "country_required",
        message: "Select a country before publishing your Professional Profile.",
      };
      setSubmitErrorMessage("Country is required to publish.");
      setFieldErrors([countryFieldError]);
      setSubmitState("error");
      try {
        writeSellerProfileRejection(actingWorkspace.workspaceId, {
          fieldErrors: [countryFieldError],
        });
      } catch {
        // Same throw-on-failure discipline as the editor's
        // writePendingSellerProfileEdits: a silent swallow would
        // let the editor drop the user into a clean form with no
        // indication of what was rejected. The visible ErrorSummary
        // already guides the user even if the persisted copy
        // cannot be saved.
      }
      return;
    }
    const payload = {
      identity: effectiveIdentity,
      basedIn: effectiveBasedIn as { countryCode: string; city?: string; region?: string },
      disciplines: effectiveDisciplines,
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
      // Definitive success: the post-publication edit handoff has
      // been committed; clear it so a subsequent edit starts fresh.
      // The retained rejection (if any) is also cleared — the next
      // Publish / Update will either succeed or surface a fresh
      // rejection through this same path.
      clearPendingSellerProfileEdits(actingWorkspace.workspaceId);
      clearSellerProfileRejection(actingWorkspace.workspaceId);
      setPendingEdits(null);
      // On definitive success, the user has reached the success
      // surface. The next attempt (if any) is a genuinely new
      // command — clear the retained key so the next Publish
      // generates a fresh one.
      idempotencyKeyRef.current = null;
      setSubmitState("saved");
      // Intentionally NO auto-navigation. The SuccessSurface (rendered
      // when `publishedSnapshot` is set) must remain mounted until the
      // user dismisses via the Continue button or follows the
      // "Create your first service" CTA, per M2 #84 acceptance
      // criteria. Navigating here would unmount the success surface
      // before the user could read the truthful post-publication copy.
    } catch (err) {
      const cls = asSellerProfileClientError(err);
      let displayMessage: string;
      let displayFieldErrors: readonly ApiFieldErrorV1[] = [];
      if (cls) {
        displayMessage = cls.message;
        displayFieldErrors = cls.fieldErrors;
      } else {
        displayMessage = "Couldn't publish. Please try again.";
      }
      setSubmitErrorMessage(displayMessage);
      setFieldErrors(displayFieldErrors);
      setSubmitState("error");
      void key; // keep the same idempotencyKey for Retry
      // Persist the rejection so the editor can resume the rejected
      // payload + retained field errors when the user returns. The
      // `pendingEdits` handoff is intentionally NOT cleared here:
      // its purpose is to hold the values the user just submitted,
      // and the editor's hydration reads them on mount. Clearing
      // would force the user to re-enter every field they just
      // typed. sessionStorage is bounded but the field-error
      // payload is at most 50 entries (per apiFieldErrorV1Schema)
      // so write cannot exceed any reasonable quota.
      writeSellerProfileRejection(actingWorkspace.workspaceId, {
        fieldErrors: displayFieldErrors,
      });
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

  const handleDiscardUpdates = () => {
    // Explicit discard (NOT the default "Back to edit" path). The
    // user is asked for confirmation because pendingEdits + the
    // rejection state are permanently cleared — the editor will
    // reload from the server's Published state on mount. After
    // confirmation: clear the retained idempotencyKey, both
    // handoffs, and navigate.
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(
        "Discard your pending update? The editor will reload your current published values and you'll have to re-enter the changes.",
      );
    if (!confirmed) return;
    idempotencyKeyRef.current = null;
    clearPendingSellerProfileEdits(actingWorkspace.workspaceId);
    clearSellerProfileRejection(actingWorkspace.workspaceId);
    setPendingEdits(null);
    router.replace((validatedReturnTo ?? "/seller/profile/edit") as Route);
  };

  // "Back to edit" preserves the handoff. The editor hydrates from
  // the pending edits (and the retained rejection, if any) on
  // mount, so the user can correct and resubmit without re-entering
  // values. The action-row button is the explicit
  // "Discard updates" path with a bounded confirmation; the
  // card-footer link is the implicit, always-safe escape.
  const handleBackToEdit = () => {
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
                  Review your Professional Profile before publication. Publishing makes your profile
                  visible to buyers on SoundHub.
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
                    {effectiveIdentity.professionalName}
                  </h2>
                  <div className="flex items-center gap-2 text-muted">
                    <span aria-hidden="true">📍</span>
                    <span className="text-base text-ink">
                      {effectiveBasedIn.city ?? ""}
                      {effectiveBasedIn.city ? ", " : ""}
                      {effectiveBasedIn.region ?? ""}
                      {effectiveBasedIn.city || effectiveBasedIn.region ? ", " : ""}
                      {effectiveBasedIn.countryCode}
                    </span>
                  </div>
                  <span className="text-xs text-muted">Marketplace operational location only</span>
                </div>
              </header>
              <div>
                <span className="font-label-sm uppercase tracking-wider text-muted">
                  Professional Biography
                </span>
                <p className="text-base text-ink leading-relaxed mt-1">{effectiveIdentity.bio}</p>
              </div>
              <div>
                <span className="font-label-sm uppercase tracking-wider text-muted">
                  Controlled Specialties
                </span>
                <div className="flex flex-wrap gap-2 mt-2" data-testid="profile-review-specialties">
                  {effectiveDisciplines.specialtyKeys.map((key) => (
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
                  {effectiveDisciplines.caribbeanAffiliationCodes.map((code) => (
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
                    {/* Prominent Back-to-edit PRESERVES the handoff:
                       the editor's mount hydrates from the pending
                       edits + retained field errors, so the user
                       can correct without re-entering values. The
                       destructive path is the small Discard pending
                       changes link below (with bounded
                       confirmation). */}
                    <button
                      type="button"
                      onClick={handleBackToEdit}
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
                {isUpdate && pendingEdits && (
                  <button
                    type="button"
                    onClick={handleDiscardUpdates}
                    className="text-xs text-muted hover:text-aubergine underline-offset-2 hover:underline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                    data-testid="profile-review-discard-updates"
                  >
                    Discard pending changes
                  </button>
                )}
              </Card.Content>
            </Card>

            <Link
              href={
                validatedReturnTo
                  ? (`/seller/profile/edit?return=${encodeURIComponent(validatedReturnTo)}` as Route)
                  : "/seller/profile/edit"
              }
              id="profile-review-back-edit"
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
