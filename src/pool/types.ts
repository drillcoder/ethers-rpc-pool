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
