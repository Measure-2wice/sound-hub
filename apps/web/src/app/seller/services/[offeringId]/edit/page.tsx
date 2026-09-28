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

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
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
import { fetchSellerProfile } from "../../../../lib/seller-profile-client";
import {
  listOfferingSamples,
  removeOfferingSample,
  uploadOfferingSample,
} from "../../../../lib/audio-samples-client";
import {
  ArrowBackIcon,
  ArrowForwardIcon,
  CheckCircleIcon,
  CloseIcon,
  CloudDoneIcon,
  CloudIcon,
  CloudOffIcon,
  DomainIcon,
  ExpandMoreIcon,
  InfoIcon,
  LockIcon,
  RadioUncheckedIcon,
  SaveIcon,
  SyncAltIcon,
  SyncIcon,
  VerifiedIcon,
  WifiIcon,
} from "../../../../components/ui/Icon";
import type {
  ApiFieldErrorV1,
  ServiceOfferingActivateRequestV1,
  ServiceOfferingDraftRequestV1,
  ServiceOfferingOwnerViewV1,
  ServiceOfferingTaxonomyResponseV1,
  Bg2AudioSamplePublicV1,
  SellerProfileOwnerViewV1,
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

// Phase 2 visual reconciliation (issue #85): human-facing display
// labels for the domain enums that the editor surfaces as radios.
// The serialized API/contract values (`InPerson`, `StartingAt`,
// `ContactForQuote`, `Fixed`) are NOT changed — only the text the
// seller sees. The radio inputs still submit the underlying enum
// value; these maps only feed the <span> next to each radio.
const SERVICE_MODE_LABEL: Record<"Remote" | "InPerson" | "Hybrid", string> = {
  Remote: "Remote",
  InPerson: "In person",
  Hybrid: "Hybrid",
};

const PRICING_KIND_LABEL: Record<"Fixed" | "StartingAt" | "ContactForQuote", string> = {
  Fixed: "Fixed",
  StartingAt: "Starting at",
  ContactForQuote: "Contact for quote",
};

const SECTION_IDS = {
  overview: "section-overview",
  delivery: "section-delivery",
  pricing: "section-pricing",
  samples: "section-work-samples",
  optional: "section-optional",
  activation: "section-activation",
} as const;

// Phase 2 #85 Manual QA Round 3 — save-status fidelity: a
// snapshot of the persisted draft fields. The status header row
// distinguishes the *new*, never-saved editor (`Draft not saved
// yet`) from a *resumed* draft (`Draft saved`) and from a dirty
// edit (`Unsaved changes`) by comparing the live form state
// against the most recent trustworthy capture — the offering row
// the API returned on bootstrap, or the response of a successful
// Save draft.
//
// A snapshot is captured ONLY at moments the API confirms what
// it remembers. We MUST NOT invent a per-edit timestamp: the
// ServiceOffering read shape (see
// ServiceOfferingOwnerViewV1 / packages/types/src/index.ts)
// exposes `activatedAt` but no general `updatedAt`, and the
// current fix must not add an unapproved contract field.
type DraftFieldsSnapshot = {
  readonly title: string;
  readonly description: string;
  readonly primaryCategoryKey: string;
  // Phase 2 #85 Manual QA Round 10 — faithful Draft round-trip.
  // The RELAXED Draft contract (packages/types/src/index.ts:1044)
  // marks every field as optional; fabricating "Remote" /
  // "StartingAt" / "600" for missing persisted values and then
  // resending them on the next save persists choices the seller
  // never made. Local state now mirrors the persisted shape — null
  // for unset fields — so the next save sends exactly the fields
  // the seller has actually populated.
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid" | null;
  readonly serviceAreaCountry: string;
  readonly pricingKind: "Fixed" | "StartingAt" | "ContactForQuote" | null;
  readonly pricingAmount: string | null;
  readonly pricingUnit: string;
  readonly genreTags: readonly string[];
};

function snapshotFromOffering(o: ServiceOfferingOwnerViewV1): DraftFieldsSnapshot {
  return {
    title: o.title,
    description: o.description,
    primaryCategoryKey: o.primaryCategoryKey ?? "",
    // Phase 2 #85 Manual QA Round 10 — do not fabricate defaults.
    // The previous `?? "Remote"` / `?? "StartingAt"` / `: "600"`
    // pattern converted a missing persisted value into a value
    // the seller never chose, then `buildDraftPayload` persisted
    // that fabricated value on the next save. The snapshot now
    // mirrors the persisted shape so the dirty-detection
    // baseline reflects exactly what the API returned.
    serviceMode: o.serviceMode ?? null,
    serviceAreaCountry: o.serviceAreas[0]?.countryCode ?? "",
    pricingKind: o.pricing?.kind ?? null,
    pricingAmount:
      o.pricing?.amountMinor !== undefined ? String(o.pricing.amountMinor / 100) : null,
    pricingUnit: o.pricing?.unitId ?? "",
    genreTags: [...o.genreTags],
  };
}

function snapshotFromFormState(state: {
  readonly title: string;
  readonly description: string;
  readonly primaryCategoryKey: string;
  // Phase 2 #85 Manual QA Round 10 — nullable fields match the
  // useState types below. The form snapshot is compared to the
  // persisted snapshot for dirty-state detection; both nulls are
  // equal, so an unpopulated serviceMode / pricingKind /
  // pricingAmount doesn't trip the dirty flag spuriously.
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid" | null;
  readonly serviceAreaCountry: string;
  readonly pricingKind: "Fixed" | "StartingAt" | "ContactForQuote" | null;
  readonly pricingAmount: string | null;
  readonly pricingUnit: string;
  readonly genreTags: readonly string[];
}): DraftFieldsSnapshot {
  return {
    title: state.title,
    description: state.description,
    primaryCategoryKey: state.primaryCategoryKey,
    serviceMode: state.serviceMode,
    serviceAreaCountry: state.serviceAreaCountry,
    pricingKind: state.pricingKind,
    pricingAmount: state.pricingAmount,
    pricingUnit: state.pricingUnit,
    genreTags: [...state.genreTags],
  };
}

function snapshotEquals(a: DraftFieldsSnapshot, b: DraftFieldsSnapshot): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.primaryCategoryKey === b.primaryCategoryKey &&
    a.serviceMode === b.serviceMode &&
    a.serviceAreaCountry === b.serviceAreaCountry &&
    a.pricingKind === b.pricingKind &&
    a.pricingAmount === b.pricingAmount &&
    a.pricingUnit === b.pricingUnit &&
    a.genreTags.length === b.genreTags.length &&
    a.genreTags.every((t, i) => t === b.genreTags[i])
  );
}

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

