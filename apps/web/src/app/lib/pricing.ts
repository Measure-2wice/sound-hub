import type { TalentSearchResultV1 } from "@soundhub/types";

type PricingSummary = TalentSearchResultV1["bestMatchingOffering"]["pricing"];

// `docs/contracts/search-api.md` types `MoneyV1.currency` as any ISO 4217
// three-letter code and `amountMinor` as an integer count of that currency's
// minor units. The minor-unit exponent is currency-specific: USD has two
// (600000 -> 6000.00), JPY has zero (600000 -> 600000), and BHD has three
// (600000 -> 600.000). Assuming two decimals for every currency misstates
// buyer-facing amounts for the zero- and three-decimal currencies the
// contract permits, so the exponent is resolved from the currency itself.
export function minorUnitDigits(currency: string): number {
  try {
    const resolved = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions();
    return resolved.maximumFractionDigits ?? 2;
  } catch {
    // Intl rejects structurally invalid codes. The contract already
    // constrains currency to /^[A-Z]{3}$/, so this is a rendering-boundary
    // fallback rather than an expected path; two decimals is the ISO 4217
    // default exponent.
    return 2;
  }
}

// Renders "6000.00 USD" using the currency's own minor-unit exponent.
export function formatMoney(amountMinor: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  const amount = amountMinor / 10 ** digits;
  return `${amount.toFixed(digits)} ${currency}`;
}

// Returns null when the offering advertises no pricing at all. Absent pricing
// is a distinct buyer-facing presentation, not a zero amount.
export function formatPricing(pricing: PricingSummary): string | null {
  if (!pricing) return null;
  if (pricing.kind === "ContactForQuote") return "Contact for quote";
  const formatted = `${formatMoney(pricing.amount.amountMinor, pricing.amount.currency)}/${pricing.unit}`;
  return pricing.kind === "StartingAt" ? `Starting at ${formatted}` : `Fixed ${formatted}`;
}
