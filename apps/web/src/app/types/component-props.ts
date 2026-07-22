import type { ComponentProps, ReactNode } from 'react';

// Utility types for component props
export type PropsWithChildren<P = {}> = P & { children?: ReactNode };

// Extract props from HTML elements
export type ButtonProps = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
};

export type InputProps = ComponentProps<'input'> & {
  label?: string;
  error?: string;
  helperText?: string;
};

// Advanced conditional types
export type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: string };

// Generic form field type
export type FormField<T> = {
  value: T;
  error?: string;
  touched: boolean;
  isValid: boolean;
};

// Utility for making specific fields optional
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// Example: Make createdAt/updatedAt optional for form inputs
export type CreateUserInput = PartialBy<IUser, 'id' | 'createdAt' | 'updatedAt'>;

// Extract function parameters/return types
export type SearchFunction = (query: string) => Promise<IQueryResponse[]>;
export type SearchParams = Parameters<SearchFunction>[0];
export type SearchResult = Awaited<ReturnType<SearchFunction>>;

// Discriminated unions for better type safety
export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: number };

// Usage in components
export function handleApiResponse<T>(
  response: ApiResponse<T>,
  onSuccess: (data: T) => void,
  onError: (error: string) => void
) {
  if (response.success) {
    onSuccess(response.data); // TypeScript knows this exists
  } else {
    onError(response.error); // TypeScript knows this exists
  }
}