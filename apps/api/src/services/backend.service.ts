/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable prefer-const */
/* eslint-disable no-empty */
import * as crypto from "crypto";

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { Abi } from "@polkadot/api-contract";
import type { AbiMessage, AbiConstructor } from "@polkadot/api-contract/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import process from "process";

import contractMetadataRaw from "./contract-metadata.json" assert { type: "json" };

let api: ApiPromise;
let contractAddress: string;
let arbitratorAddress: string;
let contractMetadata: any = contractMetadataRaw;
let abi: Abi;
let signer: KeyringPair;
let signerAddress: string;

function requireEnv(name: string, fallbackValue: string): string {
  const value = process.env[name] || fallbackValue;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function formatDispatchError(dispatchError: any): string {
  if (dispatchError.isModule) {
    const decoded = api.registry.findMetaError(dispatchError.asModule);
    return `${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`;
  }
  return dispatchError.toString();
}

function isDispatchError(dispatchError: any, section: string, name: string): boolean {
  if (!dispatchError.isModule) return false;
  const decoded = api.registry.findMetaError(dispatchError.asModule);
  return decoded.section === section && decoded.name === name;
}

// SCALE encodes a u64 into 8 bytes little-endian hex
function encodeU64(value: number | bigint): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer.toString("hex");
}

// Ensure address is 20-bytes (H160) for SCALE encoding in pallet-revive
function encodeAccountId(address: string): string {
  return address.startsWith("0x") ? address.slice(2) : address;
}

interface SignAndSendOptions {
  extractAddress?: boolean;
  waitForFinalized?: boolean;
}

async function signAndSend(
  tx: any,
  options: SignAndSendOptions = { extractAddress: false, waitForFinalized: false },
): Promise<any> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void;
    tx.signAndSend(signer, (result: any) => {
      const { status, dispatchError, events } = result;

      if (dispatchError) {
        if (unsubscribe) unsubscribe();
        return reject(new Error(formatDispatchError(dispatchError)));
      }

      const isDone = options.waitForFinalized ? status.isFinalized : status.isInBlock;

      if (isDone) {
        if (unsubscribe) unsubscribe();
        const blockHash = status.isInBlock ? status.asInBlock.toHex() : status.asFinalized.toHex();

        if (options.extractAddress) {
          let addr = null;
          for (const { event } of events) {
            const isInstantiated =
              (event.section === "revive" && event.method === "Instantiated") ||
              (event.section === "contracts" && event.method === "Instantiated");
            if (isInstantiated) {
              addr = event.data[1].toString(); // [deployer, contract]
              break;
            }
          }
          return resolve({ blockHash, contractAddress: addr });
        }
        resolve(blockHash);
      }
    })
      .then((unsub: any) => (unsubscribe = unsub))
      .catch(reject);
  });
}

let initPromise: Promise<void> | null = null;

export function isInitialized(): boolean {
  return Boolean(api && api.isConnected);
}

