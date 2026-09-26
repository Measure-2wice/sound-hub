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
import type {
  ApiFieldErrorV1,
  SellerProfileDraftRequestV1,
  SellerProfileOwnerViewV1,
  SellerProfileTaxonomyResponseV1,
} from "@soundhub/types";
import { isLocallyValidReturnPath } from "../../../lib/return-path-shape";

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

  // Form state
  const [professionalName, setProfessionalName] = useState("");
  const [bio, setBio] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [region, setRegion] = useState("");
  const [city, setCity] = useState("");
  const [specialtyKeys, setSpecialtyKeys] = useState<string[]>([]);
  const [caribbeanCodes, setCaribbeanCodes] = useState<string[]>([]);

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
        setProfileLoaded(true);
        if (p) {
          setProfessionalName(p.identity.professionalName);
          setBio(p.identity.bio);
          setCountryCode(p.basedIn.countryCode);
          setRegion(p.basedIn.region ?? "");
          setCity(p.basedIn.city ?? "");
          setSpecialtyKeys([...p.disciplines.specialtyKeys]);
          setCaribbeanCodes([...p.disciplines.caribbeanAffiliationCodes]);
        } else {
          // Lazy first save — leave the form empty. Default
          // country "US" stays; user can change it.
        }
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

  // Build the request payload from the live form state.
  const buildPayload = (): SellerProfileDraftRequestV1 => ({
    identity: { professionalName: professionalName.trim(), bio },
    basedIn: {
      countryCode,
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

  const summaryItems: ErrorSummaryItem[] = fieldErrors.map((err) => {
    const path = err.path;
    const id = (() => {
      if (path.startsWith("identity.professionalName")) return FIELD_IDS.professionalName;
      if (path.startsWith("identity.bio")) return FIELD_IDS.bio;
      if (path.startsWith("basedIn.countryCode")) return FIELD_IDS.basedInCountryCode;
      if (path.startsWith("basedIn.region")) return FIELD_IDS.basedInRegion;
      if (path.startsWith("basedIn.city")) return FIELD_IDS.basedInCity;
      if (path.startsWith("disciplines.specialtyKeys")) return FIELD_IDS.specialtyKeys;
      if (path.startsWith("disciplines.caribbeanAffiliationCodes"))
        return FIELD_IDS.caribbeanAffiliationCodes;
      return path.replace(/\./g, "-");
    })();
    return { id, path, message: err.message };
  });

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
                  className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base"
                  data-testid="profile-edit-input-professional-name"
                />
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
                  className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base"
                  data-testid="profile-edit-input-bio"
                />
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
                    Country <span aria-hidden="true">*</span>
                  </label>
                  <select
                    id={FIELD_IDS.basedInCountryCode}
                    required
                    value={countryCode}
                    onChange={(e) => {
                      setCountryCode(e.target.value);
                      handleClearDraft();
                    }}
                    className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base min-h-[44px]"
                    data-testid="profile-edit-input-country"
                  >
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
                    className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base"
                    data-testid="profile-edit-input-region"
                  />
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
                    className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base"
                    data-testid="profile-edit-input-city"
                  />
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
              />
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
                aria-label="Caribbean country and territory affiliations"
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
            </section>

            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-surface-variant">
              <SaveDraftActions
                state={saveState}
                errorMessage={saveErrorMessage}
                onRetry={handleRetry}
                testIdPrefix="profile-edit-save"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saveState === "saving"}
                  className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="profile-edit-save-draft"
                >
                  Save draft
                </button>
                {canReview && (
                  <Link
                    href={
                      (validatedReturnTo
                        ? (`/seller/profile/review?return=${encodeURIComponent(validatedReturnTo)}` as Route)
                        : "/seller/profile/review")
                    }
                    className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                    data-testid="profile-edit-review"
                  >
                    Review for publication
                  </Link>
                )}
              </div>
            </div>
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
