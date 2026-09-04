"use client";

import { useCallback, useState } from "react";
import {
  createEscrowResponseV1Schema,
  escrowStateResponseV1Schema,
  escrowActionResponseV1Schema,
  type CreateEscrowRequestV1,
  type CreateEscrowResponseV1,
  type EscrowActionResponseV1,
  type EscrowStateV1,
} from "@soundhub/types";

export interface UseEscrowReturn {
  currentAddress: string;
  setCurrentAddress: (address: string) => void;
  state: EscrowStateV1 | null;
  loading: boolean;
  error: string | null;
  lastAction: EscrowActionResponseV1 | null;
  lastDeployed: CreateEscrowResponseV1 | null;
  fetchState: (address?: string) => Promise<EscrowStateV1 | null>;
  createEscrow: (params: CreateEscrowRequestV1) => Promise<CreateEscrowResponseV1 | null>;
  releasePayment: (address?: string) => Promise<EscrowActionResponseV1 | null>;
  refundClient: (address?: string) => Promise<EscrowActionResponseV1 | null>;
  raiseDispute: (address?: string) => Promise<EscrowActionResponseV1 | null>;
  resetError: () => void;
}

function getErrorMessage(json: unknown, fallback: string): string {
  if (
    json &&
    typeof json === "object" &&
    "error" in json &&
    json.error &&
    typeof json.error === "object" &&
    "message" in json.error &&
    typeof json.error.message === "string"
  ) {
    return json.error.message;
  }
  return fallback;
}

export function useEscrow(initialAddress: string = ""): UseEscrowReturn {
  const [currentAddress, setCurrentAddress] = useState(initialAddress);
  const [state, setState] = useState<EscrowStateV1 | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<EscrowActionResponseV1 | null>(null);
  const [lastDeployed, setLastDeployed] = useState<CreateEscrowResponseV1 | null>(null);

  const resetError = useCallback(() => setError(null), []);

  const fetchState = useCallback(
    async (addressToQuery?: string): Promise<EscrowStateV1 | null> => {
      const addr = (addressToQuery ?? currentAddress).trim();
      if (!addr) {
        setError("Contract address is required.");
        return null;
      }

      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/escrow/${encodeURIComponent(addr)}/state`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });

        const json: unknown = await response.json();
        if (!response.ok) {
          throw new Error(getErrorMessage(json, `Failed to fetch state (${response.status})`));
        }

        const parsed = escrowStateResponseV1Schema.parse(json);
        setState(parsed.state);
        setCurrentAddress(addr);
        return parsed.state;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "An unexpected error occurred.";
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [currentAddress],
  );

  const createEscrow = useCallback(
    async (params: CreateEscrowRequestV1): Promise<CreateEscrowResponseV1 | null> => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/escrow/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(params),
        });

        const json: unknown = await response.json();
        if (!response.ok) {
          throw new Error(getErrorMessage(json, `Deployment failed (${response.status})`));
        }

        const parsed = createEscrowResponseV1Schema.parse(json);
        setLastDeployed(parsed);
        setCurrentAddress(parsed.contractAddress);
        setState("Funded");
        return parsed;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to create escrow contract.";
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const performAction = useCallback(
    async (
      action: "release" | "refund" | "dispute",
      targetAddress?: string,
    ): Promise<EscrowActionResponseV1 | null> => {
      const addr = (targetAddress ?? currentAddress).trim();
      if (!addr) {
        setError("Contract address is required.");
        return null;
      }

      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/escrow/${encodeURIComponent(addr)}/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        });

        const json: unknown = await response.json();
        if (!response.ok) {
          throw new Error(getErrorMessage(json, `Action ${action} failed (${response.status})`));
        }

        const parsed = escrowActionResponseV1Schema.parse(json);
        setLastAction(parsed);
        if (parsed.state) {
          setState(parsed.state);
        }
        return parsed;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : `Failed to execute ${action}.`;
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [currentAddress],
  );

  const releasePayment = useCallback(
    (address?: string) => performAction("release", address),
    [performAction],
  );

  const refundClient = useCallback(
    (address?: string) => performAction("refund", address),
    [performAction],
  );

  const raiseDispute = useCallback(
    (address?: string) => performAction("dispute", address),
    [performAction],
  );

  return {
    currentAddress,
    setCurrentAddress,
    state,
    loading,
    error,
    lastAction,
    lastDeployed,
    fetchState,
    createEscrow,
    releasePayment,
    refundClient,
    raiseDispute,
    resetError,
  };
}
