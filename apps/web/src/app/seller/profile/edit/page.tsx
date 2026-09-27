"use client";

// Professional Profile editor (M2 #84).
//
// Background: the M2 seller-onboarding slice exposes the Professional
// Profile lifecycle for a Seller-capable Personal Workspace. The
// editor is the Private-draft authoring surface: explicit Save
// draft, no autosave, lazy first save (the first successful save
// creates the stable SellerProfile identity), resume on
// refresh/revisit, and validation on blur + a linked/focusable
// error summary on multi-error publication.
//
// Authorization rules:
//   - The page reads `useActingWorkspace()` and ONLY renders for a
//     Seller-capable Personal Workspace. A Seller-capable
//     Organization is rejected at the API; the page renders a
//     switch-back affordance for that case.
//   - Page-level drafts are local `useState`. They are NOT a
//     persistent working draft per the M2 spec story 22 / story
//     33 — the server-side `seller_profiles` row is the durable
//     draft; the page mirrors the most recently fetched row on
//     mount and overlays local edits.
//
// Retry lifecycle (per the user's corrected #84 plan):
//   - The page generates ONE `idempotencyKey` on first save. The
//     same key is reused across any uncertain transport outcome
//     and the explicit "Save draft" retry. The key is cleared only
//     on a definitive successful response or on payload change /
//     abandonment. The SaveDraft retry button MUST call
//     `handleSave` with the SAME key.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { useActingWorkspace, useSession } from "../../../components/SessionProvider";
import { Alert } from "../../../components/ui/Alert";
import { Card } from "../../../components/ui/Card";
import { SpecialtyChips } from "../../../components/SpecialtyChips";
import { SaveDraftActions, type SaveDraftActionState } from "../../../components/SaveDraftActions";
import { ErrorSummary, type ErrorSummaryItem } from "../../../components/ErrorSummary";
import {
  fetchSellerProfile,
  fetchSellerProfileTaxonomy,
  generateSellerProfileIdempotencyKey,
  saveSellerProfileDraft,
  asSellerProfileClientError,
} from "../../../lib/seller-profile-client";
import {
  type ApiFieldErrorV1,
  type SellerProfileDraftRequestV1,
  type SellerProfileOwnerViewV1,
  type SellerProfileTaxonomyResponseV1,
} from "@soundhub/types";
import { isLocallyValidReturnPath } from "../../../lib/return-path-shape";
import {
  readPendingSellerProfileEdits,
  readSellerProfileRejection,
  clearPendingSellerProfileEdits,
  clearSellerProfileRejection,
  writePendingSellerProfileEdits,
} from "../../../lib/seller-profile-pending-edits";

// Stable input ids — referenced by the ErrorSummary anchor
// links and the field-level `htmlFor` associations.
const FIELD_IDS = {
  professionalName: "seller-profile-professional-name",
  bio: "seller-profile-bio",
  basedInCountryCode: "seller-profile-country",
  basedInRegion: "seller-profile-region",
  basedInCity: "seller-profile-city",
  specialtyKeys: "seller-profile-specialties",
  caribbeanAffiliationCodes: "seller-profile-caribbean",
} as const;

// Per-field error element IDs. Stable across renders so the
// `aria-describedby` pointer on each input is reliable: any
// assistive technology that follows the pointer resolves to
// exactly the element that holds the per-field message.
function fieldErrorId(fieldId: string): string {
  return `${fieldId}-error`;
}

export default function ProfileEditPage() {
  return (
    <Suspense fallback={<EditLoading />}>
      <ProfileEditInner />
    </Suspense>
  );
}

function EditLoading() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
        <div className="max-w-3xl mx-auto" data-testid="profile-edit-loading">
          <Alert role="status" variant="status" title="Loading your draft…">
            Just a moment.
          </Alert>
        </div>
      </div>
    </div>
  );
}

