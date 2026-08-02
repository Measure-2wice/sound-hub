import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { IUser, Role } from "@soundhub/types";

interface AuthState {
  // State
  user: IUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  register: (email: string, password: string, role: Role, displayName: string) => Promise<void>;
  clearError: () => void;
}

function parseAuthenticatedUser(value: unknown): IUser {
  if (typeof value !== "object" || value === null || !("user" in value)) {
    throw new Error("Authentication returned an invalid response");
  }

  const user = value.user;
  if (
    typeof user !== "object" ||
    user === null ||
    !("email" in user) ||
    typeof user.email !== "string" ||
    !("displayName" in user) ||
    typeof user.displayName !== "string"
  ) {
    throw new Error("Authentication response did not include a valid user");
  }

  return user as unknown as IUser;
}

export const useAuthStore = create<AuthState>()(
  devtools(
    (set) => ({
      // Initial state
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      // Actions
      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
          });

          if (!response.ok) {
            throw new Error("Login failed");
          }

          const data: unknown = await response.json();
          const user = parseAuthenticatedUser(data);
          set({
            user,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "Login failed",
            isLoading: false,
          });
        }
      },

      logout: () => {
        set({
          user: null,
          isAuthenticated: false,
          error: null,
        });
        // Clear any stored tokens, etc.
      },

      register: async (email: string, password: string, role: Role, displayName: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await fetch("/api/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, role, displayName }),
          });

          if (!response.ok) {
            throw new Error("Registration failed");
          }

          const data: unknown = await response.json();
          const user = parseAuthenticatedUser(data);
          set({
            user,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "Registration failed",
            isLoading: false,
          });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: "auth-store", // devtools name
    },
  ),
);
