"use client";

// The structured required filters component. Each filter is a controlled
// input wired to the parent's `RequiredFiltersValue` shape, which lives
// in `talent-search-request-builder.ts` so the rendered controls and the
// serialised request cannot diverge. The component is intentionally dumb: it surfaces
// canonical categories (passed in by the page) and the closed service-mode
// enum, and it emits change events upward so the page owns the state.
//
// The `fieldErrors` prop is an array of `ApiFieldErrorV1` objects
// returned by the safe error envelope. Each error names a JSON path
// (for example `required.basedIn.countryCode`); the component renders
// the error message beside the matching control. The page owns the
// partition of field errors into "rendered beside a control" vs
// "rendered globally as an unmatched field error" so the global panel
// never duplicates errors that already appear next to a control.

import {
  type ApiFieldErrorV1,
  type CategoryMetadataItemV1,
  type ServiceModeV1,
} from "@soundhub/types";
import { type RequiredFiltersValue } from "../lib/talent-search-request-builder";
import { isControlledRequiredPath } from "../lib/field-error-paths";

export type { RequiredFiltersValue };

export interface RequiredFiltersProps {
  readonly value: RequiredFiltersValue;
  readonly onChange: (next: RequiredFiltersValue) => void;
  readonly fieldErrors: readonly ApiFieldErrorV1[];
  readonly categories: readonly CategoryMetadataItemV1[];
  /**
   * Whole-panel disable. Use while a search is in flight so the buyer
   * cannot mutate the request that is already being processed.
   */
  readonly disabled?: boolean;
  /**
   * Disable ONLY the controls that depend on the canonical category
   * catalog (the category and independently-purchasable-service selects).
   * Service-mode, based-in, and service-area inputs do NOT depend on the
   * catalog and must remain usable when the catalog is loading,
   * unavailable, or validly empty so buyers can still apply those strict
   * constraints. Closes the Codex P1-003 finding.
   */
  readonly categorySelectsDisabled?: boolean;
}

function errorsFor(pathPrefix: string, errors: readonly ApiFieldErrorV1[]): ApiFieldErrorV1[] {
  return errors.filter((err) => err.path === pathPrefix || err.path.startsWith(`${pathPrefix}.`));
}

