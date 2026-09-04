"use client";

import { useState, type FormEvent } from "react";
import { useEscrow } from "../hooks/useEscrow";
import type { EscrowStateV1 } from "@soundhub/types";

interface EscrowPanelProps {
  defaultAddress?: string;
}

export function EscrowPanel({
  defaultAddress = "0x48550a4bb374727186c55365b7c9c0a1a31bdafe",
}: EscrowPanelProps) {
  const {
    currentAddress,
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
  } = useEscrow(defaultAddress);

  const [inputAddress, setInputAddress] = useState(defaultAddress);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // New escrow form state
  const [provider, setProvider] = useState("0x2222222222222222222222222222222222222222");
  const [arbitrator, setArbitrator] = useState("");
  const [duration, setDuration] = useState("86400");
  const [amount, setAmount] = useState("10000000000000");

  const handleLookup = (e: FormEvent) => {
    e.preventDefault();
    if (!inputAddress.trim()) return;
    void fetchState(inputAddress.trim());
  };

  const handleCreateEscrow = (e: FormEvent) => {
    e.preventDefault();
    void (async () => {
      const res = await createEscrow({
        provider: provider.trim(),
        arbitrator: arbitrator.trim() || undefined,
        duration: Number(duration) || 86400,
        value: amount.trim() || undefined,
      });
      if (res) {
        setInputAddress(res.contractAddress);
        setShowCreateModal(false);
      }
    })();
  };

  const getStateBadge = (s: EscrowStateV1 | null) => {
    switch (s) {
      case "Funded":
        return (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-300">
            <span className="w-2 h-2 mr-1.5 rounded-full bg-blue-500 animate-pulse" />
            Funded (Active Escrow)
          </span>
        );
      case "Released":
        return (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-300">
            <span className="w-2 h-2 mr-1.5 rounded-full bg-emerald-500" />
            Released (Completed)
          </span>
        );
      case "Disputed":
        return (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300">
            <span className="w-2 h-2 mr-1.5 rounded-full bg-amber-500" />
            Disputed (Arbitration Needed)
          </span>
        );
      case "Refunded":
        return (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-purple-100 text-purple-800 border border-purple-300">
            <span className="w-2 h-2 mr-1.5 rounded-full bg-purple-500" />
            Refunded to Client
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-700 border border-gray-300">
            Uninitialized / Not Loaded
          </span>
        );
    }
  };

  return (
    <div className="max-w-4xl mx-auto my-8 px-4 sm:px-6">
      {/* Header */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl">🔒</span>
              <h2 className="text-xl font-bold text-gray-900">Deal Escrow Smart Contract</h2>
            </div>
            <p className="text-sm text-gray-600 mt-1">
              Deterministic escrow management powered by Polkadot pallet-revive smart contracts.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm transition-colors"
          >
            + Deploy New Escrow
          </button>
        </div>

        {/* Contract Address Search Form */}
        <form onSubmit={handleLookup} className="mt-6 flex flex-col sm:flex-row gap-3">
          <div className="flex-1 relative">
            <label htmlFor="contract-address" className="sr-only">
              Contract Address
            </label>
            <input
              id="contract-address"
              type="text"
              value={inputAddress}
              onChange={(e) => setInputAddress(e.target.value)}
              placeholder="Enter contract address (e.g. 0x4855...)"
              className="w-full px-4 py-2.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !inputAddress.trim()}
            className="px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {loading ? "Checking..." : "Load Contract"}
          </button>
        </form>

        {/* Error Alert */}
        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg flex justify-between items-center text-sm text-red-700">
            <span>{error}</span>
            <button
              onClick={resetError}
              type="button"
              className="text-red-500 hover:text-red-700 font-bold ml-4"
            >
              ×
            </button>
          </div>
        )}

        {/* Recent Deploy Success Banner */}
        {lastDeployed && (
          <div className="mt-4 p-4 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-800">
            <p className="font-semibold">Escrow Contract Deployed Successfully!</p>
            <p className="mt-1 font-mono text-xs break-all">
              Address: <span className="font-bold">{lastDeployed.contractAddress}</span>
            </p>
            <p className="mt-1 font-mono text-xs text-emerald-600 break-all">
              Tx: {lastDeployed.blockHash}
            </p>
          </div>
        )}
      </div>

      {/* Contract Details Card */}
      {currentAddress && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-gray-100 gap-2">
            <div>
              <span className="text-xs uppercase tracking-wider text-gray-500 font-semibold">
                Contract Address
              </span>
              <p className="font-mono text-sm font-medium text-gray-900 break-all mt-0.5">
                {currentAddress}
              </p>
            </div>
            <div>{getStateBadge(state)}</div>
          </div>

          {/* Action Grid */}
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Available Actions</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button
                type="button"
                disabled={loading || state !== "Funded"}
                onClick={() => {
                  void releasePayment(currentAddress);
                }}
                className="flex flex-col items-center justify-center p-4 border border-emerald-200 bg-emerald-50/50 hover:bg-emerald-100/60 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed group"
              >
                <span className="text-xl mb-1">💸</span>
                <span className="text-sm font-semibold text-emerald-900">Release Payment</span>
                <span className="text-xs text-emerald-700 text-center mt-1">
                  Releases escrowed funds to seller/provider
                </span>
              </button>

              <button
                type="button"
                disabled={loading || state !== "Funded"}
                onClick={() => {
                  void raiseDispute(currentAddress);
                }}
                className="flex flex-col items-center justify-center p-4 border border-amber-200 bg-amber-50/50 hover:bg-amber-100/60 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed group"
              >
                <span className="text-xl mb-1">⚖️</span>
                <span className="text-sm font-semibold text-amber-900">Raise Dispute</span>
                <span className="text-xs text-amber-700 text-center mt-1">
                  Freezes funds for arbitrator review
                </span>
              </button>

              <button
                type="button"
                disabled={loading || state !== "Disputed"}
                onClick={() => {
                  void refundClient(currentAddress);
                }}
                className="flex flex-col items-center justify-center p-4 border border-purple-200 bg-purple-50/50 hover:bg-purple-100/60 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed group"
              >
                <span className="text-xl mb-1">↩️</span>
                <span className="text-sm font-semibold text-purple-900">Refund Client</span>
                <span className="text-xs text-purple-700 text-center mt-1">
                  Arbitrator returns deposit to buyer
                </span>
              </button>
            </div>
          </div>

          {/* Last Action Details */}
          {lastAction && (
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-100 text-xs text-gray-600">
              <span className="font-semibold text-gray-800 uppercase tracking-wide">
                Last Action: {lastAction.action}
              </span>
              <p className="font-mono mt-1 break-all text-gray-500">
                Block: {lastAction.blockHash}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Deploy Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-gray-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-gray-900">Deploy New Escrow Contract</h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-gray-400 hover:text-gray-600 text-xl font-bold"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleCreateEscrow} className="space-y-4">
              <div>
                <label
                  htmlFor="escrow-provider-address"
                  className="block text-xs font-semibold text-gray-700 mb-1"
                >
                  Provider / Seller Address (H160)
                </label>
                <input
                  id="escrow-provider-address"
                  type="text"
                  required
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label
                  htmlFor="escrow-arbitrator-address"
                  className="block text-xs font-semibold text-gray-700 mb-1"
                >
                  Arbitrator Address (Optional, defaults to platform signer)
                </label>
                <input
                  id="escrow-arbitrator-address"
                  type="text"
                  value={arbitrator}
                  onChange={(e) => setArbitrator(e.target.value)}
                  placeholder="Leave empty to use server signer"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="escrow-duration"
                    className="block text-xs font-semibold text-gray-700 mb-1"
                  >
                    Duration (seconds)
                  </label>
                  <input
                    id="escrow-duration"
                    type="number"
                    required
                    min={1}
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="escrow-amount"
                    className="block text-xs font-semibold text-gray-700 mb-1"
                  >
                    Initial Deposit (Plancks)
                  </label>
                  <input
                    id="escrow-amount"
                    type="text"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 transition-colors"
                >
                  {loading ? "Deploying on-chain..." : "Deploy Escrow"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
