/* eslint-disable @typescript-eslint/no-floating-promises */
// Navigation source-contract tests.
//
// Background: the manual acceptance test on
// feat/bg4-persists-projects surfaced three findings:
//
//   1. The header overflowed the viewport at ~375px width.
//   2. The Audio-samples navigation entry was visible to
//      unauthenticated visitors.
//   3. The seller inbox rows prominently exposed raw internal ids
//      instead of human-readable context (covered by
//      `seller-requests/page.test.tsx`).
//
// The first two findings live in this file. The navigation
// component is a client component, so these are source-contract
// tests that pin the structure (data-testids, capability gating,
// responsive classes) without booting React. The runtime contract
// for the auth-aware gating is covered by `SessionProvider.test.tsx`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}web`;

function readNavigation(): string {
  return readFileSync(`${repoRoot}/src/app/components/Navigation.tsx`, "utf8");
}

describe("BG4 navigation: Audio samples capability gating", () => {
  test("Audio samples link is wired through a capability-gated helper, NOT a plain Link", () => {
    const source = readNavigation();
    // The Audio samples entry must mirror the Matchmaker and
    // Seller-requests pattern: a SessionAware* helper that hides
    // the link for unauthenticated visitors and for users whose
    // workspaces do not carry the Seller capability. A plain
    // <Link href="/dashboard/audio"> with no gating would leak the
    // link to every signed-out visitor.
    assert.match(
      source,
      /function SessionAwareAudioSamplesLink/,
      "navigation MUST define a SessionAwareAudioSamplesLink helper so the Audio samples entry is capability-gated",
    );
    assert.match(
      source,
      /data-testid="nav-audio-samples"/,
      "Audio samples link MUST keep the existing data-testid for the search-page embedding",
    );
    // And the link itself must be emitted from inside the
    // SessionAwareAudioSamplesLink helper, NOT as a top-level
    // <Link> next to the SessionStatus.
    const sessionAwareHelper = source.match(
      /function SessionAwareAudioSamplesLink[\s\S]*?\n\}/,
    );
    assert.ok(
      sessionAwareHelper,
      "SessionAwareAudioSamplesLink helper body must be present",
    );
    assert.match(
      sessionAwareHelper[0],
      /href="\/dashboard\/audio"/,
      "Audio samples link MUST be rendered from inside the capability-gated helper",
    );
    assert.match(
      sessionAwareHelper[0],
      /capabilities\.includes\("Seller"\)/,
      "SessionAwareAudioSamplesLink MUST gate on the Seller capability",
    );
  });

  test("Audio samples helper returns null for unauthenticated visitors and for non-Seller Workspaces", () => {
    const source = readNavigation();
    const sessionAwareHelper = source.match(
      /function SessionAwareAudioSamplesLink[\s\S]*?\n\}/,
    );
    assert.ok(sessionAwareHelper, "SessionAwareAudioSamplesLink helper body must be present");
    // Mirrors the Matchmaker / Seller-requests pattern: if the
    // session is loading or the user is null, return null. Then
    // check workspaces.some((w) => w.capabilities.includes("Seller"))
    // and return null when false.
    assert.match(
      sessionAwareHelper[0],
      /loading\s*\|\|[\s\S]*!user/,
      "SessionAwareAudioSamplesLink MUST short-circuit to null when the session is loading or the user is unauthenticated",
    );
    assert.match(
      sessionAwareHelper[0],
      /hasSellerWorkspace/,
      "SessionAwareAudioSamplesLink MUST check for at least one Seller-capable Workspace",
    );
    assert.match(
      sessionAwareHelper[0],
      /if\s*\(!hasSellerWorkspace\)\s*return\s*null/,
      "SessionAwareAudioSamplesLink MUST return null when no Workspace carries the Seller capability",
    );
  });

  test("Mobile panel mirrors the capability gating for Audio samples (no fallback to a plain Link)", () => {
    const source = readNavigation();
    // The mobile menu must also gate the Audio samples entry.
    // A signed-out visitor at 375px must not see the link in the
    // hamburger panel either — the gating is part of the link
    // emission, not just the desktop row.
    assert.match(
      source,
      /nav-mobile-audio-samples/,
      "mobile menu MUST have a dedicated nav-mobile-audio-samples test id so the gated entry can be asserted",
    );
    const mobilePanel = source.match(/function MobileMenuPanel[\s\S]*?\n\}/);
    assert.ok(mobilePanel, "MobileMenuPanel helper must be present");
    assert.match(
      mobilePanel[0],
      /hasSellerWorkspace/,
      "MobileMenuPanel MUST also gate Audio samples on hasSellerWorkspace",
    );
  });
});

