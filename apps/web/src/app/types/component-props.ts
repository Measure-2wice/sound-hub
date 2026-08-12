// Shared web component prop helpers. The M1 surface only needs a couple of
// reusable helpers; heavier generic shapes will move to @soundhub/types in a
// later milestone when components require them.

import type { ReactNode } from "react";

export type PropsWithChildren<P = Record<string, never>> = P & { children?: ReactNode };

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "outline";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
};

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
  helperText?: string;
};

export type AsyncState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: string };