function ProfileEditInner() {
  const { user, loading } = useSession();
  const { actingWorkspace } = useActingWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const validatedReturnTo = useMemo(() => {
    const raw = searchParams.get("return");
    if (!raw) return null;
    return isLocallyValidReturnPath(raw) ? raw : null;
  }, [searchParams]);

  // Acting-Workspace gate. The editor is Personal-Workspace-only.
  useEffect(() => {
    if (loading) return;
    if (!user) {
      void router.replace(`/login?return=${encodeURIComponent("/seller/profile/edit")}`);
      return;
    }
    if (!actingWorkspace) return;
    if (actingWorkspace.workspaceType !== "Personal") {
      // Redirect the Organization actor back to the dashboard; the
      // API will also reject the request, so this is presentation.
      void router.replace("/dashboard");
    }
  }, [loading, user, actingWorkspace, router]);

  // Bootstrap state
  const [taxonomy, setTaxonomy] = useState<SellerProfileTaxonomyResponseV1 | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [profile, setProfile] = useState<SellerProfileOwnerViewV1 | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  // Form state. `countryCode` defaults to "" — a partial Draft
  // must not silently persist a fabricated country the seller
  // never selected. Save draft carries the empty string as an
  // omission; the country `<select>` always renders an explicit
  // "Select a country" placeholder so the seller knows nothing
  // has been chosen. Publish / update completeness enforces the
  // country at the trusted boundary.
  const [professionalName, setProfessionalName] = useState("");
  const [bio, setBio] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [region, setRegion] = useState("");
  const [city, setCity] = useState("");
  const [specialtyKeys, setSpecialtyKeys] = useState<string[]>([]);
  const [caribbeanCodes, setCaribbeanCodes] = useState<string[]>([]);

  // Inline error from the post-publication edit handoff. The
  // editor shows a recoverable error and does NOT navigate when
  // sessionStorage refuses the write (private mode, quota) — a
  // silent swallow would let the review page fall back to the
  // server's stale Published state and submit a no-op.
  const [reviewUpdateHandoffError, setReviewUpdateHandoffError] = useState<string | null>(null);

  // Save state machine
  const [saveState, setSaveState] = useState<SaveDraftActionState>("idle");
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<readonly ApiFieldErrorV1[]>([]);

  // Single retained idempotencyKey per draft session. Per the
  // user's corrected retry lifecycle: only the FIRST save
  // click (or a payload change / abandonment) generates a
  // new key. Subsequent Retry clicks reuse the same key.
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    // The acting workspace is the source of authority for both the
    // profile read and the workspace-scoped drafts. Guarding here
    // prevents the StrictMode-double-mount + first-render effect
    // from firing with a null `actingWorkspace` (which would throw
    // inside the non-null assertion and leave the bootstrap error
    // state stuck on even after the workspace resolves).
    if (!actingWorkspace) return;
    const workspaceId = actingWorkspace.workspaceId;
    let cancelled = false;
    // Read the post-publication edit handoff + retained rejection
    // SYNCHRONOUSLY before the async fetch so a Published profile
    // returning from a rejected review hydrates from the rejected
    // payload (and its field errors) on the first render. Clearing
    // the entries here means the user can edit freely without the
    // editor snapping back to the rejected values on every mount.
    const pendingEdits = readPendingSellerProfileEdits(workspaceId);
    const rejection = readSellerProfileRejection(workspaceId);
    void (async () => {
      try {
        const [taxonomyResult, profileResult] = await Promise.all([
          fetchSellerProfileTaxonomy(),
          fetchSellerProfile({ workspaceId }),
        ]);
        if (cancelled) return;
        setTaxonomy(taxonomyResult);
        const p = profileResult.profile;
        setProfile(p);
        // Hydrate the form state. On a Published profile the
        // `pendingEdits` (rejected payload from the review surface)
        // takes precedence over the server's current Published
        // values; that is the entire point of the recovery flow —
        // the user can correct and re-submit without re-entering.
        // On a Draft profile, the editor always saves through the
        // API first so a pending edit entry from the Published flow
        // does not apply here.
        const useEdits = p !== null && p.status === "Published" && pendingEdits !== null;
        const identity = useEdits ? pendingEdits.identity : p?.identity;
        const basedIn = useEdits ? pendingEdits.basedIn : p?.basedIn;
        const disciplines = useEdits ? pendingEdits.disciplines : p?.disciplines;
        if (identity) {
          setProfessionalName(identity.professionalName);
          setBio(identity.bio);
        }
        if (basedIn) {
          setCountryCode(basedIn.countryCode ?? "");
          setRegion(basedIn.region ?? "");
          setCity(basedIn.city ?? "");
        }
        if (disciplines) {
          setSpecialtyKeys([...disciplines.specialtyKeys]);
          setCaribbeanCodes([...disciplines.caribbeanAffiliationCodes]);
        }
        if (rejection !== null) {
          setFieldErrors(rejection.fieldErrors);
        }
        // The user's working session in the editor now supersedes
        // both handoffs — clear them so a refresh / remount does not
        // re-apply the rejected values.
        if (pendingEdits !== null) {
          clearPendingSellerProfileEdits(workspaceId);
        }
        if (rejection !== null) {
          clearSellerProfileRejection(workspaceId);
        }
        setProfileLoaded(true);
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
    return <EditLoading />;
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
  if (!profileLoaded || !taxonomy) {
    return <EditLoading />;
  }

  // Build the request payload from the live form state. An empty
  // country is OMITTED (not sent as "" so the relaxed draft schema
  // does not reject it on the pattern regex). Publish / update
  // completeness will require a non-empty country via the STRICT
  // sub-schema.
  const buildPayload = (): SellerProfileDraftRequestV1 => ({
    identity: { professionalName: professionalName.trim(), bio },
    basedIn: {
      ...(countryCode ? { countryCode } : {}),
      ...(region.trim() ? { region: region.trim() } : {}),
      ...(city.trim() ? { city: city.trim() } : {}),
    },
    disciplines: {
      specialtyKeys,
      caribbeanAffiliationCodes: caribbeanCodes,
    },
  });

  const toggleSpecialty = (key: string) => {
    setSpecialtyKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };
  const toggleCaribbean = (code: string) => {
    setCaribbeanCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const performSave = async (key: string) => {
    setSaveState("saving");
    setSaveErrorMessage(null);
    setFieldErrors([]);
    try {
      const response = await saveSellerProfileDraft({
        workspaceId: actingWorkspace.workspaceId,
        draft: buildPayload(),
      });
      setProfile(response.profile);
      // After a successful save, the SAME idempotencyKey stays in
      // the ref (it represents the "current draft session"). The
      // NEXT save (a true new attempt) generates a fresh key.
      setSaveState("saved");
    } catch (err) {
      const cls = asSellerProfileClientError(err);
      if (cls) {
        setSaveErrorMessage(cls.message);
        setFieldErrors(cls.fieldErrors);
        // On 409 NOT_DRAFT (Published) we should disable Save.
        if (cls.code === "SELLER_PROFILE_NOT_DRAFT") {
          setSaveState("idle");
          return;
        }
      } else {
        setSaveErrorMessage("Couldn't save. Please try again.");
      }
      setSaveState("error");
      // Keep the same key so the Retry button reuses it.
      void key;
    }
  };

  const handleSave = () => {
    // Generate the idempotencyKey on the FIRST save of a fresh
    // session. Per the user's retry-lifecycle correction: the
    // same key is reused across retries; only a definitive success
    // OR a payload change clears it.
    if (idempotencyKeyRef.current === null) {
      idempotencyKeyRef.current = generateSellerProfileIdempotencyKey();
    }
    void performSave(idempotencyKeyRef.current);
  };

  // Post-publication review handoff. Save draft is not a valid
  // command on a Published profile (the API rejects with
  // SELLER_PROFILE_NOT_DRAFT), so we forward the edited field set
  // to the review surface through sessionStorage instead. The
  // review page reads the handoff, overlays it on the published
  // owner view, and submits via `updatePublishedSellerProfile`.
  // No persistent post-publication draft is created per ticket #84.
  //
  // Storage failures throw — a silent swallow would let the
  // review page fall back to the server's stale Published state
  // and submit a no-op confirmation. On failure, remain in the
  // editor with form state intact and surface a recoverable error.
  const handleReviewUpdate = () => {
    setReviewUpdateHandoffError(null);
    try {
      writePendingSellerProfileEdits(actingWorkspace.workspaceId, buildPayload());
    } catch (err) {
      setReviewUpdateHandoffError(
        err instanceof Error
          ? err.message
          : "Couldn't forward your edits to the review. Please try again.",
      );
      return;
    }
    const reviewTarget: Route = validatedReturnTo
      ? (`/seller/profile/review?return=${encodeURIComponent(validatedReturnTo)}` as Route)
      : "/seller/profile/review";
    void router.push(reviewTarget);
  };

  const handleRetry = () => {
    if (idempotencyKeyRef.current === null) {
      // First attempt never happened; this is the same as Save.
      idempotencyKeyRef.current = generateSellerProfileIdempotencyKey();
    }
    void performSave(idempotencyKeyRef.current);
  };

  const handleClearDraft = () => {
    // User-initiated abandonment. Clear the retained key so the
    // next Save starts a new session.
    idempotencyKeyRef.current = null;
  };

  const canReview = profile !== null && profile.status !== "Suspended";

  // Resolve the input anchor for a `path` like
  // `identity.professionalName`. Mirrors the ErrorSummary
  // mapping below so the linked summary, the per-field error
  // element, and the input's `aria-describedby` all resolve to
  // the same DOM id.
  const anchorForPath = (path: string): string => {
    if (path.startsWith("identity.professionalName")) return FIELD_IDS.professionalName;
    if (path.startsWith("identity.bio")) return FIELD_IDS.bio;
    if (path.startsWith("basedIn.countryCode")) return FIELD_IDS.basedInCountryCode;
    if (path.startsWith("basedIn.region")) return FIELD_IDS.basedInRegion;
    if (path.startsWith("basedIn.city")) return FIELD_IDS.basedInCity;
    if (path.startsWith("disciplines.specialtyKeys")) return FIELD_IDS.specialtyKeys;
    if (path.startsWith("disciplines.caribbeanAffiliationCodes"))
      return FIELD_IDS.caribbeanAffiliationCodes;
    return path.replace(/\./g, "-");
  };

  const summaryItems: ErrorSummaryItem[] = fieldErrors.map((err) => ({
    id: anchorForPath(err.path),
    path: err.path,
    message: err.message,
  }));

  // Per-field error map: at most one retained error per input
  // anchor. The first matching error wins so a downstream
  // duplicate path (e.g. both `disciplines.specialtyKeys` and
  // `disciplines.specialtyKeys.0`) collapses to a single
  // per-control message — assistive tech announces the head of
  // the group, not every offending element. Used to attach
  // `aria-invalid` + `aria-describedby` to the input + render
  // an adjacent error element.
  const fieldErrorById = new Map<string, ApiFieldErrorV1>();
  for (const err of fieldErrors) {
    const id = anchorForPath(err.path);
    if (!fieldErrorById.has(id)) {
      fieldErrorById.set(id, err);
    }
  }

  // Compute the props every per-field input/control applies so
  // the `aria-invalid` + `aria-describedby` pair is always
  // emitted together. Returns `undefined` for fields with no
  // retained error so the JSX stays clean and Playwright can
  // use `toBeUndefined()` (rather than `null`).
  const invalidPropsFor = (
    fieldId: string,
  ): { ariaInvalid: "true"; ariaDescribedBy: string } | undefined => {
    const err = fieldErrorById.get(fieldId);
    if (!err) return undefined;
    return { ariaInvalid: "true", ariaDescribedBy: fieldErrorId(fieldId) };
  };

  const nameInvalid = invalidPropsFor(FIELD_IDS.professionalName);
  const bioInvalid = invalidPropsFor(FIELD_IDS.bio);
  const countryInvalid = invalidPropsFor(FIELD_IDS.basedInCountryCode);
  const regionInvalid = invalidPropsFor(FIELD_IDS.basedInRegion);
  const cityInvalid = invalidPropsFor(FIELD_IDS.basedInCity);
  const specialtyInvalid = invalidPropsFor(FIELD_IDS.specialtyKeys);
  const caribbeanInvalid = invalidPropsFor(FIELD_IDS.caribbeanAffiliationCodes);
  const nameError = fieldErrorById.get(FIELD_IDS.professionalName);
  const bioError = fieldErrorById.get(FIELD_IDS.bio);
  const countryError = fieldErrorById.get(FIELD_IDS.basedInCountryCode);
  const regionError = fieldErrorById.get(FIELD_IDS.basedInRegion);
  const cityError = fieldErrorById.get(FIELD_IDS.basedInCity);
  const specialtyError = fieldErrorById.get(FIELD_IDS.specialtyKeys);
  const caribbeanError = fieldErrorById.get(FIELD_IDS.caribbeanAffiliationCodes);

  const statusBadge = profile
    ? profile.status === "Published"
      ? { label: "Published", color: "text-seaGlass" }
      : { label: "Private draft", color: "text-muted" }
    : { label: "No draft yet", color: "text-muted" };

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-8 space-y-6">
        <Card variant="parchment" data-testid="profile-edit">
          <Card.Header>
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="font-label-sm uppercase tracking-widest text-muted">
                  Professional Profile
                </span>
                <h1 className="text-3xl font-serif text-ink mt-1">Edit Professional Profile</h1>
                <p className="text-base text-muted mt-1">
                  Your private draft. Saving preserves this revision — publication is a separate
                  explicit step.
                </p>
              </div>
              <span
                aria-live="polite"
                className={`font-label-md uppercase tracking-wider ${statusBadge.color}`}
                data-testid="profile-edit-status"
              >
                {statusBadge.label}
              </span>
            </div>
          </Card.Header>
          <Card.Content className="space-y-6">
            {summaryItems.length > 0 && (
              <ErrorSummary
                title="Please fix the following before saving:"
                errors={summaryItems}
                testId="profile-edit-error-summary"
              />
            )}

            <section className="space-y-4" aria-labelledby="professional-identity-heading">
              <h2
                id="professional-identity-heading"
                className="text-xl font-serif text-ink"
                data-testid="profile-edit-section-identity"
              >
                Professional identity
              </h2>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={FIELD_IDS.professionalName}
                  className="text-sm font-medium text-ink"
                >
                  Professional Name <span aria-hidden="true">*</span>
                </label>
                <input
                  id={FIELD_IDS.professionalName}
                  type="text"
                  required
                  maxLength={200}
                  value={professionalName}
                  onChange={(e) => {
                    setProfessionalName(e.target.value);
                    handleClearDraft();
                  }}
                  aria-invalid={nameInvalid?.ariaInvalid}
                  aria-describedby={nameInvalid?.ariaDescribedBy}
                  className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base aria-[invalid=true]:border-coral"
                  data-testid="profile-edit-input-professional-name"
                />
                {nameError && (
                  <p
                    id={fieldErrorId(FIELD_IDS.professionalName)}
                    role="alert"
                    data-testid="profile-edit-input-professional-name-error"
                    className="text-xs text-coral mt-1"
                  >
                    {nameError.message}
                  </p>
                )}
                <p className="text-xs text-muted">Public display name visible to buyers.</p>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={FIELD_IDS.bio} className="text-sm font-medium text-ink">
                  Biography <span aria-hidden="true">*</span>
                </label>
                <textarea
                  id={FIELD_IDS.bio}
                  rows={5}
                  maxLength={2000}
                  value={bio}
                  onChange={(e) => {
                    setBio(e.target.value);
                    handleClearDraft();
                  }}
                  aria-invalid={bioInvalid?.ariaInvalid}
                  aria-describedby={bioInvalid?.ariaDescribedBy}
                  className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base aria-[invalid=true]:border-coral"
                  data-testid="profile-edit-input-bio"
                />
                {bioError && (
                  <p
                    id={fieldErrorId(FIELD_IDS.bio)}
                    role="alert"
                    data-testid="profile-edit-input-bio-error"
                    className="text-xs text-coral mt-1"
                  >
                    {bioError.message}
                  </p>
                )}
                <p className="text-xs text-muted">{bio.length} / 2000</p>
              </div>
            </section>

            <section className="space-y-4" aria-labelledby="location-heading">
              <h2 id="location-heading" className="text-xl font-serif text-ink">
                Where are you currently based?
              </h2>
              <p className="text-sm text-muted">
                Your current marketplace location only. It does not define your nationality or
                Caribbean identity.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={FIELD_IDS.basedInCountryCode}
                    className="text-sm font-medium text-ink"
                  >
                    Country
                  </label>
                  <select
                    id={FIELD_IDS.basedInCountryCode}
                    value={countryCode}
                    onChange={(e) => {
                      setCountryCode(e.target.value);
                      handleClearDraft();
                    }}
                    aria-invalid={countryInvalid?.ariaInvalid}
                    aria-describedby={countryInvalid?.ariaDescribedBy}
                    className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base min-h-[44px] aria-[invalid=true]:border-coral"
                    data-testid="profile-edit-input-country"
                  >
                    <option value="" data-testid="profile-edit-input-country-empty">
                      Select a country
                    </option>
                    {[
                      "US",
                      "JM",
                      "TT",
                      "HT",
                      "BB",
                      "BS",
                      "BZ",
                      "DM",
                      "DO",
                      "GD",
                      "GY",
                      "KN",
                      "LC",
                      "SR",
                      "VC",
                      "UK",
                      "CA",
                      "FR",
                    ].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {countryError && (
                    <p
                      id={fieldErrorId(FIELD_IDS.basedInCountryCode)}
                      role="alert"
                      data-testid="profile-edit-input-country-error"
                      className="text-xs text-coral mt-1"
                    >
                      {countryError.message}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={FIELD_IDS.basedInRegion} className="text-sm font-medium text-ink">
                    Region / State / Parish
                  </label>
                  <input
                    id={FIELD_IDS.basedInRegion}
                    type="text"
                    maxLength={120}
                    value={region}
                    onChange={(e) => {
                      setRegion(e.target.value);
                      handleClearDraft();
                    }}
                    aria-invalid={regionInvalid?.ariaInvalid}
                    aria-describedby={regionInvalid?.ariaDescribedBy}
                    className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base aria-[invalid=true]:border-coral"
                    data-testid="profile-edit-input-region"
                  />
                  {regionError && (
                    <p
                      id={fieldErrorId(FIELD_IDS.basedInRegion)}
                      role="alert"
                      data-testid="profile-edit-input-region-error"
                      className="text-xs text-coral mt-1"
                    >
                      {regionError.message}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={FIELD_IDS.basedInCity} className="text-sm font-medium text-ink">
                    City / Town
                  </label>
                  <input
                    id={FIELD_IDS.basedInCity}
                    type="text"
                    maxLength={120}
                    value={city}
                    onChange={(e) => {
                      setCity(e.target.value);
                      handleClearDraft();
                    }}
                    aria-invalid={cityInvalid?.ariaInvalid}
                    aria-describedby={cityInvalid?.ariaDescribedBy}
                    className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base aria-[invalid=true]:border-coral"
                    data-testid="profile-edit-input-city"
                  />
                  {cityError && (
                    <p
                      id={fieldErrorId(FIELD_IDS.basedInCity)}
                      role="alert"
                      data-testid="profile-edit-input-city-error"
                      className="text-xs text-coral mt-1"
                    >
                      {cityError.message}
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="space-y-4" aria-labelledby="specialties-heading">
              <h2 id="specialties-heading" className="text-xl font-serif text-ink">
                Controlled Specialties
              </h2>
              <p className="text-sm text-muted">Pick from SoundHub's controlled disciplines.</p>
              <SpecialtyChips
                specialties={taxonomy.specialties}
                selectedKeys={specialtyKeys}
                onToggle={(key) => {
                  toggleSpecialty(key);
                  handleClearDraft();
                }}
                id={FIELD_IDS.specialtyKeys}
                ariaLabel="Controlled Specialties"
                ariaInvalid={specialtyInvalid?.ariaInvalid}
                ariaDescribedBy={specialtyInvalid?.ariaDescribedBy}
              />
              {specialtyError && (
                <p
                  id={fieldErrorId(FIELD_IDS.specialtyKeys)}
                  role="alert"
                  data-testid="profile-edit-specialties-error"
                  className="text-xs text-coral mt-1"
                >
                  {specialtyError.message}
                </p>
              )}
            </section>

            <section className="space-y-4" aria-labelledby="caribbean-heading">
              <div className="flex items-center justify-between gap-3">
                <h2 id="caribbean-heading" className="text-xl font-serif text-ink">
                  Caribbean connection
                </h2>
                <span
                  className="font-label-md uppercase tracking-wider text-seaGlass"
                  data-testid="profile-edit-caribbean-tag"
                >
                  Self-declared
                </span>
              </div>
              <div className="bg-surface-container p-4 rounded-md">
                <p className="text-sm text-muted">
                  Caribbean connection is self-declared and is not verified by SoundHub. It is
                  separate from where you currently live and does not represent verified
                  nationality, citizenship, ethnicity, or heritage.
                </p>
              </div>
              <div
                role="group"
                id={FIELD_IDS.caribbeanAffiliationCodes}
                tabIndex={-1}
                aria-label="Caribbean country and territory affiliations"
                aria-invalid={caribbeanInvalid?.ariaInvalid}
                aria-describedby={caribbeanInvalid?.ariaDescribedBy}
                className="flex flex-wrap gap-2"
                data-testid="profile-edit-caribbean-chips"
              >
                {taxonomy.caribbeanAffiliationCodes.map((c) => {
                  const selected = caribbeanCodes.includes(c.code);
                  return (
                    <button
                      key={c.code}
                      type="button"
                      onClick={() => {
                        toggleCaribbean(c.code);
                        handleClearDraft();
                      }}
                      aria-pressed={selected}
                      className={`shrink-0 inline-flex items-center gap-2 min-h-[44px] min-w-[44px] px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine ${
                        selected
                          ? "bg-aubergine text-canvas"
                          : "bg-canvas border border-borderWarm text-ink hover:bg-surface"
                      }`}
                      data-testid={`profile-edit-caribbean-chip-${c.code}`}
                      data-selected={selected ? "true" : "false"}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
              {caribbeanError && (
                <p
                  id={fieldErrorId(FIELD_IDS.caribbeanAffiliationCodes)}
                  role="alert"
                  data-testid="profile-edit-caribbean-error"
                  className="text-xs text-coral mt-1"
                >
                  {caribbeanError.message}
                </p>
              )}
            </section>

            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-surface-variant">
              <SaveDraftActions
                state={saveState}
                errorMessage={saveErrorMessage}
                onRetry={handleRetry}
                testIdPrefix="profile-edit-save"
              />
              <div className="flex flex-col items-end gap-2">
                {reviewUpdateHandoffError && (
                  <Alert
                    role="alert"
                    variant="failure"
                    title="Couldn't forward your edits"
                    data-testid="profile-edit-review-update-error"
                  >
                    {reviewUpdateHandoffError}
                  </Alert>
                )}
                <div className="flex items-center gap-2">
                  {profile?.status !== "Published" && (
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saveState === "saving"}
                      className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine disabled:opacity-50 disabled:cursor-not-allowed"
                      data-testid="profile-edit-save-draft"
                    >
                      Save draft
                    </button>
                  )}
                  {profile?.status === "Published" && (
                    <button
                      type="button"
                      onClick={handleReviewUpdate}
                      data-testid="profile-edit-review-update"
                      className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                    >
                      Review update
                    </button>
                  )}
                  {canReview && profile?.status !== "Published" && (
                    <Link
                      href={
                        validatedReturnTo
                          ? (`/seller/profile/review?return=${encodeURIComponent(validatedReturnTo)}` as Route)
                          : "/seller/profile/review"
                      }
                      className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                      data-testid="profile-edit-review"
                    >
                      Review for publication
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
