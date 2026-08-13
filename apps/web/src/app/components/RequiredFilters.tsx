"use client";

// The structured required filters component. Each filter is a controlled
// input wired to the parent's `RequiredFiltersValue` shape. The component
// is intentionally dumb: it surfaces the canonical list of categories
// (from the v1 metadata) and the closed service-mode enum, and it
// emits change events upward so the page owns the state.
//
// The `fieldErrors` prop is an array of `ApiFieldErrorV1` objects
// returned by the safe error envelope. Each error names a JSON path
// (for example `required.basedIn.countryCode`); the component renders
// the error message beside the matching control. Errors that name a
// path that is not part of this form (for example
// `required.independentlyPurchasableServiceKeys.0` when there is no
// per-element UI, or `query`/`preferred.*`) are forwarded to the parent
// via the `onUnmatchedErrors` callback so the SearchPage can render
// them in a global error panel without losing any issue.

import { useMemo } from "react";
import type { ApiFieldErrorV1, ServiceModeV1 } from "@soundhub/types";

export interface RequiredFiltersValue {
  readonly primaryCategoryKey: string;
  readonly customPrimaryCategoryKey: string;
  readonly independentlyPurchasableServiceKey: string;
  readonly serviceModes: readonly ServiceModeV1[];
  readonly basedInCountryCode: string;
  readonly serviceAreaCountryCode: string;
}

export interface CategoryOption {
  readonly key: string;
  readonly name: string;
}

export interface RequiredFiltersProps {
  readonly value: RequiredFiltersValue;
  readonly onChange: (next: RequiredFiltersValue) => void;
  readonly fieldErrors: readonly ApiFieldErrorV1[];
  readonly onUnmatchedErrors?: (unmatched: readonly ApiFieldErrorV1[]) => void;
  readonly categories: readonly CategoryOption[];
  readonly disabled?: boolean;
}

// Path prefixes that this component owns. Field errors whose `path`
// matches one of these prefixes are rendered beside the relevant
// control. Anything else is forwarded to the parent.
const CONTROLLED_PATHS = [
  "required.primaryCategoryKeys",
  "required.independentlyPurchasableServiceKeys",
  "required.serviceModes",
  "required.basedIn",
  "required.serviceArea",
  "required",
] as const;

function isControlledPath(path: string): boolean {
  return CONTROLLED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}.`));
}

function errorsFor(pathPrefix: string, errors: readonly ApiFieldErrorV1[]): ApiFieldErrorV1[] {
  return errors.filter((err) => err.path === pathPrefix || err.path.startsWith(`${pathPrefix}.`));
}

export function RequiredFilters({
  value,
  onChange,
  fieldErrors,
  onUnmatchedErrors,
  categories,
  disabled,
}: RequiredFiltersProps) {
  // Field errors that target a path the component renders get
  // distributed below; anything else is reported upward so the page
  // can render a global panel without losing any issue.
  const { visibleErrors, unmatchedErrors } = useMemo(() => {
    const visible: ApiFieldErrorV1[] = [];
    const unmatched: ApiFieldErrorV1[] = [];
    for (const err of fieldErrors) {
      if (isControlledPath(err.path)) visible.push(err);
      else unmatched.push(err);
    }
    return { visibleErrors: visible, unmatchedErrors: unmatched };
  }, [fieldErrors]);

  // Notify the parent of unmatched errors so it can render them in a
  // global panel. The notification is a useMemo side effect, not a
  // per-render side effect, so the parent is not re-rendered on
  // unrelated state changes.
  useMemo(() => {
    if (onUnmatchedErrors) onUnmatchedErrors(unmatchedErrors);
    return null;
  }, [onUnmatchedErrors, unmatchedErrors]);

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
          disabled={disabled}
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
          Or enter a category key not in the list (for testing unknown keys).
        </p>
        <input
          data-testid="required-category-custom"
          value={value.customPrimaryCategoryKey}
          onChange={(e) => update("customPrimaryCategoryKey", e.target.value)}
          disabled={disabled}
          placeholder="e.g. non-existent-category"
          className="mt-2 w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
        />
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
          disabled={disabled}
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