// Phase 2 visual reconciliation: each editor section renders in a
// visually distinct card (rounded-xl, parchment surface, clear
// boundary). Preserves the existing semantic `<section>` element,
// `aria-labelledby` association, and the section's HTML id so the
// sidebar / mobile jump links continue to anchor correctly. No
// domain state lives in this component — it's purely presentational.
function SectionCard({
  id,
  number,
  title,
  description,
  testId,
  children,
}: {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly description?: string;
  readonly testId?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      data-testid={testId ?? `service-offering-edit-section-${id}`}
      className="bg-surface-container-low border border-borderWarm rounded-xl p-5 sm:p-6 space-y-4 sm:space-y-5 shadow-sm scroll-mt-24"
      aria-labelledby={`${id}-heading`}
    >
      <header className="border-b border-borderWarm/70 pb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-label-md uppercase tracking-wider text-seaGlass font-bold">{number}</p>
          <h2 id={`${id}-heading`} className="font-serif text-xl text-ink mt-1">
            {title}
          </h2>
          {description ? <p className="text-sm text-muted mt-1">{description}</p> : null}
        </div>
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

// Phase 2 visual reconciliation: side-by-side readiness row used in
// the Activation readiness section. Truthfully reports
// complete/incomplete state using both a check / dash glyph and a
// label so color is never the only signal (per the M2 UX addendum).
function ReadinessRow({
  ready,
  title,
  meta,
}: {
  readonly ready: boolean;
  readonly title: string;
  readonly meta?: string;
}) {
  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-3 p-3 rounded-lg border ${
        ready ? "bg-surface-container-lowest border-borderWarm" : "bg-surface border-borderWarm"
      }`}
      data-testid={`service-offering-edit-readiness-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}`}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        {ready ? (
          <CheckCircleIcon
            className={`shrink-0 ${ready ? "text-seaGlass" : "text-muted"}`}
            width={20}
            height={20}
          />
        ) : (
          <RadioUncheckedIcon
            className={`shrink-0 ${ready ? "text-seaGlass" : "text-muted"}`}
            width={20}
            height={20}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{title}</p>
          {meta ? <p className="text-xs text-muted mt-0.5 break-words">{meta}</p> : null}
        </div>
      </div>
      <span
        className={`shrink-0 self-start sm:self-auto font-label-md uppercase tracking-wider text-xs font-bold ${
          ready ? "text-seaGlass" : "text-muted"
        }`}
      >
        {ready ? "Ready" : "Pending"}
      </span>
    </div>
  );
}

// Phase 2 visual reconciliation: desktop sticky section index.
// Renders alongside the main editor on >= lg. Each row anchors to
// the corresponding section id and exposes the section's number,
// name, and an honest status pill (Complete / In progress / Not
// required). Never lies about state: the status string is derived
// from the same data the Activation readiness section uses so the
// two surfaces cannot drift.
//
// `isActive` (Phase 2 #85 Manual QA Round 6 — final post-
// activation copy cleanup) lets the bottom helper block branch
// from the Draft-only "Activation readiness / Ready to activate"
// copy to the truthful active-state "Activation / Available"
// summary. The two-branch shape means an Active offering never
// describes activation as a future action — the rail stays
// honest across reloads (the rail is purely presentational; it
// never invents Pause / re-activation behavior).
function DesktopSectionNav({
  currentLabel,
  sections,
  isActive,
}: {
  readonly currentLabel: string;
  readonly sections: ReadonlyArray<{
    readonly id: string;
    readonly number: string;
    readonly name: string;
    readonly status: "complete" | "inProgress" | "optional";
  }>;
  readonly isActive: boolean;
}) {
  return (
    <aside className="hidden lg:block lg:col-span-4" aria-label="Service sections">
      <div className="sticky top-24 bg-surface-container-lowest border border-borderWarm rounded-xl p-4 space-y-4 shadow-sm">
        <div>
          <p className="font-label-md uppercase tracking-wider text-muted">Service sections</p>
          <h2 className="font-serif text-lg text-ink mt-1">Sections</h2>
        </div>
        <nav
          className="space-y-1"
          aria-label="Section navigation"
          data-testid="service-offering-edit-section-nav"
        >
          {sections.map((s) => {
            const isCurrent = s.id === currentLabel;
            const stateLabel =
              s.status === "complete"
                ? "Complete"
                : s.status === "optional"
                  ? "Optional"
                  : "Pending";
            const stateColor =
              s.status === "complete"
                ? "text-seaGlass"
                : s.status === "optional"
                  ? "text-muted"
                  : "text-muted";
            return (
              <a
                key={s.id}
                href={`#${s.id}`}
                aria-current={isCurrent ? "true" : undefined}
                className={`group flex items-center justify-between gap-2 p-2 rounded-lg transition-colors border-l-4 ${
                  isCurrent
                    ? "bg-surface-container-high border-seaGlass text-ink"
                    : "border-transparent text-muted hover:bg-surface-container hover:text-ink"
                }`}
                data-testid={`service-offering-edit-section-nav-${s.id}`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs text-muted">{s.number}</span>
                  <span className="font-medium truncate">{s.name}</span>
                </span>
                <span
                  className={`font-label-md uppercase tracking-wider text-[10px] font-bold ${stateColor}`}
                >
                  {stateLabel}
                </span>
              </a>
            );
          })}
        </nav>
        <div className="pt-3 border-t border-borderWarm">
          <p className="font-label-md uppercase tracking-wider text-muted text-xs">
            {isActive ? "Activation" : "Activation readiness"}
          </p>
          <p className="text-sm text-ink mt-1 font-semibold">
            {isActive
              ? "Available"
              : sections.find((s) => s.id === SECTION_IDS.activation)?.status === "complete"
                ? "Ready to activate"
                : "Pending — see Activation readiness"}
          </p>
        </div>
      </div>
    </aside>
  );
}

