import type { HTMLAttributes, ReactNode } from "react";

type PropsWithChildren<P = Record<string, never>> = P & { children?: ReactNode };

// Card accepts arbitrary HTML div props (including data-testid) on the root
// and on each subcomponent so the SearchPage can wire up test selectors
// without needing a separate wrapper element.
type DivAttrs = HTMLAttributes<HTMLDivElement>;

// Card accepts arbitrary HTML div props (including data-testid) on the root
// and on each subcomponent so the SearchPage can wire up test selectors
// without needing a separate wrapper element.
// M2 #82 visual-QA remediation adds the `parchment` and `recovery` variants
// per the Caribbean Studio palette tokens added to `tailwind.config.mjs`.
// The legacy `default` / `elevated` / `outlined` variants are preserved
// exactly so unrelated callers are not affected.
type CardVariant = "default" | "elevated" | "outlined" | "parchment" | "recovery";

interface CardRootProps extends DivAttrs {
  children?: ReactNode;
  variant?: CardVariant;
  className?: string;
}

function CardRoot({ children, variant = "default", className = "", ...rest }: CardRootProps) {
  const baseClasses = "rounded-lg overflow-hidden";
  const variantClasses: Record<CardVariant, string> = {
    default: "bg-white border border-gray-200",
    elevated: "bg-white shadow-lg",
    outlined: "bg-white border-2 border-gray-300",
    // Warm parchment resting surface used by #82 dashboards / login / auth pages.
    parchment: "bg-surface border border-borderWarm",
    // Restrained gold accent reserved for the contradictory-Personal-Workspace
    // RecoverySurface — paired with an inline info glyph so the cue is never
    // color alone (per the M2 UX addendum's "Color never communicates ... alone" rule).
    recovery: "bg-surface border border-gold/40",
  };
  return (
    <div {...rest} className={`${baseClasses} ${variantClasses[variant]} ${className}`}>
      {children}
    </div>
  );
}

function CardHeader({
  children,
  className = "",
  ...rest
}: PropsWithChildren<DivAttrs & { className?: string }>) {
  return (
    <div {...rest} className={`px-6 py-4 border-b border-gray-200 ${className}`}>
      {children}
    </div>
  );
}

function CardContent({
  children,
  className = "",
  ...rest
}: PropsWithChildren<DivAttrs & { className?: string }>) {
  return (
    <div {...rest} className={`px-6 py-4 ${className}`}>
      {children}
    </div>
  );
}

function CardFooter({
  children,
  className = "",
  ...rest
}: PropsWithChildren<DivAttrs & { className?: string }>) {
  return (
    <div {...rest} className={`px-6 py-4 border-t border-gray-200 bg-gray-50 ${className}`}>
      {children}
    </div>
  );
}

function CardTitle({
  children,
  className = "",
  ...rest
}: PropsWithChildren<HTMLAttributes<HTMLHeadingElement> & { className?: string }>) {
  return (
    <h3 {...rest} className={`text-lg font-semibold text-gray-900 ${className}`}>
      {children}
    </h3>
  );
}

function CardDescription({
  children,
  className = "",
  ...rest
}: PropsWithChildren<HTMLAttributes<HTMLParagraphElement> & { className?: string }>) {
  return (
    <p {...rest} className={`text-sm text-gray-600 mt-1 ${className}`}>
      {children}
    </p>
  );
}

export const Card = Object.assign(CardRoot, {
  Header: CardHeader,
  Content: CardContent,
  Footer: CardFooter,
  Title: CardTitle,
  Description: CardDescription,
});