export async function ensureInitialized(): Promise<void> {
  if (api && api.isConnected) return;
  if (!initPromise) {
    initPromise = init().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export async function init(): Promise<void> {
  const wsProvider = requireEnv("WS_PROVIDER", "ws://127.0.0.1:9944");
  contractAddress = requireEnv("CONTRACT", "0x48550a4bb374727186c55365b7c9c0a1a31bdafe");
  const mnemonic = requireEnv("MNEMONIC", "//Alice");

  api = await ApiPromise.create({
    provider: new WsProvider(wsProvider),
    noInitWarn: true,
  });

  abi = new Abi(contractMetadata);

  const keyring = new Keyring({ type: "sr25519" });
  signer = keyring.addFromUri(mnemonic);

  console.log(`Substrate Address: ${signer.address}`);

  signerAddress = ((await (api.call as any).reviveApi.address(signer.address)) as any).toString();
  console.log(`Signer Address: ${signerAddress}`);
  const originalAccount = await (api.query as any).revive.originalAccount(signerAddress);

  if ((originalAccount as any).isNone) {
    console.log("Sending mapping transaction...");
    await signAndSend((api.tx as any).revive.mapAccount());
    signerAddress = ((await (api.call as any).reviveApi.address(signer.address)) as any).toString();
  }
}

export function setContractAddress(address: string, arbitrator?: string): void {
  contractAddress = address;
  if (arbitrator) arbitratorAddress = arbitrator;
}

export function getContractAddress(): string {
  return contractAddress;
}

export async function queryMessage(
  methodName: string,
  args: any[] = [],
  options: any = {},
): Promise<any> {
  const message = abi.messages.find((m: AbiMessage) => m.identifier === methodName);
  if (!message) throw new Error(`Unsupported method: ${methodName}`);

  const selectorHex = message.selector.toHex().slice(2);
  let argsHex = "";
  // Note: this simple packing works for AccountId and u64 if args map strictly
  // For a robust implementation, use `abi` message toU8a if it supports raw H160 correctly
  for (const arg of args) {
    if (typeof arg === "string" && arg.startsWith("0x")) {
      argsHex += encodeAccountId(arg);
    } else if (typeof arg === "number" || typeof arg === "bigint") {
      argsHex += encodeU64(arg);
    }
  }

  const inputData = `0x${selectorHex}${argsHex}`;

  const dryRunResult: any = await (api.call as any).reviveApi.call(
    signer.address,
    contractAddress,
    0, // value
    null, // weight limit
    null, // storage limit
    inputData,
  );

  const flags = dryRunResult.result.asOk.get("flags").get("bits").toNumber();
  if ((flags & 1) !== 0) {
    const rawData = dryRunResult.result.asOk.data.toHex();
    let decodedErr = rawData;
    try {
      const returnType = message.returnType && message.returnType.type;
      if (returnType) {
        const decoded = abi.registry.createTypeUnsafe(returnType as any, [rawData]);
        decodedErr = JSON.stringify(decoded.toHuman());
      }
    } catch (e) {}
    throw new Error(`Contract Reverted in ${methodName}: ${decodedErr}`);
  }

  return {
    gasRequired: dryRunResult.weightRequired || dryRunResult.gasRequired,
    storageDeposit: dryRunResult.storageDeposit,
    output: dryRunResult.result.asOk.data,
  };
}

export async function sendMessage(
  methodName: string,
  args: any[] = [],
  options: any = {},
): Promise<any> {
  const { gasRequired, storageDeposit } = await queryMessage(methodName, args, options);
  const message = abi.messages.find((m: AbiMessage) => m.identifier === methodName);
  if (!message) throw new Error(`Unsupported method: ${methodName}`);

  const selectorHex = message.selector.toHex().slice(2);
  let argsHex = "";

  for (const arg of args) {
    if (typeof arg === "string" && arg.startsWith("0x")) {
      argsHex += encodeAccountId(arg);
    } else if (typeof arg === "number" || typeof arg === "bigint") {
      argsHex += encodeU64(arg);
    }
  }
  const inputData = `0x${selectorHex}${argsHex}`;

  const gasLimit = api.registry.createType("Weight", {
    refTime: (BigInt(gasRequired.refTime.toString()) * 12n) / 10n,
    proofSize: (BigInt(gasRequired.proofSize.toString()) * 12n) / 10n,
  });

  const tx = (api.tx as any).revive.call(
    contractAddress,
    0, // value
    gasLimit,
    storageDeposit.asCharge || (1n << 128n) - 1n,
    inputData,
  );

  return signAndSend(tx);
}

export async function createEscrow(
  provider: string,
  arbitrator: string,
  duration: number | bigint,
  value: string = "10000000000000",
): Promise<any> {
  const constructorMessage = abi.constructors.find((c: AbiConstructor) => c.identifier === "new");
  if (!constructorMessage) throw new Error("Constructor 'new' not found");
  const selectorHex = constructorMessage.selector.toHex().slice(2);

  const providerHex = encodeAccountId(provider);
  const arbitratorHex = encodeAccountId(arbitrator);
  const durationHex = encodeU64(duration);

  const constructorArgs = `${selectorHex}${providerHex}${arbitratorHex}${durationHex}`;

  // Revive instantiateWithCode requires bytecode + appended constructor args
  let wasmBytecodeHex =
    contractMetadata.source.contract_binary ||
    contractMetadata.source.wasm ||
    contractMetadata.source.code;
  if (wasmBytecodeHex.startsWith("0x")) wasmBytecodeHex = wasmBytecodeHex.slice(2);
  const fullCodeBlob = `0x${wasmBytecodeHex}`;

  const randomSalt = "0x" + crypto.randomBytes(32).toString("hex");

  // Dry-run instantiate to get gas limits
  const dryRunResult: any = await (api.call as any).reviveApi.instantiate(
    signer.address,
    value,
    null, // gas
    null, // storage
    { Upload: fullCodeBlob },
    `0x${constructorArgs}`, // data
    randomSalt,
  );

  if (dryRunResult.result.isErr) {
    throw new Error(`Instantiate DryRun Failed: ${dryRunResult.result.asErr.toString()}`);
  }

  const requiredGas = dryRunResult.weightRequired || dryRunResult.gasRequired;
  const gasLimit = api.registry.createType("Weight", {
    refTime: (BigInt(requiredGas.refTime.toString()) * 12n) / 10n,
    proofSize: (BigInt(requiredGas.proofSize.toString()) * 12n) / 10n,
  });

  const tx = (api.tx as any).revive.instantiateWithCode(
    value,
    gasLimit,
    dryRunResult.storageDeposit.asCharge || (1n << 128n) - 1n,
    fullCodeBlob,
    `0x${constructorArgs}`,
    randomSalt,
  );

  const { blockHash, contractAddress: newAddress } = await signAndSend(tx, {
    extractAddress: true,
  });

  if (newAddress) {
    setContractAddress(newAddress, arbitrator);
  }

  return { blockHash, contractAddress: newAddress };
}

export async function getSignerAddress(): Promise<string> {
  return signerAddress;
}

export async function releasePayment(targetAddress?: string): Promise<any> {
  if (targetAddress) contractAddress = targetAddress;
  return sendMessage("release_payment");
}

export async function refundClient(targetAddress?: string): Promise<any> {
  if (targetAddress) contractAddress = targetAddress;
  return sendMessage("refund_client");
}

export async function raiseDispute(targetAddress?: string): Promise<any> {
  if (targetAddress) contractAddress = targetAddress;
  return sendMessage("raise_dispute");
}

export async function getState(targetAddress?: string): Promise<any> {
  if (targetAddress) contractAddress = targetAddress;
  const { output } = await queryMessage("get_state");
  // decode output against return type
  const message = abi.messages.find((m: AbiMessage) => m.identifier === "get_state");
  if (message && message.returnType) {
    const decoded = abi.registry.createTypeUnsafe(message.returnType.type as any, [output.toHex()]);
    const human: any = decoded.toHuman();
    if (typeof human === "string") return human;
    if (human && typeof human === "object" && "Ok" in human) return human.Ok;
    return "Unknown";
  }
  return "Unknown";
}

export async function disconnect(): Promise<void> {
  if (api) await api.disconnect();
}