// Phase 2 visual reconciliation: mobile sticky section jump. The
// <lg> viewport renders the same six sections but stacks them as a
// one-column document flow; the jump button keeps the long editor
// scannable. Mirrors the M2 UX addendum's "Mobile document flow +
// optional compact section jump" pattern.
function MobileSectionJump({
  currentName,
  sections,
}: {
  readonly currentName: string;
  readonly sections: ReadonlyArray<{
    readonly id: string;
    readonly number: string;
    readonly name: string;
  }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="sticky top-16 z-30 lg:hidden bg-surface/95 backdrop-blur-md border-b border-borderWarm"
      data-testid="service-offering-edit-mobile-section-jump"
    >
      <div className="max-w-[1440px] mx-auto px-4 py-2">
        <button
          type="button"
          aria-expanded={open ? "true" : "false"}
          aria-controls="service-offering-edit-section-menu"
          onClick={() => setOpen((v) => !v)}
          className="w-full min-h-[44px] px-3 rounded-lg bg-surface-container text-ink flex items-center justify-between shadow-sm focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
        >
          <span className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-seaGlass shrink-0" aria-hidden="true"></span>
            <span className="font-label-md text-sm font-semibold truncate">{currentName}</span>
          </span>
          <span className="flex items-center gap-1 text-muted font-label-md text-xs shrink-0">
            Jump
            <ExpandMoreIcon
              className={`transition-transform ${open ? "rotate-180" : ""}`}
              width={18}
              height={18}
            />
          </span>
        </button>
        {open ? (
          <nav
            id="service-offering-edit-section-menu"
            aria-label="Section navigation"
            className="mt-2 p-2 rounded-xl bg-surface-container-lowest shadow-md flex flex-col gap-1"
          >
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={() => setOpen(false)}
                className="px-3 py-2.5 rounded-lg text-left font-label-md text-sm text-ink hover:bg-surface-container focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
              >
                <span className="font-mono text-xs text-muted mr-2">{s.number}</span>
                {s.name}
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </div>
  );
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
  // Phase 2 #85 Manual QA Round 10 — faithful Draft round-trip.
  // The relaxed Draft contract marks every field as optional;
  // the previous defaults ("Remote" / "StartingAt" / "600") would
  // fabricate a persisted value on the first save even when the
  // seller had not chosen one, and would round-trip those
  // fabricated values back into the form on every resume. Local
  // state now starts null; the seller populates fields
  // explicitly, and `buildDraftPayload` only sends populated
  // fields.
  const [serviceMode, setServiceMode] = useState<"Remote" | "InPerson" | "Hybrid" | null>(null);
  const [pricingKind, setPricingKind] = useState<"Fixed" | "StartingAt" | "ContactForQuote" | null>(
    null,
  );
  const [pricingAmount, setPricingAmount] = useState<string | null>(null);
  const [pricingUnit, setPricingUnit] = useState("");
  // Coarse service area: one country code, required when the
  // service mode is InPerson or Hybrid. The activation
  // completeness check at /api/services/:id/activate returns
  // SERVICE_OFFERING_INCOMPLETE if the area is missing for those
  // modes; the editor surfaces the picker only when the radio
  // changes.
  const [serviceAreaCountry, setServiceAreaCountry] = useState("");
  const [genreTags, setGenreTags] = useState<string[]>([]);
  // Phase 2 #85 Manual QA Round 3 — save-status fidelity:
  // captures the form-state values at the last moment the API
  // confirmed them (resume, or a successful Save draft). Null
  // means the editor has never been associated with a persisted
  // row — the new-editor "Draft not saved yet" state. The
  // status row derives a truthful "Draft saved" / "Unsaved
  // changes" string from this snapshot without inventing any
  // timestamp the API does not provide.
  const [draftBaseline, setDraftBaseline] = useState<DraftFieldsSnapshot | null>(null);
  const [samples, setSamples] = useState<readonly Bg2AudioSamplePublicV1[]>([]);
  const [samplesError, setSamplesError] = useState<string | null>(null);
  const [sampleLabel, setSampleLabel] = useState("");
  // Phase 2 #85 visual reconciliation (Finding 3): the header
  // "Profile identity" chip surfaces the seller's Professional
  // Profile `identity.professionalName` rather than the acting
  // Workspace name. The Professional Profile is fetched alongside
  // the offering + taxonomy bootstrap so the chip reflects the
  // published Draft identity. A null result means no Profile has
  // been authored yet — the chip renders an honest fallback.
  const [sellerProfile, setSellerProfile] = useState<SellerProfileOwnerViewV1 | null>(null);
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
  // M2 (#85) Manual QA Round 4 — private audio playback blocker.
  // The `<audio>`'s `onError` event fires once per sample when the
  // browser fails to load its media resource (e.g. CORP blocked,
  // session expired mid-session, byte transport dropped). We
  // remember the affected `sampleId`s so the editor renders a
  // inline, screen-reader-accessible message in place of the
  // native player instead of surfacing an uncaught runtime error
  // or an unstyled Next.js overlay. The set is reset on a fresh
  // successful list refresh (see handleUploadSample /
  // handleRemoveSample).
  const [playbackFailureIds, setPlaybackFailureIds] = useState<readonly string[]>([]);
  const markSamplePlaybackFailure = (sampleId: string) => {
    setPlaybackFailureIds((prev) => (prev.includes(sampleId) ? prev : [...prev, sampleId]));
  };

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

  // Phase 2 visual reconciliation: track the section currently in
  // view (mobile jump label + desktop aria-current). Declared
  // before any early return so React's hook order stays stable.
  const [currentSectionId, setCurrentSectionId] = useState<string>(SECTION_IDS.overview);

  // Phase 2 #85 Manual QA Round 3 — save-status fidelity: derive
  // `hasPersistedDraft` (a non-null baseline) and `isDirty`
  // (current form-state differs from the baseline) BEFORE any
  // early return so the rules-of-hooks stays satisfied.
  const formSnapshot = snapshotFromFormState({
    title,
    description,
    primaryCategoryKey,
    serviceMode,
    serviceAreaCountry,
    pricingKind,
    pricingAmount,
    pricingUnit,
    genreTags,
  });
  const hasPersistedDraft = draftBaseline !== null;
  const isDirty = hasPersistedDraft && !snapshotEquals(formSnapshot, draftBaseline);

  // Phase 2 #85 Manual QA Round 5 — post-activation
  // truthfulness. The header description AND the activation
  // readiness banner were driven by Draft-only concepts
  // (`offering?.status === "Draft"` for `canActivate`, plus the
  // literal "private until you activate" copy). For an `Active`
  // offering those concepts are no longer defined: the
  // requirements have been satisfied and acted on, so the page
  // MUST NOT render Draft-readiness copy that is now false.
  // `isActive` is derived here (BEFORE any early return) so the
  // header, the activation section, and the activated-status
  // banner share one source of truth and respect React's
  // rules-of-hooks. Paused/Archived are explicitly out of scope
  // per the QA brief (no Pause/edit-active behavior) — for those
  // lifecycles the page continues to render the existing Draft
  // presentation rather than fabricate new copy.
  const isActive = offering?.status === "Active";

  // Derive the section readiness state up front (before any early
  // return) so the sidebar / mobile jump / activation section all
  // share the same data. `liveSampleCount` and `canActivate` are
  // computed later in the function but read here through stable
  // inputs — see the comment above each derivation for the
  // dependency chain.
  const liveSampleCountEarly = samples.filter(
    (s) => s.playbackUrl && s.contentType === "audio/mpeg",
  ).length;
  const serviceAreaRequiredEarly = serviceMode === "InPerson" || serviceMode === "Hybrid";
  const overviewReadyEarly =
    title.trim().length > 0 && description.trim().length > 0 && primaryCategoryKey.length > 0;
  const deliveryReadyEarly =
    !!serviceMode && (!serviceAreaRequiredEarly || serviceAreaCountry.length > 0);
  const pricingReadyEarly =
    pricingKind === "ContactForQuote" || (Number(pricingAmount) > 0 && pricingUnit.length > 0);
  const samplesReadyEarly = liveSampleCountEarly >= 1;
  const canActivateEarly =
    overviewReadyEarly && deliveryReadyEarly && pricingReadyEarly && samplesReadyEarly;

  const sectionNavEarly = useMemo(
    () => [
      {
        id: SECTION_IDS.overview,
        number: "01",
        name: "Overview",
        status: overviewReadyEarly ? ("complete" as const) : ("inProgress" as const),
      },
      {
        id: SECTION_IDS.delivery,
        number: "02",
        name: "Delivery",
        status: deliveryReadyEarly ? ("complete" as const) : ("inProgress" as const),
      },
      {
        id: SECTION_IDS.pricing,
        number: "03",
        name: "Pricing",
        status: pricingReadyEarly ? ("complete" as const) : ("inProgress" as const),
      },
      {
        id: SECTION_IDS.samples,
        number: "04",
        name: "Work samples",
        status: samplesReadyEarly ? ("complete" as const) : ("inProgress" as const),
      },
      {
        id: SECTION_IDS.optional,
        number: "05",
        name: "Optional details",
        status: "optional" as const,
      },
      {
        id: SECTION_IDS.activation,
        number: "06",
        // Phase 2 #85 Manual QA Round 7 — final active-state
        // truthfulness. The sidebar / mobile-jump item still
        // claimed "Activation readiness" for an Active offering,
        // even though the corresponding section heading now
        // correctly reads "Activation" (Round 5). Branching the
        // `name` on `isActive` keeps the rail item consistent
        // with the section card it anchors to. Paused / Archived
        // continue to render the existing Draft-name (Pause and
        // re-activation are out of scope for #85).
        name: isActive ? "Activation" : "Activation readiness",
        status: canActivateEarly ? ("complete" as const) : ("inProgress" as const),
      },
    ],
    [
      isActive,
      overviewReadyEarly,
      deliveryReadyEarly,
      pricingReadyEarly,
      samplesReadyEarly,
      canActivateEarly,
    ],
  );

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

  // Phase 2 visual reconciliation: IntersectionObserver-driven
  // `currentSectionId` for the desktop sidebar aria-current and
  // the mobile section-jump label. Declared here (BEFORE any
  // early return) so React's hook order stays stable across
  // renders — running hooks after a conditional return throws
  // "change in the order of Hooks".
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!profileLoaded) return undefined;
    const nodes = sectionNavEarly
      .map((s) => document.getElementById(s.id))
      .filter((n): n is HTMLElement => n !== null);
    if (nodes.length === 0) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target?.id) {
          setCurrentSectionId(visible.target.id);
        }
      },
      { rootMargin: "-30% 0px -55% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [profileLoaded, sectionNavEarly]);

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
          const [taxonomyResult, sellerProfileResult] = await Promise.all([
            fetchServiceOfferingTaxonomy(),
            // Phase 2 #85 visual reconciliation (Finding 3): the
            // header "Profile identity" chip surfaces the seller's
            // Professional Profile `identity.professionalName`.
            // The fetch is best-effort — a missing profile is a
            // normal pre-onboarding state and must not block the
            // editor. Fetched in BOTH the "new" and the existing-
            // offering paths so the chip is populated on first
            // open and on resume.
            fetchSellerProfile({ workspaceId: actingWorkspace.workspaceId })
              .then((r) => r.profile)
              .catch(() => null),
          ]);
          if (cancelled.current) return;
          setTaxonomy(taxonomyResult);
          setSellerProfile(sellerProfileResult);
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
        const [taxonomyResult, offeringResult, samplesResult, sellerProfileResult] =
          await Promise.all([
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
            // Phase 2 #85 visual reconciliation (Finding 3): the
            // header "Profile identity" chip surfaces the seller's
            // Professional Profile `identity.professionalName`. The
            // fetch is best-effort — a missing profile is a normal
            // pre-onboarding state and must not block the editor.
            fetchSellerProfile({
              workspaceId: actingWorkspace.workspaceId,
            })
              .then((r) => r.profile)
              .catch(() => null),
          ]);
        if (cancelled) return;
        setTaxonomy(taxonomyResult);
        setSellerProfile(sellerProfileResult);
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
          // Phase 2 #85 Manual QA Round 3 — save-status fidelity:
          // capture the baseline from the freshly-fetched
          // ServiceOffering row so the resume path renders
          // "Draft saved" (not "Draft not saved yet"). The
          // snapshot is built from the API response, not from
          // form state, to avoid reading stale closures before
          // the setState batch above has flushed.
          setDraftBaseline(snapshotFromOffering(o));
        } else {
          // Existing path but the API returned no row (shouldn't
          // happen for a valid owner; defend anyway): treat as
          // never-persisted so the status reads honestly.
          setDraftBaseline(null);
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
    // Phase 2 #85 Manual QA Round 10 — faithful Draft round-trip.
    // Every field is now conditional on the seller having
    // populated it; the previous build always emitted
    // serviceMode / pricing regardless of whether the seller had
    // chosen a value. The relaxed Draft contract accepts the
    // optional shape; the STRICT activate schema still enforces
    // completeness downstream via the activation re-check.
    ...(primaryCategoryKey ? { primaryCategoryKey } : {}),
    ...(serviceMode ? { serviceMode } : {}),
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
    ...(pricingKind
      ? {
          pricing: {
            kind: pricingKind,
            ...(pricingKind !== "ContactForQuote"
              ? {
                  ...(pricingAmount
                    ? { amountMinor: Math.round(Number(pricingAmount) * 100) }
                    : {}),
                  currency: "USD",
                  // Omit the unitId when the unit is unchosen so
                  // the partial-draft schema can accept the
                  // save. The STRICT activate schema enforces the
                  // unit on activation.
                  ...(pricingUnit ? { unitId: pricingUnit } : {}),
                }
              : {}),
          },
        }
      : {}),
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
        // Phase 2 #85 Manual QA Round 3 — save-status fidelity:
        // after the first successful Save on the "new" path,
        // capture the persisted baseline so the status row no
        // longer claims "Draft not saved yet" and dirty edits
        // are detected from this point forward.
        setDraftBaseline(snapshotFromOffering(created));
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
      // Phase 2 #85 Manual QA Round 3 — save-status fidelity:
      // refresh the baseline from the API response after a
      // successful PUT so any subsequent edits are detected as
      // dirty relative to this save.
      setDraftBaseline(snapshotFromOffering(response.offering));
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
    // Phase 2 #85 Manual QA Round 10 — performActivate is gated
    // by `canActivate`, which now requires `serviceMode !== null`
    // AND `pricingKind !== null` AND `pricingAmount !== null`
    // (for Fixed / StartingAt). The non-null assertions below are
    // safe at runtime — handleActivate cannot be reached without
    // the gate — and they preserve the STRICT activate schema's
    // required-field shape (`z.enum(...)`, not `z.enum(...).optional()`).
    const payload: ServiceOfferingActivateRequestV1 = {
      title: title.trim(),
      description: description.trim(),
      primaryCategoryKey,
      serviceMode: serviceMode!,
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
        kind: pricingKind!,
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
  // Phase 2 #85 Manual QA Round 10 — faithful Draft round-trip.
  // serviceMode and pricingKind are REQUIRED for activation (the
  // activation completeness check fails without them). The previous
  // gate relied on the fabricated "Remote" / "StartingAt" defaults
  // — once the defaults are null, the gate must require explicit
  // values so the Activate button isn't enabled when activation
  // would fail downstream. The pricing sub-clause handles
  // ContactForQuote (no amount/unit required) and Fixed /
  // StartingAt (both amount > 0 and unit required).
  const canActivate =
    serviceMode !== null &&
    pricingKind !== null &&
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    primaryCategoryKey.length > 0 &&
    (!serviceAreaRequired || serviceAreaCountry.length > 0) &&
    (pricingKind === "ContactForQuote" || (Number(pricingAmount) > 0 && pricingUnit.length > 0)) &&
    liveSampleCount >= 1 &&
    offering?.status === "Draft";

  // Phase 2 visual reconciliation: derive each section's
  // readiness from the same data the Activation section consumes.
  // The sidebar / mobile jump reference the early derived
  // `sectionNavEarly` from above so the source-of-truth lives in
  // one place and respects React's rule of hooks. We still keep
  // `liveSampleCount`, `serviceAreaRequired`, and `canActivate`
  // are derived below for the activation readiness rows and the
  // gate button (their computation is identical to the `*Early`
  // versions above, but they're scoped to the post-bootstrap
  // render so future readers can find them near the JSX).
  const sectionNav = sectionNavEarly;
  // The observer + state have been declared above (BEFORE any
  // early return). We just look up the current section here for
  // the mobile-jump label and the sidebar's aria-current.
  const currentSection = sectionNav.find((s) => s.id === currentSectionId) ?? sectionNav[0]!;
  const currentSectionLabel = currentSection
    ? `Section ${currentSection.number} of ${String(sectionNav.length).padStart(2, "0")}: ${currentSection.name}`
    : "Service overview";

  return (
    <div className="min-h-screen bg-canvas">
      <MobileSectionJump currentName={currentSectionLabel} sections={sectionNav} />
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-12 py-6 sm:py-8 space-y-6">
        <Card variant="parchment" data-testid="service-offering-edit">
          <Card.Header className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <Link
                href={"/seller/services"}
                className="inline-flex items-center gap-1 font-label-md text-sm text-muted hover:text-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
                data-testid="service-offering-edit-breadcrumb-back"
              >
                <ArrowBackIcon width={18} height={18} />
                Back to Your services
              </Link>
              <span
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border font-label-md text-xs font-bold uppercase tracking-wider ${
                  offering?.status === "Active"
                    ? "bg-seaGlass/15 border-seaGlass/40 text-seaGlass"
                    : "bg-surface-container border-primary-container/30 text-primary"
                }`}
                data-testid="service-offering-edit-status"
              >
                {offering?.status === "Active" ? (
                  <CheckCircleIcon width={14} height={14} />
                ) : (
                  <LockIcon width={14} height={14} />
                )}
                {offering?.status === "Active"
                  ? "Available"
                  : offering?.status === "Draft"
                    ? "Private draft"
                    : (offering?.status ?? "Private draft")}
              </span>
            </div>
            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
              <div className="min-w-0">
                <span className="font-label-md uppercase tracking-wider text-muted">Service</span>
                <h1 className="font-serif text-3xl text-ink mt-1">
                  {/* Phase 2 #85 Manual QA Round 8 — final active
                      read-only presentation. An Active offering
                      has no persistence path for edits (the
                      repository throws ServiceOfferingNotDraftError
                      on Active), so the page must not invite
                      editing. The heading swaps from the
                      authoring-mode label to the read-only-mode
                      label using existing product terminology
                      (no Pause / Edit live / Republish /
                      Reactivate invented). Draft offerings
                      continue to render "Edit your service"
                      unchanged. */}
                  {isActive ? "Service details" : "Edit your service"}
                </h1>
                {/* Phase 2 #85 Manual QA Round 8 — small truthful
                    active-only message reinforcing that the page
                    is read-only. Uses existing product terminology
                    ("live") without inventing future-workflow
                    semantics. Draft offerings do not render this
                    message. */}
                {isActive ? (
                  <p
                    className="text-xs text-muted mt-1 max-w-2xl"
                    data-testid="service-offering-edit-read-only-notice"
                  >
                    This service is live. Editing is not available in this version.
                  </p>
                ) : null}
                {/* Phase 2 #85 Manual QA Round 5 — post-activation
                    truthfulness. The previous copy unconditionally
                    claimed the service was private and invisible to
                    buyers, which is false after a successful
                    activation. The page now branches on the
                    authoritative lifecycle state. The Draft copy
                    stays as the default so a freshly mounted editor
                    and Paused/Archived services (out of scope
                    here) do not silently change. */}
                {isActive ? (
                  <p
                    className="text-base text-muted mt-2 max-w-2xl"
                    data-testid="service-offering-edit-active-description"
                  >
                    This service is live. Buyers can now discover it in talent search and send
                    ProjectRequests.
                  </p>
                ) : (
                  <p className="text-base text-muted mt-2 max-w-2xl">
                    This service is private until you activate it. Buyers cannot see this service in
                    search or send project requests for it.
                  </p>
                )}
              </div>
              {actingWorkspace ? (
                <div
                  className="px-3 py-2 bg-surface-container-low border border-borderWarm rounded-lg flex items-center gap-2 shrink-0"
                  data-testid="service-offering-edit-profile-identity"
                >
                  <span
                    className="w-2 h-2 rounded-full bg-seaGlass animate-pulse"
                    aria-hidden="true"
                  ></span>
                  <span className="font-label-md uppercase tracking-wider text-muted text-xs">
                    Profile identity
                  </span>
                  <span
                    className="font-label-lg text-sm font-semibold text-ink truncate max-w-[220px]"
                    data-testid="service-offering-edit-profile-identity-name"
                  >
                    {sellerProfile?.identity?.professionalName?.trim() || actingWorkspace.name}
                  </span>
                  {sellerProfile?.identity?.professionalName ? (
                    <span className="sr-only">Acting Workspace: {actingWorkspace.name}</span>
                  ) : (
                    <span className="sr-only">
                      No Professional Profile yet. Showing acting Workspace.
                    </span>
                  )}
                </div>
              ) : null}
            </div>
            {/* Phase 2 #85 Manual QA Round 7 — final active-state
                truthfulness. The previous row unconditionally
                claimed the lifecycle was a Draft ("Draft saved ·
                Changes save only when you choose Save draft.")
                even after activation, where no Save draft action
                exists and the lifecycle is no longer Draft.
                The row is gated on `!isActive` so an Active
                offering renders nothing in this slot — the
                AVAILABLE status pill (top right), the active
                description (header), the persistent Service
                activated banner (section 06), and the rail's
                "Available" summary already convey the truthful
                lifecycle state using existing product
                terminology. No new terminology is introduced.
                Pause / re-activation semantics remain out of
                scope for #85. */}
            {!isActive ? (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 border-t border-borderWarm/60">
                <div
                  className="flex items-center gap-2 text-sm"
                  aria-live="polite"
                  data-testid="service-offering-edit-save-status"
                >
                  <span
                    className={
                      saveState === "saved"
                        ? "text-seaGlass"
                        : saveState === "error"
                          ? "text-coral"
                          : saveState === "saving"
                            ? "text-muted"
                            : isDirty
                              ? "text-coral"
                              : hasPersistedDraft
                                ? "text-seaGlass"
                                : "text-muted"
                    }
                    aria-hidden="true"
                  >
                    {saveState === "saved" ||
                    (saveState === "idle" && hasPersistedDraft && !isDirty) ? (
                      <CloudDoneIcon width={18} height={18} />
                    ) : saveState === "saving" ? (
                      <SyncIcon width={18} height={18} className="animate-spin" />
                    ) : saveState === "error" || (saveState === "idle" && isDirty) ? (
                      <CloudOffIcon width={18} height={18} />
                    ) : (
                      <CloudIcon width={18} height={18} />
                    )}
                  </span>
                  <span
                    className={`font-medium ${
                      saveState === "error" || (saveState === "idle" && isDirty)
                        ? "text-coral"
                        : "text-ink"
                    }`}
                  >
                    {saveState === "saving"
                      ? "Saving draft…"
                      : saveState === "error"
                        ? "Couldn't save"
                        : saveState === "saved"
                          ? "Draft saved explicitly"
                          : isDirty
                            ? "Unsaved changes"
                            : hasPersistedDraft
                              ? "Draft saved"
                              : "Draft not saved yet"}
                  </span>
                  <span className="text-muted">
                    · Changes save only when you choose Save draft.
                  </span>
                </div>
                <SaveDraftActions
                  state={saveState}
                  errorMessage={saveErrorMessage}
                  onRetry={handleRetry}
                  testIdPrefix="service-offering-edit-save"
                />
              </div>
            ) : null}
          </Card.Header>
          <Card.Content className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <DesktopSectionNav
                currentLabel={currentSectionId}
                sections={sectionNav}
                isActive={isActive}
              />
              <div className="col-span-1 lg:col-span-8 space-y-6">
                {summaryItems.length > 0 && (
                  <ErrorSummary
                    title="Please fix the following before activating:"
                    errors={summaryItems}
                    testId="service-offering-edit-error-summary"
                  />
                )}

                <SectionCard
                  id={SECTION_IDS.overview}
                  number="01 / OVERVIEW"
                  title="Service overview"
                  description="Basic information that describes your service to prospective buyers."
                  testId="service-offering-edit-section-overview"
                >
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
                        fieldErrorById.get(FIELD_IDS.title)
                          ? fieldErrorId(FIELD_IDS.title)
                          : undefined
                      }
                      // Phase 2 #85 Manual QA Round 8 — final active
                      // read-only presentation. The native
                      // `disabled` attribute is the standard HTML
                      // semantic for read-only controls; the
                      // browser styles it consistently, screen
                      // readers announce it, and form-submission
                      // pipelines skip it. No event-handler-only
                      // stub.
                      disabled={isActive}
                      className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base aria-[invalid=true]:border-coral disabled:opacity-60 disabled:cursor-not-allowed"
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
                      // Phase 2 #85 Manual QA Round 8 — final active
                      // read-only presentation.
                      disabled={isActive}
                      className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base aria-[invalid=true]:border-coral disabled:opacity-60 disabled:cursor-not-allowed"
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
                      // Phase 2 #85 Manual QA Round 8 — final active
                      // read-only presentation.
                      disabled={isActive}
                      className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
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
                </SectionCard>

                <SectionCard
                  id={SECTION_IDS.delivery}
                  number="02 / DELIVERY"
                  title="Delivery"
                  description="How and where you collaborate with buyers."
                  testId="service-offering-edit-section-delivery"
                >
                  <fieldset>
                    <legend className="font-label-lg text-sm font-semibold text-ink mb-2">
                      Delivery mode <span aria-hidden="true">*</span>
                    </legend>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {(["Remote", "InPerson", "Hybrid"] as const).map((m) => (
                        <label
                          key={m}
                          className={`flex flex-col p-3 rounded-lg border cursor-pointer transition-colors ${
                            serviceMode === m
                              ? "border-aubergine bg-surface shadow-sm"
                              : "border-surface-variant bg-surface-container-lowest hover:border-muted"
                          }`}
                        >
                          <span className="flex items-center justify-between mb-1.5">
                            {m === "Remote" ? (
                              <WifiIcon width={20} height={20} aria-hidden="true" />
                            ) : m === "InPerson" ? (
                              <DomainIcon width={20} height={20} aria-hidden="true" />
                            ) : (
                              <SyncAltIcon width={20} height={20} aria-hidden="true" />
                            )}
                            <input
                              type="radio"
                              name="serviceMode"
                              value={m}
                              checked={serviceMode === m}
                              onChange={() => setServiceMode(m)}
                              // Phase 2 #85 Manual QA Round 8 — final active
                              // read-only presentation.
                              disabled={isActive}
                              className="accent-aubergine w-4 h-4 disabled:opacity-60 disabled:cursor-not-allowed"
                              data-testid={`service-offering-edit-mode-${m}`}
                            />
                          </span>
                          <span className="font-medium text-ink text-base">
                            {SERVICE_MODE_LABEL[m]}
                          </span>
                          <span className="text-xs text-muted mt-1">
                            {m === "Remote"
                              ? "Work entirely online via file transfers and calls."
                              : m === "InPerson"
                                ? "Meet at an agreed studio or client location."
                                : "Combination of in-person sessions and remote collaboration."}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {(serviceMode === "InPerson" || serviceMode === "Hybrid") && (
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor={FIELD_IDS.serviceAreaCountry}
                        className="text-sm font-medium text-ink"
                      >
                        Coarse service area <span aria-hidden="true">*</span>
                      </label>
                      <p className="text-xs text-muted">
                        Required for {SERVICE_MODE_LABEL.InPerson} / {SERVICE_MODE_LABEL.Hybrid}.
                        Pick the country or territory where you typically deliver; the talent search
                        uses this without exposing a precise address.
                      </p>
                      <select
                        id={FIELD_IDS.serviceAreaCountry}
                        value={serviceAreaCountry}
                        onChange={(e) => setServiceAreaCountry(e.target.value)}
                        // Phase 2 #85 Manual QA Round 8 — final active
                        // read-only presentation.
                        disabled={isActive}
                        className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
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
                </SectionCard>

                <SectionCard
                  id={SECTION_IDS.pricing}
                  number="03 / PRICING"
                  title="Pricing"
                  description="Transparent rate guidance for your service. Pricing is non-binding until agreed in project terms."
                  testId="service-offering-edit-section-pricing"
                >
                  <fieldset>
                    <legend className="font-label-lg text-sm font-semibold text-ink mb-2">
                      Pricing model <span aria-hidden="true">*</span>
                    </legend>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {(["Fixed", "StartingAt", "ContactForQuote"] as const).map((k) => (
                        <label
                          key={k}
                          className={`flex flex-col p-3 rounded-lg border cursor-pointer transition-colors ${
                            pricingKind === k
                              ? "border-aubergine bg-surface shadow-sm"
                              : "border-surface-variant bg-surface-container-lowest hover:border-muted"
                          }`}
                        >
                          <span className="flex items-center justify-between mb-1">
                            <span className="font-medium text-ink text-base">
                              {PRICING_KIND_LABEL[k]}
                            </span>
                            {pricingKind === k ? (
                              <CheckCircleIcon className="text-seaGlass" width={18} height={18} />
                            ) : null}
                          </span>
                          <input
                            type="radio"
                            name="pricingKind"
                            value={k}
                            checked={pricingKind === k}
                            onChange={() => setPricingKind(k)}
                            // Phase 2 #85 Manual QA Round 8 — final active
                            // read-only presentation. The radio
                            // itself stays `sr-only` (it is the
                            // visual card that receives the
                            // pointer); disabling the underlying
                            // input makes the whole card
                            // non-interactive.
                            disabled={isActive}
                            className="sr-only"
                            data-testid={`service-offering-edit-pricing-${k}`}
                          />
                          <span className="text-xs text-muted">
                            {k === "Fixed"
                              ? "Single set price for defined scope."
                              : k === "StartingAt"
                                ? "Base rate adjusting with scope complexity."
                                : "Discuss custom scope before proposing terms."}
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {pricingKind !== "ContactForQuote" && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 rounded-xl bg-surface border border-borderWarm">
                      <div className="flex flex-col gap-1">
                        <label
                          htmlFor={FIELD_IDS.pricingAmount}
                          className="text-sm font-medium text-ink"
                        >
                          Base amount (USD)
                        </label>
                        <div className="relative flex items-center">
                          <span
                            className="absolute left-3 text-muted font-semibold pointer-events-none"
                            aria-hidden="true"
                          >
                            $
                          </span>
                          <input
                            id={FIELD_IDS.pricingAmount}
                            type="number"
                            min={1}
                            value={pricingAmount ?? ""}
                            onChange={(e) => setPricingAmount(e.target.value)}
                            // Phase 2 #85 Manual QA Round 8 — final active
                            // read-only presentation.
                            disabled={isActive}
                            className="w-full pl-7 pr-3 py-2 bg-surface-container-lowest text-ink rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
                            data-testid="service-offering-edit-input-amount"
                          />
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <label
                          htmlFor={FIELD_IDS.pricingUnit}
                          className="text-sm font-medium text-ink"
                        >
                          Pricing unit
                        </label>
                        <select
                          id={FIELD_IDS.pricingUnit}
                          value={pricingUnit}
                          onChange={(e) => setPricingUnit(e.target.value)}
                          // Phase 2 #85 Manual QA Round 8 — final active
                          // read-only presentation.
                          disabled={isActive}
                          className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
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
                      <p className="sm:col-span-2 flex items-center gap-1.5 text-xs text-muted">
                        <InfoIcon width={14} height={14} aria-hidden="true" />
                        Service pricing is non-binding until agreed in project terms.
                      </p>
                    </div>
                  )}
                </SectionCard>

                <SectionCard
                  id={SECTION_IDS.samples}
                  number="04 / WORK SAMPLES"
                  title="Audio work samples"
                  description="Help buyers hear your sound. Up to 3 MP3 samples; each upload requires you to confirm the right to share."
                  testId="service-offering-edit-section-samples"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <p className="text-sm text-muted">
                      Private samples play for you here; buyers only hear what you attach when the
                      service is Active.
                    </p>
                    <div className="flex items-center gap-2">
                      <span
                        className="font-label-md uppercase tracking-wider text-xs font-bold text-ink"
                        data-testid="service-offering-edit-samples-count"
                      >
                        {liveSampleCount} of 3 samples attached
                      </span>
                      <div className="w-24 h-1.5 rounded-full bg-surface-container overflow-hidden">
                        <div
                          className="h-full bg-seaGlass transition-all"
                          style={{ width: `${(liveSampleCount / 3) * 100}%` }}
                          aria-hidden="true"
                        ></div>
                      </div>
                    </div>
                  </div>
                  <ul className="space-y-3" data-testid="service-offering-edit-samples-list">
                    {samples.map((sample) => (
                      <li
                        key={sample.sampleId}
                        className="flex flex-col gap-2 p-3 border border-borderWarm rounded-lg bg-surface-container-lowest"
                        data-testid="service-offering-edit-sample-row"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary-container/15 border border-primary-container/30 text-primary text-[10px] font-bold uppercase tracking-wider"
                              aria-hidden="true"
                            >
                              <LockIcon width={12} height={12} />
                              Private
                            </span>
                            <p
                              className="text-sm font-medium text-ink truncate"
                              data-testid="service-offering-edit-sample-label"
                            >
                              {sample.label}
                            </p>
                            <p className="text-xs text-muted shrink-0">
                              #{(sample.displayOrder ?? 0) + 1} ·{" "}
                              {(sample.byteSize / 1024).toFixed(1)} KB
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              void handleRemoveSample(sample);
                            }}
                            // Phase 2 #85 Manual QA Round 8 — final active
                            // read-only presentation. The sample
                            // Remove control is disabled for Active
                            // offerings because (a) there is no
                            // API path to persist a remove on an
                            // Active offering — the repository
                            // throws ServiceOfferingNotDraftError —
                            // and (b) the post-activation audio-
                            // removal flow has its own eligibility
                            // transition (Draft → Paused on the
                            // final-sample remove) that is explicitly
                            // out of scope for #85. Existing private
                            // sample playback stays available.
                            disabled={isActive || removeConfirmId === sample.sampleId}
                            className="text-coral hover:bg-coral/10 font-label-md text-xs font-bold uppercase tracking-wider px-2 py-1 rounded transition-colors min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed"
                            data-testid="service-offering-edit-sample-remove"
                          >
                            {removeConfirmId === sample.sampleId ? "Removing…" : "Remove"}
                          </button>
                        </div>
                        <audio
                          controls
                          preload="none"
                          // M2 (#85) Manual QA Round 4 — private audio
                          // playback. `crossOrigin="use-credentials"` is
                          // the React-camelCase form of the HTML
                          // `crossorigin="use-credentials"` attribute. It
                          // is REQUIRED so the HttpOnly session cookie
                          // rides on the cross-origin media fetch and
                          // the owner-side `/play` route authenticates
                          // the request; without it the route returns
                          // SESSION_INVALID and the browser surfaces
                          // `NotSupportedError`. With `use-credentials`,
                          // the response MUST also satisfy CORS with
                          // credentials, which the global CORS config
                          // already does (origin = FRONTEND_URL,
                          // credentials = true).
                          crossOrigin="use-credentials"
                          src={sample.playbackUrl}
                          className="w-full"
                          aria-label={`${sample.label} private sample player`}
                          data-testid="service-offering-edit-sample-player"
                          onError={() => {
                            // Set in place of the native `<audio>`
                            // failure default so the editor never
                            // surfaces an uncaught runtime error or a
                            // Next.js dev overlay on Play. The element
                            // stays mounted for keyboard/screen-reader
                            // users (controls are still tabbable) but
                            // the inline error message below is the
                            // authoritative affordance.
                            markSamplePlaybackFailure(sample.sampleId);
                          }}
                        >
                          Your browser does not support inline audio playback.
                        </audio>
                        {playbackFailureIds.includes(sample.sampleId) ? (
                          <p
                            role="alert"
                            className="text-xs text-coral"
                            data-testid="service-offering-edit-sample-player-error"
                          >
                            Couldn't load this sample. Refresh the page; if it still fails, sign in
                            again from the same browser.
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {/* Phase 2 #85 Manual QA Round 8 — final active
                      read-only presentation. The sample upload
                      form (label input, file input,
                      media-confirmation checkbox, submit button)
                      is absent for Active offerings because there
                      is no API path to persist a new sample on
                      an Active offering. Existing private sample
                      playback stays available above; the
                      sample-removal affordance is disabled.
                      Post-activation audio-removal /
                      eligibility-transition behavior is
                      explicitly out of scope for #85. */}
                  {!isActive && samples.length < 3 && (
                    <form
                      className="space-y-3 p-4 border border-dashed border-borderWarm rounded-xl bg-surface"
                      onSubmit={(e) => {
                        void handleUploadSample(e);
                      }}
                      data-testid="service-offering-edit-sample-upload-form"
                    >
                      <p className="font-label-lg text-sm font-semibold text-ink">
                        Upload another sample ({3 - samples.length} remaining)
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
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
                        </div>
                        <div className="flex flex-col gap-1">
                          <label
                            className="text-sm font-medium text-ink"
                            htmlFor="service-offering-edit-sample-file-input"
                          >
                            Choose MP3 (max 25 MB)
                          </label>
                          <input
                            type="file"
                            name="file"
                            id="service-offering-edit-sample-file-input"
                            accept="audio/mpeg"
                            required
                            className="w-full text-sm file:bg-surface-container-high file:border-0 file:rounded file:px-3 file:py-2 file:text-ink file:font-medium file:cursor-pointer"
                            data-testid="service-offering-edit-sample-file-input"
                          />
                        </div>
                      </div>
                      <div className="pt-2 border-t border-borderWarm space-y-1">
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            required
                            checked={sampleConfirmed}
                            onChange={(e) => setSampleConfirmed(e.target.checked)}
                            className="mt-1 w-4 h-4 accent-aubergine"
                            data-testid="service-offering-edit-sample-confirmation"
                          />
                          <span>
                            I confirm I have the right to share this audio sample as a SoundHub
                            preview.
                          </span>
                        </label>
                        <p className="text-xs text-muted pl-6">
                          Uploading a work sample does not verify or transfer copyright ownership.
                        </p>
                      </div>
                      <button
                        type="submit"
                        disabled={uploading}
                        className="bg-aubergine text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-aubergine-hover disabled:opacity-50 transition-colors min-h-[44px]"
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
                </SectionCard>

                <SectionCard
                  id={SECTION_IDS.optional}
                  number="05 / OPTIONAL DETAILS"
                  title="Optional details"
                  description="Add context to help buyers understand your service. Not required for activation."
                  testId="service-offering-edit-section-optional"
                >
                  <div className="flex flex-col gap-1.5">
                    <label className="font-label-lg text-sm font-semibold text-ink">
                      Genre affinity tags
                    </label>
                    <p className="text-xs text-muted">
                      Comma-separated tags persisted with the draft. Buyers filter by these in
                      talent search.
                    </p>
                    <input
                      type="text"
                      value={genreTags.join(", ")}
                      onChange={(e) => {
                        const next = e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter((s) => s.length > 0);
                        setGenreTags(next.slice(0, 16));
                      }}
                      placeholder="e.g. Dancehall, Soca, Hip-hop"
                      // Phase 2 #85 Manual QA Round 8 — final active
                      // read-only presentation.
                      disabled={isActive}
                      className="w-full bg-surface-container-lowest text-ink px-3 py-2 rounded-md border border-surface-variant focus:outline-none focus:border-aubergine text-base disabled:opacity-60 disabled:cursor-not-allowed"
                      data-testid="service-offering-edit-input-genre-tags"
                    />
                    {genreTags.length > 0 ? (
                      <ul className="flex flex-wrap gap-1.5 mt-1" aria-label="Current genre tags">
                        {genreTags.map((tag) => (
                          <li
                            key={tag}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-primary-container/15 border border-primary-container/30 text-primary text-xs font-semibold"
                          >
                            {tag}
                            <button
                              type="button"
                              onClick={() => setGenreTags(genreTags.filter((t) => t !== tag))}
                              // Phase 2 #85 Manual QA Round 8 — final active
                              // read-only presentation.
                              disabled={isActive}
                              className="hover:text-coral rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine disabled:opacity-50 disabled:cursor-not-allowed"
                              aria-label={`Remove genre tag ${tag}`}
                              data-testid={`service-offering-edit-remove-genre-${tag}`}
                            >
                              <CloseIcon width={12} height={12} aria-hidden="true" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </SectionCard>

                <SectionCard
                  id={SECTION_IDS.activation}
                  number="06 / ACTIVATION"
                  title={isActive ? "Activation" : "Activation readiness"}
                  description={
                    isActive
                      ? "This service is live. It is discoverable in talent search and accepts ProjectRequests."
                      : "Review all requirements before activating this service for prospective buyers."
                  }
                  testId="service-offering-edit-section-activation"
                >
                  {/* Phase 2 #85 Manual QA Round 5 — post-activation
                      truthfulness. For an `Active` offering the
                      Draft-readiness banner ("Ready to activate" /
                      "Not yet ready to activate") is conceptually
                      undefined: the requirements have already been
                      satisfied and acted on. The readiness banner is
                      suppressed in favor of a persistent
                      "Service activated" alert sourced from the
                      persisted `offering.activatedAt` field so the
                      page is truthful across reloads (the
                      transient `showActivateSummary` only fires
                      during the same browser session). */}
                  {isActive ? (
                    <Alert
                      role="status"
                      variant="recovery"
                      title="Service activated"
                      data-testid="service-offering-edit-active-banner"
                    >
                      {offering?.activatedAt
                        ? `Activated at ${offering.activatedAt}.`
                        : "This service is live and accepting ProjectRequests."}
                    </Alert>
                  ) : (
                    <div
                      className={`flex items-center gap-3 p-3 rounded-lg ${
                        canActivate
                          ? "bg-seaGlass/10 border border-seaGlass/40"
                          : "bg-surface-container-low border border-borderWarm"
                      }`}
                      data-testid="service-offering-edit-readiness-banner"
                    >
                      {canActivate ? (
                        <VerifiedIcon
                          className={canActivate ? "text-seaGlass" : "text-muted"}
                          width={24}
                          height={24}
                        />
                      ) : (
                        <RadioUncheckedIcon
                          className={canActivate ? "text-seaGlass" : "text-muted"}
                          width={24}
                          height={24}
                        />
                      )}
                      <div>
                        <p className="font-label-lg text-sm font-semibold text-ink">
                          {canActivate ? "Ready to activate" : "Not yet ready to activate"}
                        </p>
                        <p className="text-xs text-muted">
                          {canActivate
                            ? "All required fields completed. Activation makes this service visible in search and ProjectRequests."
                            : "Complete the pending items below. Save draft preserves progress without activating."}
                        </p>
                      </div>
                    </div>
                  )}
                  {!isActive ? (
                    <ul className="space-y-2">
                      <ReadinessRow
                        ready={title.trim().length > 0 && description.trim().length > 0}
                        title="Title and description entered"
                        meta={
                          title.trim().length > 0
                            ? `${title} · ${description.trim().length} chars`
                            : "Title and description are required."
                        }
                      />
                      <ReadinessRow
                        ready={primaryCategoryKey.length > 0}
                        title="Primary category selected"
                        meta={
                          primaryCategoryKey.length > 0 ? primaryCategoryKey : "Pick a category."
                        }
                      />
                      <ReadinessRow
                        ready={
                          !!serviceMode && (!serviceAreaRequired || serviceAreaCountry.length > 0)
                        }
                        title="Delivery mode defined"
                        meta={
                          serviceMode
                            ? `${SERVICE_MODE_LABEL[serviceMode]}${
                                serviceAreaRequired
                                  ? ` · ${serviceAreaCountry || "service area pending"}`
                                  : ""
                              }`
                            : "Pick a delivery mode."
                        }
                      />
                      <ReadinessRow
                        ready={
                          pricingKind === "ContactForQuote" ||
                          (Number(pricingAmount) > 0 && pricingUnit.length > 0)
                        }
                        title="Pricing configured"
                        meta={
                          pricingKind === "ContactForQuote"
                            ? "Contact for quote"
                            : pricingKind
                              ? `${PRICING_KIND_LABEL[pricingKind]} · $${pricingAmount || "0"} ${pricingUnit || "unit pending"}`
                              : "Pick a pricing model."
                        }
                      />
                      <ReadinessRow
                        ready={liveSampleCount >= 1}
                        title={`Audio sample ${liveSampleCount >= 1 ? "uploaded" : "required"}`}
                        meta={
                          liveSampleCount >= 1
                            ? `${liveSampleCount} playable sample${liveSampleCount === 1 ? "" : "s"} attached`
                            : "At least one playable MP3 is required for activation."
                        }
                      />
                    </ul>
                  ) : null}
                  {/* Phase 2 #85 Manual QA Round 5 — post-activation
                      truthfulness. The "terms non-binding" copy, the
                      transient "Service activated" alert, and the
                      activate-error alert are all Draft-time
                      affordances. For an `Active` offering the
                      persistent Service-activated banner above is the
                      source of truth. */}
                  {!isActive ? (
                    <>
                      <p className="text-xs text-muted">
                        Service terms and pricing are non-binding until incorporated into an
                        approved TermsVersion.
                      </p>
                      {showActivateSummary && activationEvidence ? (
                        <Alert
                          role="status"
                          variant="recovery"
                          title="Service activated"
                          data-testid="service-offering-edit-activated-alert"
                        >
                          Activated at {activationEvidence.activatedAt}.
                        </Alert>
                      ) : null}
                      {activateState === "error" && activateErrorMessage ? (
                        <Alert
                          role="alert"
                          variant="failure"
                          title="Couldn't activate"
                          data-testid="service-offering-edit-activate-error"
                        >
                          {activateErrorMessage}
                        </Alert>
                      ) : null}
                    </>
                  ) : null}
                </SectionCard>

                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-4 border-t border-borderWarm">
                  {/* Phase 2 #85 Manual QA Round 6 — final post-
                      activation copy cleanup. The previous helper
                      unconditionally described activation as a
                      future action ("Save draft preserves
                      progress; Activate service makes this
                      service visible to buyers"), which is false
                      on an Active offering (and would imply
                      activation is still pending when the rail
                      already says "Available"). The fix branches
                      on `!isActive` so the Active branch renders
                      truthful existing-terminology copy ("This
                      service is live and accepting
                      ProjectRequests") and the Draft branch keeps
                      the Save / Activate helper. Pause /
                      re-activation behavior is NOT invented —
                      the Active branch simply restates the
                      already-persisted lifecycle. */}
                  {!isActive ? (
                    <p className="text-sm text-muted">
                      Save draft preserves progress; Activate service makes this service visible to
                      buyers.
                    </p>
                  ) : (
                    <p className="text-sm text-muted">
                      This service is live and accepting ProjectRequests.
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 justify-end">
                    {offering?.status !== "Active" ? (
                      <>
                        <button
                          type="button"
                          onClick={handleSave}
                          disabled={saveState === "saving"}
                          className="inline-flex items-center gap-2 justify-center min-h-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine disabled:opacity-50"
                          data-testid="service-offering-edit-save-draft"
                        >
                          <SaveIcon width={18} height={18} aria-hidden="true" />
                          Save draft
                        </button>
                        <button
                          type="button"
                          onClick={() => setActivateConfirmOpen(true)}
                          disabled={
                            !canActivate || activateState === "saving" || saveState === "saving"
                          }
                          className="inline-flex items-center gap-2 justify-center min-h-[44px] py-3 px-6 text-base font-medium text-white bg-coral hover:opacity-90 rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral disabled:opacity-50"
                          data-testid="service-offering-edit-activate"
                        >
                          Activate service
                          <ArrowForwardIcon width={18} height={18} aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <Link
                        href={"/seller/services"}
                        className="inline-flex items-center justify-center min-h-[44px] py-3 px-4 text-sm font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                        data-testid="service-offering-edit-back"
                      >
                        Back to Your services
                      </Link>
                    )}
                  </div>
                </div>
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