export function RequiredFilters({
  value,
  onChange,
  fieldErrors,
  categories,
  disabled,
  categorySelectsDisabled,
}: RequiredFiltersProps) {
  // Errors that target a path this component renders. The
  // ownership predicate lives in `field-error-paths.ts` so the
  // panel and the page cannot disagree about which errors belong
  // here vs in the global error list.
  const visibleErrors = fieldErrors.filter((err) => isControlledRequiredPath(err.path));
  // Category-dependent selects combine the whole-panel disable (during a
  // search) with the catalog-unavailability flag. Independent controls
  // (service modes, based-in, service-area) only honour the whole-panel
  // disable — they do not depend on the catalog and must stay usable when
  // the catalog is loading, unavailable, or validly empty.
  const selectDisabled = Boolean(disabled) || Boolean(categorySelectsDisabled);

  function update<K extends keyof RequiredFiltersValue>(
    key: K,
    next: RequiredFiltersValue[K],
  ): void {
    onChange({ ...value, [key]: next });
  }

  function toggleServiceMode(mode: ServiceModeV1): void {
    const set = new Set<ServiceModeV1>(value.serviceModes);
    if (set.has(mode)) set.delete(mode);
    else set.add(mode);
    update("serviceModes", Array.from(set));
  }

  return (
    <section
      data-testid="required-filters"
      aria-label="Strict required filters"
      className="space-y-4"
    >
      <p className="text-xs text-gray-600">
        Strict filters exclude sellers that do not match. They are not preferences and are not
        relaxed on empty results.
      </p>

      {/* Section-level required errors. The shared schema can emit errors
          at the bare `required` path (for example when the whole required
          block is malformed). These are claimed by the panel here so they
          render exactly once and never silently disappear. Errors at any
          other `required.*` path fall through to the global panel. */}
      <SectionErrors errors={visibleErrors} />

      <Field
        label="Required service category"
        path="required.primaryCategoryKeys"
        testId="required-category-field"
        errors={visibleErrors}
      >
        <select
          data-testid="required-category"
          value={value.primaryCategoryKey}
          onChange={(e) => update("primaryCategoryKey", e.target.value)}
          disabled={selectDisabled}
          className="w-full px-3 py-2 border border-gray-300 rounded-md"
        >
          <option value="">Any category</option>
          {categories.map((category) => (
            <option key={category.key} value={category.key}>
              {category.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">
          Categories are fetched from the canonical SoundHub catalog. Unknown keys produce a
          field-level error.
        </p>
      </Field>

      <Field
        label="Required independently purchasable service"
        path="required.independentlyPurchasableServiceKeys"
        testId="required-independently-purchasable-service-field"
        errors={visibleErrors}
      >
        <select
          data-testid="required-independently-purchasable-service"
          value={value.independentlyPurchasableServiceKey}
          onChange={(e) => update("independentlyPurchasableServiceKey", e.target.value)}
          disabled={selectDisabled}
          className="w-full px-3 py-2 border border-gray-300 rounded-md"
        >
          <option value="">Any independently purchasable service</option>
          {categories.map((category) => (
            <option key={category.key} value={category.key}>
              {category.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Required service modes"
        path="required.serviceModes"
        testId="required-service-modes-field"
        errors={visibleErrors}
      >
        <div className="flex flex-wrap gap-4">
          {(["Remote", "InPerson", "Hybrid"] as const).map((mode) => {
            const checked = value.serviceModes.includes(mode);
            const testId =
              mode === "Remote"
                ? "required-service-mode-remote"
                : mode === "InPerson"
                  ? "required-service-mode-in-person"
                  : "required-service-mode-hybrid";
            return (
              <label key={mode} className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid={testId}
                  checked={checked}
                  onChange={() => toggleServiceMode(mode)}
                  disabled={disabled}
                />
                {mode === "InPerson" ? "In person" : mode}
              </label>
            );
          })}
        </div>
      </Field>

      <Field
        label="Required based in country"
        path="required.basedIn.countryCode"
        testId="required-based-in-country-field"
        errors={visibleErrors}
      >
        <input
          data-testid="required-based-in-country"
          value={value.basedInCountryCode}
          onChange={(e) => update("basedInCountryCode", e.target.value.toUpperCase())}
          disabled={disabled}
          placeholder="e.g. JM"
          maxLength={2}
          className="w-full px-3 py-2 border border-gray-300 rounded-md uppercase"
        />
      </Field>

      <Field
        label="Required based in region"
        path="required.basedIn.region"
        testId="required-based-in-region-field"
        errors={visibleErrors}
      >
        <input
          data-testid="required-based-in-region"
          value={value.basedInRegion}
          onChange={(e) => update("basedInRegion", e.target.value)}
          disabled={disabled}
          placeholder="e.g. NY"
          maxLength={120}
          className="w-full px-3 py-2 border border-gray-300 rounded-md"
        />
      </Field>

      <Field
        label="Required based in city"
        path="required.basedIn.city"
        testId="required-based-in-city-field"
        errors={visibleErrors}
      >
        <input
          data-testid="required-based-in-city"
          value={value.basedInCity}
          onChange={(e) => update("basedInCity", e.target.value)}
          disabled={disabled}
          placeholder="e.g. Brooklyn"
          maxLength={120}
          className="w-full px-3 py-2 border border-gray-300 rounded-md"
        />
      </Field>

      <Field
        label="Required service area country"
        path="required.serviceArea.countryCode"
        testId="required-service-area-country-field"
        errors={visibleErrors}
      >
        <input
          data-testid="required-service-area-country"
          value={value.serviceAreaCountryCode}
          onChange={(e) => update("serviceAreaCountryCode", e.target.value.toUpperCase())}
          disabled={disabled}
          placeholder="e.g. GB"
          maxLength={2}
          className="w-full px-3 py-2 border border-gray-300 rounded-md uppercase"
        />
      </Field>

      <Field
        label="Required service area region"
        path="required.serviceArea.region"
        testId="required-service-area-region-field"
        errors={visibleErrors}
      >
        <input
          data-testid="required-service-area-region"
          value={value.serviceAreaRegion}
          onChange={(e) => update("serviceAreaRegion", e.target.value)}
          disabled={disabled}
          placeholder="e.g. ON"
          maxLength={120}
          className="w-full px-3 py-2 border border-gray-300 rounded-md"
        />
      </Field>

      <Field
        label="Required service area city"
        path="required.serviceArea.city"
        testId="required-service-area-city-field"
        errors={visibleErrors}
      >
        <input
          data-testid="required-service-area-city"
          value={value.serviceAreaCity}
          onChange={(e) => update("serviceAreaCity", e.target.value)}
          disabled={disabled}
          placeholder="e.g. London"
          maxLength={120}
          className="w-full px-3 py-2 border border-gray-300 rounded-md"
        />
      </Field>
    </section>
  );
}

interface FieldProps {
  label: string;
  path: string;
  testId: string;
  errors: readonly ApiFieldErrorV1[];
  children: React.ReactNode;
}

function Field({ label, path, testId, errors, children }: FieldProps) {
  const matching = errorsFor(path, errors);
  const hasError = matching.length > 0;
  return (
    <div
      data-testid={testId}
      data-field-path={path}
      className={hasError ? "border-l-4 border-red-400 pl-3" : ""}
    >
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {matching.map((err) => (
        <div key={`${err.path}-${err.code}`} className="mt-1 text-sm text-red-700">
          <span data-testid="field-error-path" className="font-mono text-xs mr-1">
            {err.path}
          </span>
          <span data-testid="field-error-message">{err.message}</span>
        </div>
      ))}
    </div>
  );
}

// Renders errors at the section-level `required` path. The predicate in
// `field-error-paths.ts` claims only this exact path (no `required.*`
// wildcard), so anything that lands here is necessarily a section-level
// error targeting the whole required block. Other `required.*` paths are
// owned by specific Field renderers and never reach this component.
function SectionErrors({ errors }: { readonly errors: readonly ApiFieldErrorV1[] }) {
  const sectionErrors = errors.filter((err) => err.path === "required");
  if (sectionErrors.length === 0) return null;
  return (
    <div
      data-testid="required-section-errors"
      data-field-path="required"
      className="border-l-4 border-red-400 pl-3"
      role="alert"
    >
      {sectionErrors.map((err) => (
        <div key={`${err.path}-${err.code}`} className="mt-1 text-sm text-red-700">
          <span data-testid="field-error-path" className="font-mono text-xs mr-1">
            {err.path}
          </span>
          <span data-testid="field-error-message">{err.message}</span>
        </div>
      ))}
    </div>
  );
}
