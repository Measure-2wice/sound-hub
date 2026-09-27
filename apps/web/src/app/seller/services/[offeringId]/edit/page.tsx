"use client";

// ServiceOffering editor (M2 #85).
//
// Background: the M2 seller-onboarding slice exposes the
// ServiceOffering lifecycle for a Seller-capable Personal Workspace.
// This editor is the Private-draft authoring surface: explicit Save
// draft, no autosave, lazy first-save IS in M2 scope (the "new"
// path with `offeringId === "new"` mounts an empty editor and the
// first Save creates the offering atomically with the submitted
// fields — no orphan empty row is ever persisted on navigation
// alone), and validation on blur + a linked/focusable error summary
// on multi-error publication / activation.
//
// Authorization rules:
//   - The page reads `useActingWorkspace()` and ONLY renders for a
//     Seller-capable Personal Workspace. A Seller-capable
//     Organization is rejected at the API; the page renders a
//     switch-back affordance for that case.
//   - Page-level drafts are local `useState`. They are NOT a
//     persistent working draft per the M2 spec; the server-side
//     `service_offerings` row is the durable draft; the page mirrors
//     the most recently fetched row on mount and overlays local
//     edits.
//
// Retry lifecycle:
//   - The page generates ONE `idempotencyKey` on first save. The same
//     key is reused across any uncertain transport outcome and the
//     explicit "Save draft" retry. The key is cleared only on a
//     definitive successful response or on payload change /
//     abandonment. On the "new" path the first Save CREATES the
//     offering + persisted fields atomically; on subsequent saves
//     (after the editor's URL is replaced with the returned
//     offeringId) the path uses PUT and updates the existing row.
//   - Activation has its OWN `idempotencyKey` (one per activation
//     attempt). Same retry-identity rules apply.

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useActingWorkspace, useSession } from "../../../../components/SessionProvider";
import { Alert } from "../../../../components/ui/Alert";
import { Card } from "../../../../components/ui/Card";
import {
  SaveDraftActions,
  type SaveDraftActionState,
} from "../../../../components/SaveDraftActions";
import { ErrorSummary, type ErrorSummaryItem } from "../../../../components/ErrorSummary";
import {
  activateServiceOffering,
  asServiceOfferingClientError,
  createServiceOfferingDraft,
  fetchServiceOffering,
  fetchServiceOfferingTaxonomy,
  generateServiceOfferingIdempotencyKey,
  saveServiceOfferingDraft,
} from "../../../../lib/service-offering-client";
import {
  listOfferingSamples,
  removeOfferingSample,
  uploadOfferingSample,
} from "../../../../lib/audio-samples-client";
import type {
  ApiFieldErrorV1,
  ServiceOfferingActivateRequestV1,
  ServiceOfferingDraftRequestV1,
  ServiceOfferingOwnerViewV1,
  ServiceOfferingTaxonomyResponseV1,
  Bg2AudioSamplePublicV1,
} from "@soundhub/types";

const FIELD_IDS = {
  title: "service-offering-title",
  description: "service-offering-description",
  primaryCategoryKey: "service-offering-category",
  serviceMode: "service-offering-service-mode",
  serviceAreaCountry: "service-offering-service-area-country",
  pricingKind: "service-offering-pricing-kind",
  pricingAmount: "service-offering-pricing-amount",
  pricingUnit: "service-offering-pricing-unit",
  samples: "service-offering-samples",
} as const;

// Mirrors the canonical taxonomy closed list. The browser never
// reads these consts directly; the metadata seam is the canonical
// source (see /api/metadata/seller-profile-taxonomy). We only
// hardcode the three most common service-area country codes here
// because the editor's coarse service-area picker is one
// (required) field per InPerson/Hybrid activation; a future
// migration can move this to a dedicated taxonomy endpoint if the
// surface grows.
const COMMON_SERVICE_AREA_COUNTRY_CODES = [
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
  "CA",
  "GB",
];

function fieldErrorId(fieldId: string): string {
  return `${fieldId}-error`;
}

export default function ServiceOfferingEditPage() {
  return (
    <Suspense fallback={<EditLoading />}>
      <ServiceOfferingEditInner />
    </Suspense>
  );
}

function EditLoading() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
        <div className="max-w-3xl mx-auto" data-testid="service-offering-edit-loading">
          <Alert role="status" variant="status" title="Loading your draft…">
            Just a moment.
          </Alert>
        </div>
      </div>
    </div>
  );
}

