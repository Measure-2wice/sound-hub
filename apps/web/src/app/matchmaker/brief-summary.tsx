"use client";

// Matchmaker brief summary.
//
// Background: the buyer-facing "Brief accepted" card used to render
// the persisted criteria as raw JSON. This module renders every
// supported criteria axis as labeled values or compact chips so the
// buyer never sees a JSON blob in their marketplace view. The
// Matchmaker DTO and persistence behaviour are unchanged; only the
// presentation layer changed.
//
// All display names come from one of three sources:
//   - the canonical ServiceCategory metadata fetched at mount time
//     (the same `/api/metadata/categories` seam the M1 search
//     dropdown reads);
//   - a buyer-friendly display transform applied to a machine key
//     (e.g. `music-production` -> "Music Production");
//   - the structured value the API already validated.
//
// Unknown non-search requirement keys are preserved and rendered
// with the same display transform so a future requirement field
// never silently disappears.

import type { CategoryMetadataItemV1, ProjectBriefPublicV1 } from "@soundhub/types";

// ---------- Human-readable brief summary ----------

export function BriefSummary({
  brief,
  categories,
}: {
  readonly brief: ProjectBriefPublicV1;
  readonly categories: readonly CategoryMetadataItemV1[];
}) {
  const required = brief.criteria.required;
  const preferred = brief.criteria.preferred;
  const nonSearch = brief.criteria.nonSearchRequirements;

  return (
    <dl className="grid grid-cols-1 gap-y-4 text-sm" data-testid="matchmaker-brief-summary-list">
      <div>
        <dt className="font-medium text-gray-700">Original brief</dt>
        <dd className="text-gray-900">{brief.briefText}</dd>
      </div>

      <RequiredSection required={required} categories={categories} />

      {preferred && <PreferredSection preferred={preferred} categories={categories} />}

      {brief.criteria.query && (
        <div>
          <dt className="font-medium text-gray-700">Search terms</dt>
          <dd
            className="mt-1 inline-flex items-center bg-blue-50 text-blue-800 text-xs px-2 py-1 rounded"
            data-testid="matchmaker-search-terms"
          >
            {brief.criteria.query}
          </dd>
        </div>
      )}

      {nonSearch && Object.keys(nonSearch).length > 0 && (
        <OtherRequirementsList entries={nonSearch} />
      )}

      <div>
        <dt className="font-medium text-gray-700">Provenance</dt>
        <dd>
          <span className="text-xs text-gray-700" data-testid="matchmaker-provenance">
            Interpretation method:{" "}
            <span data-testid="matchmaker-provenance-method">
              {brief.aiProvider === "managed" ? "Managed AI" : "Deterministic"}
            </span>
          </span>
        </dd>
      </div>
    </dl>
  );
}

// ---------- Required section ----------

function RequiredSection({
  required,
  categories,
}: {
  readonly required: ProjectBriefPublicV1["criteria"]["required"];
  readonly categories: readonly CategoryMetadataItemV1[];
}) {
  return (
    <div data-testid="matchmaker-criteria-required">
      <dt className="font-medium text-gray-700">Required criteria</dt>
      <dd className="mt-1 space-y-2">
        <CriteriaRow
          label="Category"
          testId="matchmaker-criteria-required-category"
          categoryNames={humaniseKeys(required.primaryCategoryKeys ?? [], categories)}
        />
        <CriteriaRow
          label="Independently purchasable service"
          testId="matchmaker-criteria-required-independent-service"
          categoryNames={humaniseKeys(
            required.independentlyPurchasableServiceKeys ?? [],
            categories,
          )}
        />
        <CriteriaRow
          label="Service mode"
          testId="matchmaker-criteria-required-service-mode"
          categoryNames={(required.serviceModes ?? []).map(humaniseValue)}
        />
        <CriteriaRow
          label="Based in"
          testId="matchmaker-criteria-required-based-in"
          categoryNames={required.basedIn ? [formatLocation(required.basedIn)] : []}
        />
        <CriteriaRow
          label="Service area"
          testId="matchmaker-criteria-required-service-area"
          categoryNames={required.serviceArea ? [formatLocation(required.serviceArea)] : []}
        />
      </dd>
    </div>
  );
}

// ---------- Preferred section ----------

