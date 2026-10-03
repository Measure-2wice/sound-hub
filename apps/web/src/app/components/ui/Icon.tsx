import type { SVGAttributes } from "react";

type IconProps = Omit<SVGAttributes<SVGSVGElement>, "children"> & {
  readonly title?: string;
};

// Phase 2 #85 visual reconciliation: small set of inline SVG icons
// for surfaces that need a glyph alongside text. These intentionally
// avoid a third-party icon-font dependency (Material Symbols is not
// loaded by the app) and instead render pure SVG that uses the
// surrounding text color via `currentColor`.
//
// Every icon is decorative (the adjacent text already carries the
// meaning) and is rendered with `aria-hidden="true"` by callers
// through the default props. When a caller needs an accessible name
// they pass `title` and the rendered SVG includes a `<title>` for
// assistive technology.

function baseProps(props: IconProps) {
  // Common defaults; callers can override any of these via the spread.
  return {
    "aria-hidden": props.title ? undefined : true,
    focusable: "false" as const,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
    className: props.className,
  };
}

export function ArrowBackIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M4 12.5l5 5L20 6.5" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function RadioUncheckedIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function VerifiedIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M9 12.5l2.5 2.5L16 9" />
      <path d="M12 3l2.5 2.2 3.3-.4.5 3.3 2.2 2.5-2.2 2.5-.5 3.3-3.3-.4L12 18l-2.5-2.2-3.3.4-.5-3.3L3.5 10.4l2.2-2.5-.5-3.3 3.3.4z" />
    </svg>
  );
}

export function CloudDoneIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M7 18a5 5 0 1 1 .8-9.94A6 6 0 0 1 19 11a4 4 0 0 1-1 7.8" />
      <path d="M9 14.5l2.2 2.2L16 11" />
    </svg>
  );
}

export function CloudOffIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M3 3l18 18" />
      <path d="M16 16H7a5 5 0 0 1-.8-9.94" />
      <path d="M9 5.06A6 6 0 0 1 19 11a4 4 0 0 1-1 7.8" />
    </svg>
  );
}

export function CloudIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M7 18a5 5 0 1 1 .8-9.94A6 6 0 0 1 19 11a4 4 0 0 1-1 7.8z" />
    </svg>
  );
}

export function SyncIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M4 12a8 8 0 0 1 13.7-5.7L20 4" />
      <path d="M20 4v4h-4" />
      <path d="M20 12a8 8 0 0 1-13.7 5.7L4 20" />
      <path d="M4 20v-4h4" />
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 1 1 8 0v3" />
    </svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

export function ExpandMoreIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function ArrowForwardIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

export function SaveIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M5 5h11l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
      <path d="M8 5v4h7V5" />
      <path d="M8 14h8" />
    </svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function AudioFileIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M9 4v12a3 3 0 1 1-3-3" />
      <path d="M15 4h-4v8a3 3 0 1 0 3 3V8h2l2-2z" />
    </svg>
  );
}

export function PublicIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13 13 0 0 1 0 18" />
      <path d="M12 3a13 13 0 0 0 0 18" />
    </svg>
  );
}

export function WifiIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M2 9a16 16 0 0 1 20 0" />
      <path d="M5 13a11 11 0 0 1 14 0" />
      <path d="M8.5 16.5a6 6 0 0 1 7 0" />
      <circle cx="12" cy="20" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DomainIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <rect x="4" y="4" width="16" height="16" rx="1" />
      <path d="M9 4v16" />
      <path d="M15 4v16" />
      <path d="M4 9h16" />
      <path d="M4 15h16" />
    </svg>
  );
}

export function SyncAltIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M4 8h12l-3-3" />
      <path d="M20 16H8l3 3" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

export function VerifiedUserIcon(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      {props.title ? <title>{props.title}</title> : null}
      <path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" />
      <path d="M9 12l2.5 2.5L16 10" />
    </svg>
  );
}