describe("BG4 navigation: responsive layout (mobile / tablet / desktop)", () => {
  test("navigation contains a desktop row and a mobile bar, both gated on Tailwind breakpoints", () => {
    const source = readNavigation();
    // The desktop row is hidden on small viewports; the mobile
    // bar is hidden on >=md. Both render the gated links so a
    // user at any width sees the same capability-aware entries.
    // The class string and the test id can appear in either order
    // on the same JSX element, so we anchor on the test id and
    // assert the breakpoint classes are present on the same line.
    assert.match(
      source,
      /hidden md:flex[^"]*"[^>]*data-testid="nav-desktop-row"/,
      "desktop row MUST carry the `hidden md:flex` classes so it is hidden below md and visible at md+",
    );
    assert.match(
      source,
      /data-testid="nav-desktop-row"/,
      "desktop row MUST keep its stable test id",
    );
    assert.match(
      source,
      /md:hidden/,
      "mobile bar / toggle MUST carry the `md:hidden` class so it is hidden at md+",
    );
    assert.match(
      source,
      /data-testid="nav-mobile-toggle"/,
      "navigation MUST render a hamburger toggle for mobile viewports",
    );
    assert.match(
      source,
      /aria-expanded=\{open\}/,
      "hamburger toggle MUST advertise its expanded state to assistive tech",
    );
    assert.match(
      source,
      /data-testid="nav-mobile-panel"/,
      "navigation MUST render the mobile panel that the toggle controls",
    );
  });

  test("navigation prevents horizontal overflow at narrow viewports (min-w-0 / truncate / overflow-x-hidden)", () => {
    const source = readNavigation();
    // The brand, mobile bar, and any inline links must opt in to
    // `min-w-0` so a long email or wrapped content cannot force
    // the row wider than the viewport. The global CSS layer also
    // applies overflow-x:hidden as a defense in depth.
    assert.match(
      source,
      /min-w-0/,
      "navigation MUST use min-w-0 on flex children so long content cannot push the row wider than the viewport",
    );
    assert.match(
      source,
      /truncate/,
      "navigation MUST use `truncate` on the brand text so an unwrapped label cannot blow up the viewport",
    );
  });

  test("SessionStatus truncates the email at narrow widths so a long address cannot push the viewport wider", () => {
    const source = readFileSync(`${repoRoot}/src/app/components/SessionStatus.tsx`, "utf8");
    assert.match(
      source,
      /hidden sm:inline/,
      "SessionStatus MUST hide the email below sm (640px) so a long address cannot push the viewport wider",
    );
    assert.match(
      source,
      /truncate max-w-/,
      "SessionStatus MUST truncate the email at sm+ widths with a bounded max-width",
    );
    assert.match(
      source,
      /whitespace-nowrap/,
      "SessionStatus MUST keep the sign-in / sign-out labels on a single line so they remain tappable at any width",
    );
  });

  test("global stylesheet prevents page-level horizontal overflow", () => {
    const source = readFileSync(`${repoRoot}/src/app/globals.css`, "utf8");
    assert.match(
      source,
      /overflow-x:\s*hidden/,
      "globals.css MUST apply overflow-x:hidden to html and body as a defense in depth",
    );
  });
});