function ServiceOfferingEditInner() {
  const { user, loading } = useSession();
  const { actingWorkspace } = useActingWorkspace();
  const router = useRouter();

  const [taxonomy, setTaxonomy] = useState<ServiceOfferingTaxonomyResponseV1 | null>(null);
  const [offering, setOffering] = useState<ServiceOfferingOwnerViewV1 | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [primaryCategoryKey, setPrimaryCategoryKey] = useState("");
  const [serviceMode, setServiceMode] = useState<"Remote" | "InPerson" | "Hybrid">("Remote");
  const [pricingKind, setPricingKind] = useState<"Fixed" | "StartingAt" | "ContactForQuote">(
    "StartingAt",
  );
  const [pricingAmount, setPricingAmount] = useState("600");
  const [pricingUnit, setPricingUnit] = useState("");
  // Coarse service area: one country code, required when the
  // service mode is InPerson or Hybrid. The activation
  // completeness check at /api/services/:id/activate returns
  // SERVICE_OFFERING_INCOMPLETE if the area is missing for those
  // modes; the editor surfaces the picker only when the radio
  // changes.
  const [serviceAreaCountry, setServiceAreaCountry] = useState("");
  const [genreTags, setGenreTags] = useState<string[]>([]);
  const [samples, setSamples] = useState<readonly Bg2AudioSamplePublicV1[]>([]);
  const [samplesError, setSamplesError] = useState<string | null>(null);
  const [sampleLabel, setSampleLabel] = useState("");
  // M2 (#85) PR-review feedback: the seller must explicitly tick
  // the current-version media-use acknowledgement before each
  // upload. The previous editor rendered a pre-checked checkbox
  // that submitted nothing — a confirmation that was neither
  // transmitted nor persisted. The checkbox is now unchecked by
  // default; the upload handler refuses to submit without a fresh
  // tick on every upload.
  const [sampleConfirmed, setSampleConfirmed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);

  const [saveState, setSaveState] = useState<SaveDraftActionState>("idle");
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<readonly ApiFieldErrorV1[]>([]);

  const [activateState, setActivateState] = useState<SaveDraftActionState>("idle");
  const [activateErrorMessage, setActivateErrorMessage] = useState<string | null>(null);
  const [activateFieldErrors, setActivateFieldErrors] = useState<readonly ApiFieldErrorV1[]>([]);
  const [activateConfirmOpen, setActivateConfirmOpen] = useState(false);
  const [activationEvidence, setActivationEvidence] = useState<{
    activatedAt: string;
    confirmationVersion: string;
    idempotencyKey: string;
  } | null>(null);

  const draftIdempotencyKeyRef = useRef<string | null>(null);
  const activateIdempotencyKeyRef = useRef<string | null>(null);

  const params = useParams<{ offeringId: string }>();
  const offeringId = params?.offeringId ?? null;

  useEffect(() => {
    if (loading) return;
    if (!user) {
      void router.replace(`/login?return=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    if (!actingWorkspace) return;
    if (actingWorkspace.workspaceType !== "Personal") {
      void router.replace("/dashboard");
    }
  }, [loading, user, actingWorkspace, router]);

  useEffect(() => {
    if (!actingWorkspace) return;
    // M2 (#85) PR-review feedback (round 3): the "new" path
    // (no offeringId yet) skips the bootstrap fetch — the
    // editor renders an empty form, and the first Save creates
    // the offering atomically with the submitted fields.
    //
    // PR-review feedback (round 4): a rejected taxonomy
    // request must surface as a bootstrap error, not silently
    // flip `profileLoaded` and leave the render guard stuck
    // on the loading state forever.
    if (!offeringId || offeringId === "new") {
      const cancelled = { current: false };
      void (async () => {
        try {
          const taxonomyResult = await fetchServiceOfferingTaxonomy();
          if (cancelled.current) return;
          setTaxonomy(taxonomyResult);
          setProfileLoaded(true);
        } catch (err) {
          if (cancelled.current) return;
          const cls = err as { message?: unknown } | null;
          setBootstrapError(
            typeof cls?.message === "string" ? cls.message : "Could not load the service taxonomy.",
          );
          setProfileLoaded(true);
        }
      })();
      return () => {
        cancelled.current = true;
      };
    }
    let cancelled = false;
    void (async () => {
      try {
        const [taxonomyResult, offeringResult, samplesResult] = await Promise.all([
          fetchServiceOfferingTaxonomy(),
          fetchServiceOffering({
            workspaceId: actingWorkspace.workspaceId,
            offeringId,
          }),
          // M2 (#85) PR-review feedback: owner-side authenticated
          // sample list. The previous public buyer list rejected
          // Draft offerings, so a Draft upload would persist but
          // disappear from the editor after refresh.
          listOfferingSamples({
            workspaceId: actingWorkspace.workspaceId,
            offeringId,
          }).catch(() => ({ offeringId, samples: [] })),
        ]);
        if (cancelled) return;
        setTaxonomy(taxonomyResult);
        const o = offeringResult.offering;
        if (o) {
          setOffering(o);
          setTitle(o.title);
          setDescription(o.description);
          if (o.primaryCategoryKey) setPrimaryCategoryKey(o.primaryCategoryKey);
          if (o.serviceMode) setServiceMode(o.serviceMode);
          // Hydrate the coarse service area from the first persisted
          // row so resume / refresh surfaces the persisted value.
          if (o.serviceAreas.length > 0 && o.serviceAreas[0]) {
            setServiceAreaCountry(o.serviceAreas[0].countryCode);
          }
          if (o.pricing?.kind) setPricingKind(o.pricing.kind);
          if (o.pricing?.amountMinor !== undefined) {
            setPricingAmount(String(o.pricing.amountMinor / 100));
          }
          if (o.pricing?.unitId) setPricingUnit(o.pricing.unitId);
          if (o.genreTags.length > 0) setGenreTags([...o.genreTags]);
        }
        setSamples(samplesResult.samples);
        setProfileLoaded(true);
      } catch (err) {
        if (cancelled) return;
        const cls = asServiceOfferingClientError(err);
        setBootstrapError(cls?.message ?? "Could not load your service.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actingWorkspace, offeringId]);

  if (loading || !actingWorkspace) {
    return <EditLoading />;
  }
  if (actingWorkspace.workspaceType !== "Personal") {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <Alert role="alert" variant="failure" title="Personal Workspace required">
            Service offering administration is available on a Personal Workspace only.
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

  const buildDraftPayload = (): ServiceOfferingDraftRequestV1 => ({
    title,
    description,
    primaryCategoryKey: primaryCategoryKey || undefined,
    serviceMode,
    // Coarse service area is required when serviceMode is
    // InPerson or Hybrid. The activation completeness check
    // (apps/api/src/services/service-offering.service.ts) returns
    // SERVICE_OFFERING_INCOMPLETE if the area is missing for
    // those modes; we always carry the country so save / resume
    // also work without forcing the seller to revisit the page.
    ...(serviceAreaCountry
      ? {
          serviceAreas: [{ countryCode: serviceAreaCountry }],
        }
      : {}),
    pricing: {
      kind: pricingKind,
      ...(pricingKind !== "ContactForQuote"
        ? {
            amountMinor: Math.round(Number(pricingAmount) * 100),
            currency: "USD",
            // Omit the unitId when the unit is unchosen so the
            // partial-draft schema can accept the save. The
            // STRICT activate schema enforces the unit on
            // activation.
            ...(pricingUnit ? { unitId: pricingUnit } : {}),
          }
        : {}),
    },
    genreTags,
    includedServiceCategoryKeys: [],
    idempotencyKey: draftIdempotencyKeyRef.current ?? "",
  });

  const handleSave = () => {
    if (draftIdempotencyKeyRef.current === null) {
      draftIdempotencyKeyRef.current = `draft-${crypto.randomUUID()}`;
    }
    void performSave();
  };

  const performSave = async () => {
    setSaveState("saving");
    setSaveErrorMessage(null);
    setFieldErrors([]);
    try {
      // M2 (#85) PR-review feedback (round 3): when the editor is
      // on the "new" path (offeringId === "new" or null), the first
      // save CREATES the offering atomically and persists the
      // submitted fields. There is no separate "Create" click that
      // leaves an empty row behind. After the create, navigate to
      // the returned offeringId's editor so subsequent saves use
      // the PUT path.
      if (!offeringId || offeringId === "new") {
        if (draftIdempotencyKeyRef.current === null) {
          draftIdempotencyKeyRef.current = `draft-${crypto.randomUUID()}`;
        }
        const created = await createServiceOfferingDraft({
          workspaceId: actingWorkspace.workspaceId,
          idempotencyKey: draftIdempotencyKeyRef.current,
          draft: buildDraftPayload(),
        });
        setOffering(created);
        setSaveState("saved");
        // Replace the URL so the user can refresh without losing
        // the offeringId and subsequent saves use PUT.
        void router.replace(
          `/seller/services/${encodeURIComponent(created.serviceOfferingId)}/edit`,
        );
        return;
      }
      const response = await saveServiceOfferingDraft({
        workspaceId: actingWorkspace.workspaceId,
        offeringId,
        draft: buildDraftPayload(),
      });
      setOffering(response.offering);
      setSaveState("saved");
    } catch (err) {
      const cls = asServiceOfferingClientError(err);
      if (cls) {
        setSaveErrorMessage(cls.message);
        setFieldErrors(cls.fieldErrors);
        if (cls.code === "SERVICE_OFFERING_NOT_DRAFT") setSaveState("idle");
        else setSaveState("error");
      } else {
        setSaveErrorMessage("Couldn't save. Please try again.");
        setSaveState("error");
      }
    }
  };

  const handleRetry = () => {
    void performSave();
  };

  const handleActivate = () => {
    if (activateIdempotencyKeyRef.current === null) {
      activateIdempotencyKeyRef.current = generateServiceOfferingIdempotencyKey();
    }
    void performActivate();
  };

  const performActivate = async () => {
    setActivateState("saving");
    setActivateErrorMessage(null);
    setActivateFieldErrors([]);
    if (draftIdempotencyKeyRef.current === null) {
      draftIdempotencyKeyRef.current = `draft-${crypto.randomUUID()}`;
    }
    if (!activateIdempotencyKeyRef.current) {
      // Fallback: should be set by handleActivate before this runs.
      activateIdempotencyKeyRef.current = generateServiceOfferingIdempotencyKey();
    }
    const payload: ServiceOfferingActivateRequestV1 = {
      title: title.trim(),
      description: description.trim(),
      primaryCategoryKey,
      serviceMode,
      // Activation is the canonical STRICT contract — service area
      // is required when the mode is InPerson / Hybrid and the
      // schema-level Zod refinement rejects missing values before
      // the request reaches the API.
      ...(serviceAreaCountry
        ? {
            serviceAreas: [{ countryCode: serviceAreaCountry }],
          }
        : { serviceAreas: [] }),
      pricing: {
        kind: pricingKind,
        ...(pricingKind !== "ContactForQuote"
          ? {
              amountMinor: Math.round(Number(pricingAmount) * 100),
              currency: "USD",
              unitId: pricingUnit,
            }
          : {}),
      },
      genreTags,
      includedServiceCategoryKeys: [],
      confirmationVersion: "m2-service-activation-v1",
      idempotencyKey: activateIdempotencyKeyRef.current ?? generateServiceOfferingIdempotencyKey(),
    };
    try {
      const response = await activateServiceOffering({
        workspaceId: actingWorkspace.workspaceId,
        offeringId,
        activation: payload,
      });
      setOffering(response.offering);
      setActivationEvidence(response.evidence);
      setActivateState("saved");
      setActivateConfirmOpen(false);
    } catch (err) {
      const cls = asServiceOfferingClientError(err);
      if (cls) {
        setActivateErrorMessage(cls.message);
        setActivateFieldErrors(cls.fieldErrors);
        if (cls.code === "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED") {
          setActivateState("error");
        } else {
          setActivateState("error");
        }
      } else {
        setActivateErrorMessage("Couldn't activate. Please try again.");
        setActivateState("error");
      }
    }
  };

  const handleUploadSample = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (uploading) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    const label = ((data.get("label") as string) ?? "").trim();
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setSamplesError("Choose an MP3 file to upload.");
      return;
    }
    if (!label) {
      setSamplesError("Sample label is required.");
      return;
    }
    // M2 (#85) PR-review feedback: the seller must tick the
    // media-use acknowledgement explicitly before each upload.
    // The application boundary re-validates the checkbox payload
    // so a forced submit cannot bypass the acknowledgement.
    if (!sampleConfirmed) {
      setSamplesError("Please confirm you have the right to share this audio sample.");
      return;
    }
    setUploading(true);
    setSamplesError(null);
    try {
      await uploadOfferingSample({
        offeringId,
        actingWorkspaceId: actingWorkspace.workspaceId,
        label,
        file,
      });
      form.reset();
      setSampleLabel("");
      setSampleConfirmed(false);
      const list = await listOfferingSamples({
        workspaceId: actingWorkspace.workspaceId,
        offeringId,
      });
      setSamples(list.samples);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not upload sample.";
      setSamplesError(msg);
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveSample = async (sample: Bg2AudioSamplePublicV1) => {
    if (removeConfirmId !== null) return;
    setRemoveConfirmId(sample.sampleId);
    setSamplesError(null);
    try {
      await removeOfferingSample({
        offeringId,
        sample,
        actingWorkspaceId: actingWorkspace.workspaceId,
      });
      const list = await listOfferingSamples({
        workspaceId: actingWorkspace.workspaceId,
        offeringId,
      });
      setSamples(list.samples);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not remove sample.";
      setSamplesError(msg);
    } finally {
      setRemoveConfirmId(null);
    }
  };

  const anchorForPath = (path: string): string => {
    if (path.startsWith("title")) return FIELD_IDS.title;
    if (path.startsWith("description")) return FIELD_IDS.description;
    if (path.startsWith("primaryCategoryKey")) return FIELD_IDS.primaryCategoryKey;
    if (path.startsWith("pricing.amountMinor")) return FIELD_IDS.pricingAmount;
    if (path.startsWith("pricing.unitId")) return FIELD_IDS.pricingUnit;
    if (path.startsWith("pricing.kind")) return FIELD_IDS.pricingKind;
    if (path.startsWith("samples")) return FIELD_IDS.samples;
    return path.replace(/\./g, "-");
  };

  const fieldErrorById = new Map<string, ApiFieldErrorV1>();
  for (const err of [...fieldErrors, ...activateFieldErrors]) {
    const id = anchorForPath(err.path);
    if (!fieldErrorById.has(id)) {
      fieldErrorById.set(id, err);
    }
  }

  const showActivateSummary = activateState === "saved" && activationEvidence;
  const summaryItems: ErrorSummaryItem[] = activateFieldErrors.map((err) => ({
    id: anchorForPath(err.path),
    path: err.path,
    message: err.message,
  }));

  const liveSampleCount = samples.filter(
    (s) => s.playbackUrl && s.contentType === "audio/mpeg",
  ).length;
  const serviceAreaRequired = serviceMode === "InPerson" || serviceMode === "Hybrid";
  const canActivate =
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    primaryCategoryKey.length > 0 &&
    (!serviceAreaRequired || serviceAreaCountry.length > 0) &&
    (pricingKind === "ContactForQuote" || (Number(pricingAmount) > 0 && pricingUnit.length > 0)) &&
    liveSampleCount >= 1 &&
    offering?.status === "Draft";

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-8 space-y-6">
        <Card variant="parchment" data-testid="service-offering-edit">
          <Card.Header>
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="font-label-sm uppercase tracking-widest text-muted">Service</span>
                <h1 className="text-3xl font-serif text-ink mt-1">Edit your service</h1>
                <p className="text-base text-muted mt-1">
                  Your private draft. Saving preserves this revision — activation is a separate
                  explicit step.
                </p>
              </div>
              <span
                aria-live="polite"
                className={`font-label-md uppercase tracking-wider ${
                  offering?.status === "Active"
                    ? "text-seaGlass"
                    : offering?.status === "Draft"
                      ? "text-muted"
                      : "text-ink"
                }`}
                data-testid="service-offering-edit-status"
              >
                {offering?.status === "Active"
                  ? "Available"
                  : offering?.status === "Draft"
                    ? "Private draft"
                    : (offering?.status ?? "Private draft")}
              </span>
            </div>
          </Card.Header>
          <Card.Content className="space-y-6">
            {summaryItems.length > 0 && (
              <ErrorSummary
                title="Please fix the following before activating:"
                errors={summaryItems}
                testId="service-offering-edit-error-summary"
              />
            )}

            <section className="space-y-4" aria-labelledby="overview-heading">
              <h2 id="overview-heading" className="text-xl font-serif text-ink">
                Service overview
              </h2>
              <div className="flex flex-col gap-1">
                <label htmlFor={FIELD_IDS.title} className="text-sm font-medium text-ink">
                  Service title <span aria-hidden="true">*</span>
                </label>
                <input
                  id={FIELD_IDS.title}
                  type="text"
                  maxLength={80}
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  aria-invalid={fieldErrorById.get(FIELD_IDS.title) ? "true" : undefined}
                  aria-describedby={
                    fieldErrorById.get(FIELD_IDS.title) ? fieldErrorId(FIELD_IDS.title) : undefined
                  }
                  className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base aria-[invalid=true]:border-coral"
                  data-testid="service-offering-edit-input-title"
                />
                {fieldErrorById.get(FIELD_IDS.title) && (
                  <p
                    id={fieldErrorId(FIELD_IDS.title)}
                    role="alert"
                    className="text-xs text-coral mt-1"
                    data-testid="service-offering-edit-input-title-error"
                  >
                    {fieldErrorById.get(FIELD_IDS.title)!.message}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={FIELD_IDS.description} className="text-sm font-medium text-ink">
                  Description <span aria-hidden="true">*</span>
                </label>
                <textarea
                  id={FIELD_IDS.description}
                  rows={4}
                  maxLength={2000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  aria-invalid={fieldErrorById.get(FIELD_IDS.description) ? "true" : undefined}
                  aria-describedby={
                    fieldErrorById.get(FIELD_IDS.description)
                      ? fieldErrorId(FIELD_IDS.description)
                      : undefined
                  }
                  className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base aria-[invalid=true]:border-coral"
                  data-testid="service-offering-edit-input-description"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={FIELD_IDS.primaryCategoryKey}
                  className="text-sm font-medium text-ink"
                >
                  Primary category <span aria-hidden="true">*</span>
                </label>
                <select
                  id={FIELD_IDS.primaryCategoryKey}
                  value={primaryCategoryKey}
                  onChange={(e) => setPrimaryCategoryKey(e.target.value)}
                  className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base min-h-[44px]"
                  data-testid="service-offering-edit-input-category"
                >
                  <option value="">Select a category</option>
                  {taxonomy.categories.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <section className="space-y-4" aria-labelledby="delivery-heading">
              <h2 id="delivery-heading" className="text-xl font-serif text-ink">
                Delivery
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {(["Remote", "InPerson", "Hybrid"] as const).map((m) => (
                  <label
                    key={m}
                    className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer ${
                      serviceMode === m
                        ? "border-aubergine bg-surface"
                        : "border-surface-variant bg-surface-container-low"
                    }`}
                  >
                    <input
                      type="radio"
                      name="serviceMode"
                      value={m}
                      checked={serviceMode === m}
                      onChange={() => setServiceMode(m)}
                      className="accent-aubergine"
                      data-testid={`service-offering-edit-mode-${m}`}
                    />
                    <span className="font-medium text-ink">{m}</span>
                  </label>
                ))}
              </div>
              {(serviceMode === "InPerson" || serviceMode === "Hybrid") && (
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor={FIELD_IDS.serviceAreaCountry}
                    className="text-sm font-medium text-ink"
                  >
                    Coarse service area <span aria-hidden="true">*</span>
                  </label>
                  <p className="text-xs text-muted">
                    Required for InPerson / Hybrid. Pick the country or territory where you
                    typically deliver; the M1 location filter uses this without exposing a precise
                    address.
                  </p>
                  <select
                    id={FIELD_IDS.serviceAreaCountry}
                    value={serviceAreaCountry}
                    onChange={(e) => setServiceAreaCountry(e.target.value)}
                    className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base min-h-[44px]"
                    data-testid="service-offering-edit-input-service-area-country"
                  >
                    <option value="">Select a country</option>
                    {COMMON_SERVICE_AREA_COUNTRY_CODES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </section>

            <section className="space-y-4" aria-labelledby="pricing-heading">
              <h2 id="pricing-heading" className="text-xl font-serif text-ink">
                Pricing
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {(["Fixed", "StartingAt", "ContactForQuote"] as const).map((k) => (
                  <label
                    key={k}
                    className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer ${
                      pricingKind === k
                        ? "border-aubergine bg-surface"
                        : "border-surface-variant bg-surface-container-low"
                    }`}
                  >
                    <input
                      type="radio"
                      name="pricingKind"
                      value={k}
                      checked={pricingKind === k}
                      onChange={() => setPricingKind(k)}
                      className="accent-aubergine"
                      data-testid={`service-offering-edit-pricing-${k}`}
                    />
                    <span className="font-medium text-ink">{k}</span>
                  </label>
                ))}
              </div>
              {pricingKind !== "ContactForQuote" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor={FIELD_IDS.pricingAmount}
                      className="text-sm font-medium text-ink"
                    >
                      Base amount (USD)
                    </label>
                    <input
                      id={FIELD_IDS.pricingAmount}
                      type="number"
                      min={1}
                      value={pricingAmount}
                      onChange={(e) => setPricingAmount(e.target.value)}
                      className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base"
                      data-testid="service-offering-edit-input-amount"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor={FIELD_IDS.pricingUnit} className="text-sm font-medium text-ink">
                      Pricing unit
                    </label>
                    <select
                      id={FIELD_IDS.pricingUnit}
                      value={pricingUnit}
                      onChange={(e) => setPricingUnit(e.target.value)}
                      className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base min-h-[44px]"
                      data-testid="service-offering-edit-input-unit"
                    >
                      <option value="">Select a unit</option>
                      {taxonomy.pricingUnits.map((u) => (
                        <option key={u.key} value={u.key}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </section>

            <section className="space-y-4" aria-labelledby="samples-heading">
              <h2 id="samples-heading" className="text-xl font-serif text-ink">
                Audio work samples
              </h2>
              <p className="text-sm text-muted">
                Up to 3 MP3 samples. Each upload requires you to confirm you have the right to share
                it as a SoundHub preview.
              </p>
              <ul className="space-y-3" data-testid="service-offering-edit-samples-list">
                {samples.map((sample) => (
                  <li
                    key={sample.sampleId}
                    className="flex items-start justify-between gap-3 p-3 border border-surface-variant rounded-md"
                    data-testid="service-offering-edit-sample-row"
                  >
                    <div className="flex-1 min-w-0">
                      <p
                        className="text-sm font-medium text-ink"
                        data-testid="service-offering-edit-sample-label"
                      >
                        {sample.label}
                      </p>
                      <p className="text-xs text-muted">
                        #{sample.displayOrder} · {(sample.byteSize / 1024).toFixed(1)} KB
                      </p>
                      <audio
                        controls
                        preload="none"
                        src={sample.playbackUrl}
                        className="mt-2 w-full"
                        aria-label={`${sample.label} private sample player`}
                        data-testid="service-offering-edit-sample-player"
                      >
                        Your browser does not support inline audio playback.
                      </audio>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void handleRemoveSample(sample);
                      }}
                      disabled={removeConfirmId === sample.sampleId}
                      className="bg-coral text-white px-3 py-1.5 rounded-md text-xs font-medium hover:opacity-90 disabled:opacity-50 transition-colors min-h-[44px]"
                      data-testid="service-offering-edit-sample-remove"
                    >
                      {removeConfirmId === sample.sampleId ? "Removing…" : "Remove"}
                    </button>
                  </li>
                ))}
              </ul>
              {samples.length < 3 && (
                <form
                  className="space-y-2 p-3 border border-dashed border-surface-variant rounded-md"
                  onSubmit={(e) => {
                    void handleUploadSample(e);
                  }}
                  data-testid="service-offering-edit-sample-upload-form"
                >
                  <label
                    htmlFor="service-offering-edit-sample-label-input"
                    className="text-sm font-medium text-ink"
                  >
                    Sample label
                  </label>
                  <input
                    id="service-offering-edit-sample-label-input"
                    name="label"
                    type="text"
                    maxLength={120}
                    required
                    value={sampleLabel}
                    onChange={(e) => setSampleLabel(e.target.value)}
                    className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base"
                    data-testid="service-offering-edit-sample-label-input"
                  />
                  <label className="text-sm font-medium text-ink block">
                    Choose MP3 (max 25 MB)
                    <input
                      type="file"
                      name="file"
                      accept="audio/mpeg"
                      required
                      className="mt-1 w-full text-sm"
                      data-testid="service-offering-edit-sample-file-input"
                    />
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      required
                      checked={sampleConfirmed}
                      onChange={(e) => setSampleConfirmed(e.target.checked)}
                      className="mt-1"
                      data-testid="service-offering-edit-sample-confirmation"
                    />
                    <span>I confirm I have the right to share this audio sample.</span>
                  </label>
                  <p className="text-xs text-muted">
                    Uploading a work sample does not verify or transfer copyright ownership.
                  </p>
                  <button
                    type="submit"
                    disabled={uploading}
                    className="bg-aubergine text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-aubergine-hover disabled:opacity-50 transition-colors min-h-[44px]"
                    data-testid="service-offering-edit-sample-submit"
                  >
                    {uploading ? "Uploading…" : "Upload sample"}
                  </button>
                  {samplesError && (
                    <p className="text-xs text-coral" role="alert">
                      {samplesError}
                    </p>
                  )}
                </form>
              )}
            </section>

            <section className="space-y-4" aria-labelledby="activation-heading">
              <h2 id="activation-heading" className="text-xl font-serif text-ink">
                Activation readiness
              </h2>
              <p className="text-sm text-muted">
                Activating makes this service visible to buyers in search and ProjectRequests.
                Service terms and pricing are non-binding until incorporated into an approved
                TermsVersion.
              </p>
              <ul className="space-y-1 text-sm">
                <li>{title.trim().length > 0 ? "✓" : "○"} Title and description</li>
                <li>{primaryCategoryKey.length > 0 ? "✓" : "○"} Primary category</li>
                <li>
                  {serviceMode ? "✓" : "○"} Delivery mode (
                  {serviceMode === "InPerson" || serviceMode === "Hybrid"
                    ? "coarse service area "
                    : ""}
                  required)
                </li>
                {serviceAreaRequired && (
                  <li>{serviceAreaCountry ? "✓" : "○"} Coarse service area</li>
                )}
                <li>
                  {pricingKind === "ContactForQuote" ||
                  (Number(pricingAmount) > 0 && pricingUnit.length > 0)
                    ? "✓"
                    : "○"}{" "}
                  Pricing ({pricingKind})
                </li>
                <li>
                  {liveSampleCount >= 1 ? "✓" : "○"} {liveSampleCount} playable sample
                  {liveSampleCount === 1 ? "" : "s"} attached
                </li>
              </ul>
              {showActivateSummary && activationEvidence && (
                <Alert
                  role="status"
                  variant="recovery"
                  title="Service activated"
                  data-testid="service-offering-edit-activated-alert"
                >
                  Activated at {activationEvidence.activatedAt}.
                </Alert>
              )}
              {activateState === "error" && activateErrorMessage && (
                <Alert
                  role="alert"
                  variant="failure"
                  title="Couldn't activate"
                  data-testid="service-offering-edit-activate-error"
                >
                  {activateErrorMessage}
                </Alert>
              )}
            </section>

            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-surface-variant">
              <SaveDraftActions
                state={saveState}
                errorMessage={saveErrorMessage}
                onRetry={handleRetry}
                testIdPrefix="service-offering-edit-save"
              />
              <div className="flex items-center gap-2">
                {offering?.status !== "Active" && (
                  <>
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saveState === "saving"}
                      className="inline-flex items-center justify-center min-h-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine disabled:opacity-50"
                      data-testid="service-offering-edit-save-draft"
                    >
                      Save draft
                    </button>
                    <button
                      type="button"
                      onClick={() => setActivateConfirmOpen(true)}
                      disabled={
                        !canActivate || activateState === "saving" || saveState === "saving"
                      }
                      className="inline-flex items-center justify-center min-h-[44px] py-3 px-6 text-base font-medium text-white bg-coral hover:opacity-90 rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral disabled:opacity-50"
                      data-testid="service-offering-edit-activate"
                    >
                      Activate service
                    </button>
                  </>
                )}
                <Link
                  href={"/seller/services"}
                  className="inline-flex items-center justify-center min-h-[44px] py-3 px-4 text-sm font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                  data-testid="service-offering-edit-back"
                >
                  Back to Your services
                </Link>
              </div>
            </div>

            {activateConfirmOpen && (
              <Alert
                role="alert"
                variant="recovery"
                title="Activate this service?"
                data-testid="service-offering-edit-activate-confirm"
                action={{
                  label: activateState === "saving" ? "Activating…" : "Confirm activate",
                  onClick: handleActivate,
                  testId: "service-offering-edit-activate-confirm-button",
                }}
              >
                <p className="text-sm">
                  Activating makes this service eligible for search and ProjectRequests. You can
                  pause or update it later; activation itself is atomic and cannot be partially
                  published.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActivateConfirmOpen(false)}
                    className="text-sm text-ink underline"
                    data-testid="service-offering-edit-activate-cancel"
                  >
                    Cancel
                  </button>
                </div>
              </Alert>
            )}
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
