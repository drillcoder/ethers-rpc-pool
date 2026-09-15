import type { RpcErrorCategory } from "./types.js";

export interface EndpointCounters {
    errorCount: number;
    requestCount: number;
}

export interface RpcCounters {
    readonly errorsByCategory: Map<RpcErrorCategory, number>;
    readonly requestsByMethod: Map<string, number>;
    totalRequests: number;
}

export function createEndpointCounters(): EndpointCounters {
    return { errorCount: 0, requestCount: 0 };
}

export function createRpcCounters(): RpcCounters {
    return {
        errorsByCategory: new Map(),
        requestsByMethod: new Map(),
        totalRequests: 0,
    };
}

export function recordRpcRequest(counters: RpcCounters, endpoint: EndpointCounters, method: string): void {
    counters.totalRequests += 1;
    counters.requestsByMethod.set(method, (counters.requestsByMethod.get(method) ?? 0) + 1);
    endpoint.requestCount += 1;
}

export function recordRpcError(counters: RpcCounters, endpoint: EndpointCounters, category: RpcErrorCategory): void {
    counters.errorsByCategory.set(category, (counters.errorsByCategory.get(category) ?? 0) + 1);
    endpoint.errorCount += 1;
}