function PreferredSection({
  preferred,
  categories,
}: {
  readonly preferred: NonNullable<ProjectBriefPublicV1["criteria"]["preferred"]>;
  readonly categories: readonly CategoryMetadataItemV1[];
}) {
  return (
    <div data-testid="matchmaker-criteria-preferred">
      <dt className="font-medium text-gray-700">Preferred criteria</dt>
      <dd className="mt-1 space-y-2">
        <CriteriaRow
          label="Category"
          testId="matchmaker-criteria-preferred-category"
          categoryNames={humaniseKeys(preferred.categoryKeys ?? [], categories)}
        />
        <CriteriaRow
          label="Included service"
          testId="matchmaker-criteria-preferred-included-service"
          categoryNames={humaniseKeys(preferred.includedServiceKeys ?? [], categories)}
        />
        <CriteriaRow
          label="Specialty"
          testId="matchmaker-criteria-preferred-specialty"
          categoryNames={(preferred.specialties ?? []).map(humaniseValue)}
        />
        <CriteriaRow
          label="Genre"
          testId="matchmaker-criteria-preferred-genre"
          categoryNames={(preferred.genreTags ?? []).map(humaniseValue)}
        />
        <CriteriaRow
          label="Caribbean affiliation"
          testId="matchmaker-criteria-preferred-affiliation"
          categoryNames={(preferred.caribbeanAffiliationCodes ?? []).map(humaniseValue)}
        />
        <CriteriaRow
          label="Based in"
          testId="matchmaker-criteria-preferred-based-in"
          categoryNames={preferred.basedIn ? [formatLocation(preferred.basedIn)] : []}
        />
        <CriteriaRow
          label="Service mode"
          testId="matchmaker-criteria-preferred-service-mode"
          categoryNames={(preferred.serviceModes ?? []).map(humaniseValue)}
        />
      </dd>
    </div>
  );
}

// ---------- Other requirements list ----------

function OtherRequirementsList({
  entries,
}: {
  readonly entries: Readonly<Record<string, string>>;
}) {
  const keys = Object.keys(entries);
  return (
    <div data-testid="matchmaker-other-requirements">
      <dt className="font-medium text-gray-700">Other requirements</dt>
      <dd className="mt-1">
        <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
          {keys.map((key) => (
            <li
              key={key}
              data-testid="matchmaker-other-requirement-item"
              data-other-requirement-key={key}
            >
              <span className="font-medium text-gray-900">{humaniseKey(key)}:</span>{" "}
              <span>{entries[key]}</span>
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

// ---------- Row + chip primitives ----------

function CriteriaRow({
  label,
  testId,
  categoryNames,
}: {
  readonly label: string;
  readonly testId: string;
  readonly categoryNames: readonly string[];
}) {
  if (categoryNames.length === 0) return null;
  return (
    <div>
      <span className="text-xs font-medium text-gray-600">{label}</span>
      <div className="mt-1 flex flex-wrap gap-1" data-testid={testId}>
        {categoryNames.map((name, i) => (
          <span
            key={`${testId}-${i}`}
            className="inline-flex items-center bg-blue-50 text-blue-800 text-xs px-2 py-1 rounded"
            data-testid={`${testId}-chip`}
          >
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------- Display transforms ----------
//
// All transforms are pure and presentation-only. They never touch
// the persisted criteria; they only re-shape the values the API
// already validated.

function humaniseKeys(
  keys: readonly string[],
  categories: readonly CategoryMetadataItemV1[],
): readonly string[] {
  return keys.map((key) => humaniseKey(key, categories));
}

function humaniseKey(key: string, categories?: readonly CategoryMetadataItemV1[]): string {
  // Prefer the canonical display name from the metadata fetch
  // (PostgreSQL is the source of truth). Fall back to a generic
  // Title-Case transform when the metadata is unavailable or the
  // key is unknown.
  if (categories) {
    const match = categories.find((c) => c.key === key);
    if (match) return match.name;
  }
  return humaniseValue(key);
}

function humaniseValue(value: string): string {
  // machine-key -> Title Case (music-production -> Music Production,
  // R&B -> R&B preserved). Splits on '-' / '_' / whitespace AND on
  // camelCase boundaries (a lowercase letter followed by an uppercase
  // letter), Title-Cases each part, and rejoins with a single space.
  const withSeparators = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return withSeparators
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatLocation(loc: {
  readonly city?: string | null | undefined;
  readonly region?: string | null | undefined;
  readonly countryCode?: string | null | undefined;
}): string {
  // "City, Region, Country" with empty parts omitted so the
  // buyer never sees a trailing comma. The schema's superRefine
  // requires at least one of the three to be present; this is
  // always invoked only when at least one is non-empty.
  const parts = [loc.city ?? "", loc.region ?? "", loc.countryCode ?? ""].filter(
    (p) => p.length > 0,
  );
  return parts.join(", ");
}

// Exposed for unit tests so the helpers can be exercised without a
// full React render.
export const __test__ = {
  humaniseKey,
  humaniseValue,
  formatLocation,
};
