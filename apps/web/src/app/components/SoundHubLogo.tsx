"use client";

// SoundHub logo (post-#83 visual-parity pass).
//
// Source of truth: the Stitch export's
// `soundhub_logo/code.html` contains the canonical SVG markup (160×40 viewBox,
// five track-line bars + "Sound"/"Hub" wordmark with Playfair Display + a
// sans-serif "Hub"). Per the visual-parity plan, we inline that exact markup
// here so the logo is rendered as React JSX (zero network round-trip, no PNG
// fallback, no asset drift) and themed via `currentColor` when callers ask
// for `mono`.
//
// Why inline instead of <img src="/brand/soundhub-logo.svg">:
//   1. No public asset to commit/serve.
//   2. The bar palette can stay synchronized with the Tailwind color tokens
//      by swapping the literal hexes for `currentColor` / a `mono` branch.
//   3. The wordmark's font-family resolves through the global Playfair Display
//      loaded via `next/font/google` in `apps/web/src/app/layout.tsx`, so the
//      mark and the body type render from the same font pipeline.
//
// Coral bar note: the Stitch export uses `#E05A47` for the coral bar. The
// `coral` Tailwind token has been darkened to `#C04A35` for WCAG AA contrast
// on white text (CTAs only). The logo is decorative — its 3:1 non-text
// contrast against the parchment canvas holds for both shades — so we keep
// the Stitch's `#E05A47` here to preserve the visual identity exactly.
// The CTA surfaces inherit the darker `#C04A35` via `bg-coral`.

import type { SVGProps } from "react";

export type SoundHubLogoSize = "sm" | "md";

export interface SoundHubLogoProps extends Omit<SVGProps<SVGSVGElement>, "color"> {
  /** Visual size. `sm` = 24px tall (compact chrome), `md` = 32px tall (headers). */
  readonly size?: SoundHubLogoSize;
  /** When true, hide the wordmark and render only the track-line mark. */
  readonly markOnly?: boolean;
  /** When true, render every bar in `currentColor` for single-tone contexts. */
  readonly mono?: boolean;
}

const SIZE_CLASS: Record<SoundHubLogoSize, string> = {
  sm: "h-6 w-auto",
  md: "h-8 w-auto",
};

// The exact SVG source from the Stitch export's `soundhub_logo/code.html`.
// Identical viewBox + geometry + wordmark; only the rendered JSX is adapted.
export function SoundHubLogo({
  size = "md",
  markOnly = false,
  mono = false,
  className,
  ...rest
}: SoundHubLogoProps) {
  const barFill = (stitchHex: string, currentColor: string): string =>
    mono ? currentColor : stitchHex;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 160 40"
      fill="none"
      role="img"
      aria-label="SoundHub"
      className={`${SIZE_CLASS[size]} ${className ?? ""}`}
      {...rest}
    >
      <g transform="translate(4, 6)">
        {/* Architectural sound-wave / track-line mark */}
        <rect
          x="0"
          y="10"
          width="3.5"
          height="8"
          rx="1.75"
          fill={barFill("#3B1E3E", "currentColor")}
        />
        <rect
          x="6.5"
          y="5"
          width="3.5"
          height="18"
          rx="1.75"
          fill={barFill("#3B1E3E", "currentColor")}
        />
        <rect
          x="13"
          y="1"
          width="3.5"
          height="26"
          rx="1.75"
          fill={barFill("#E05A47", "currentColor")}
        />
        <rect
          x="19.5"
          y="7"
          width="3.5"
          height="14"
          rx="1.75"
          fill={barFill("#5C9E94", "currentColor")}
        />
        <rect
          x="26"
          y="11"
          width="3.5"
          height="6"
          rx="1.75"
          fill={barFill("#C59B27", "currentColor")}
        />
      </g>
      {!markOnly && (
        <text
          x="42"
          y="27"
          fontFamily="'var(--font-playfair)', Georgia, serif"
          fontSize="22"
          fontWeight={700}
          fill={mono ? "currentColor" : "#19151D"}
          letterSpacing="-0.02em"
        >
          Sound
          <tspan
            fill={mono ? "currentColor" : "#3B1E3E"}
            fontFamily="'var(--font-jakarta)', system-ui, -apple-system, sans-serif"
            fontWeight={600}
            fontSize="20"
          >
            Hub
          </tspan>
        </text>
      )}
    </svg>
  );
}
