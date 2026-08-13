import { test, expect } from "@playwright/test";
import { formatMoney, formatPricing, minorUnitDigits } from "../src/app/lib/pricing";

// `docs/contracts/search-api.md` permits any ISO 4217 three-letter currency
// with an `amountMinor` count of that currency's minor units. These cases
// prove the browser formatter honors the currency's own minor-unit exponent
// instead of assuming two decimals, which previously misstated buyer-facing
// amounts for zero- and three-decimal currencies (review 5 P1-001).
//
// This spec exercises pure formatting logic and needs no page, so it runs
// without touching the API or the database.

test.describe("public pricing formatting honors ISO 4217 minor units", () => {
  test("resolves the minor-unit exponent per currency", () => {
    expect(minorUnitDigits("USD")).toBe(2);
    expect(minorUnitDigits("JPY")).toBe(0);
    expect(minorUnitDigits("BHD")).toBe(3);
    expect(minorUnitDigits("KWD")).toBe(3);
    // Well-formed but unallocated codes fall back to the ISO default of two.
    expect(minorUnitDigits("XYZ")).toBe(2);
  });

  test("formats zero-decimal currencies without inventing fractional units", () => {
    // 600000 minor units of JPY is ¥600,000, not ¥6,000.00.
    expect(formatMoney(600000, "JPY")).toBe("600000 JPY");
    expect(formatMoney(0, "JPY")).toBe("0 JPY");
  });

  test("formats three-decimal currencies at full precision", () => {
    // 600000 minor units of BHD is 600.000 BHD, not 6000.00 BHD.
    expect(formatMoney(600000, "BHD")).toBe("600.000 BHD");
    expect(formatMoney(1250, "KWD")).toBe("1.250 KWD");
  });

  test("formats two-decimal currencies unchanged", () => {
    expect(formatMoney(60000, "USD")).toBe("600.00 USD");
    expect(formatMoney(120000, "USD")).toBe("1200.00 USD");
  });

  test("labels each pricing presentation from the contract", () => {
    expect(
      formatPricing({
        kind: "StartingAt",
        amount: { amountMinor: 60000, currency: "USD" },
        unit: "track",
      }),
    ).toBe("Starting at 600.00 USD/track");
    expect(
      formatPricing({
        kind: "Fixed",
        amount: { amountMinor: 600000, currency: "JPY" },
        unit: "track",
      }),
    ).toBe("Fixed 600000 JPY/track");
    expect(
      formatPricing({
        kind: "Fixed",
        amount: { amountMinor: 600000, currency: "BHD" },
        unit: "track",
      }),
    ).toBe("Fixed 600.000 BHD/track");
    expect(formatPricing({ kind: "ContactForQuote" })).toBe("Contact for quote");
    // Absent pricing is a distinct presentation, not a zero amount.
    expect(formatPricing(undefined)).toBeNull();
  });
});
