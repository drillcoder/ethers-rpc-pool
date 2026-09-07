import type { JsonRpcProvider, Provider } from "ethers";

import type { RpcPoolLogger } from "../observability/types.js";

export interface RpcNetworkConfig {
  readonly chainId: number;
  readonly rpcUrls: readonly string[];
}

export interface RpcPoolManagerConfig {
  readonly networks: readonly RpcNetworkConfig[];
  readonly requestTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly logger?: RpcPoolLogger;
}

export interface RpcExecutionOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

type RetryableRpcMethod =
  | "call"
  | "estimateGas"
  | "getBalance"
  | "getBlock"
  | "getBlockNumber"
  | "getCode"
  | "getFeeData"
  | "getLogs"
  | "getNetwork"
  | "getStorage"
  | "getTransaction"
  | "getTransactionCount"
  | "getTransactionReceipt"
  | "getTransactionResult"
  | "lookupAddress"
  | "resolveName"
  | "waitForBlock"
  | "waitForTransaction";

export type RetryableRpcClient = Pick<Provider, RetryableRpcMethod>;

export type SingleAttemptRpcClient = JsonRpcProvider;
