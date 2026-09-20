import { createEndpointCounters, createRpcCounters } from "../../src/observability/counters.js";
import type { EndpointState, PoolState } from "../../src/pool/state.js";
import type { RpcNetworkConfig } from "../../src/pool/types.js";

function createEndpointState(_rpcUrl: string, endpointNumber: number): EndpointState {
    return {
        activeGroups: 0,
        cooldownUntil: null,
        counters: createEndpointCounters(),
        endpointNumber,
        excludedReason: null,
        failureStreaks: { long: 0, short: 0 },
        latencyEwmaMs: null,
        lastReserved: 0,
        probeToken: null,
        status: "available",
        version: 0,
    };
}

export function createPoolState(networks: readonly RpcNetworkConfig[]): PoolState {
    return {
        counters: createRpcCounters(),
        networks: new Map(networks.map((network) => [network.chainId, {
            chainId: network.chainId,
            endpoints: network.rpcUrls.map((rpcUrl, index) => createEndpointState(rpcUrl, index + 1)),
            primaryRetrySelections: 0,
            reservationClock: 0,
            selectionCursor: 0,
        }])),
    };
}
