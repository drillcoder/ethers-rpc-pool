import type { RpcEndpointExcludedReason, RpcEndpointStatus } from "../observability/types.js";
import type { RuntimeDependencies } from "./runtime.js";
import type { RpcNetworkConfig } from "./types.js";

const latencyEwmaWeight = 0.2;

export interface EndpointFailureStreaks {
    long: number;
    short: number;
}

export type EndpointProbeToken = symbol;

export interface EndpointState {
    readonly endpointNumber: number;
    readonly rpcUrl: string;
    activeGroups: number;
    cooldownUntil: number | null;
    excludedReason: RpcEndpointExcludedReason;
    readonly failureStreaks: EndpointFailureStreaks;
    latencyEwmaMs: number | null;
    probeToken: EndpointProbeToken | null;
    status: RpcEndpointStatus;
    version: number;
}

export interface NetworkState {
    readonly chainId: number;
    readonly endpoints: readonly EndpointState[];
    activeGroups: number;
    selectionCursor: number;
}

export interface PoolState {
    readonly networks: ReadonlyMap<number, NetworkState>;
}

export interface EndpointCandidate {
    readonly endpoint: EndpointState;
    readonly requiresProbe: boolean;
}

export interface EndpointReservation extends EndpointCandidate {
    readonly probeToken: EndpointProbeToken | null;
}

function createEndpointState(rpcUrl: string, endpointNumber: number): EndpointState {
    return {
        endpointNumber,
        rpcUrl,
        activeGroups: 0,
        cooldownUntil: null,
        excludedReason: null,
        failureStreaks: {
            long: 0,
            short: 0,
        },
        latencyEwmaMs: null,
        probeToken: null,
        status: "available",
        version: 0,
    };
}

export function createPoolState(networks: readonly RpcNetworkConfig[]): PoolState {
    return {
        networks: new Map(
            networks.map((network) => [
                network.chainId,
                {
                    chainId: network.chainId,
                    endpoints: network.rpcUrls.map((rpcUrl, index) => createEndpointState(rpcUrl, index + 1)),
                    activeGroups: 0,
                    selectionCursor: 0,
                },
            ]),
        ),
    };
}

function selectRoundRobin(network: NetworkState, candidates: readonly EndpointCandidate[]): EndpointCandidate {
    const endpointCount = network.endpoints.length;
    const cursor = network.selectionCursor;
    return candidates.reduce((current, candidate) => {
        const currentDistance = (current.endpoint.endpointNumber - 1 - cursor + endpointCount) % endpointCount;
        const candidateDistance = (candidate.endpoint.endpointNumber - 1 - cursor + endpointCount) % endpointCount;
        return candidateDistance < currentDistance ? candidate : current;
    });
}

export function getEndpointCandidates(network: NetworkState, nowMs: number): readonly EndpointCandidate[] {
    return network.endpoints.flatMap<EndpointCandidate>((endpoint) => {
        if (endpoint.status === "available") {
            return [{ endpoint, requiresProbe: false }];
        }

        if (endpoint.status === "cooling-down" && endpoint.cooldownUntil !== null && endpoint.cooldownUntil <= nowMs) {
            return [{ endpoint, requiresProbe: true }];
        }

        return [];
    });
}

export function selectEndpointCandidate(
    network: NetworkState,
    candidates: readonly EndpointCandidate[],
): EndpointCandidate | null {
    if (candidates.length === 0) {
        return null;
    }

    const minimumActiveGroups = Math.min(...candidates.map(({ endpoint }) => endpoint.activeGroups));
    const leastActive = candidates.filter(({ endpoint }) => endpoint.activeGroups === minimumActiveGroups);
    let preferred = leastActive.filter(({ endpoint }) => endpoint.latencyEwmaMs === null);

    if (preferred.length === 0) {
        const measured = leastActive as readonly (EndpointCandidate & { endpoint: { latencyEwmaMs: number } })[];
        const minimumLatency = Math.min(...measured.map(({ endpoint }) => endpoint.latencyEwmaMs));
        preferred = leastActive.filter(({ endpoint }) => endpoint.latencyEwmaMs === minimumLatency);
    }

    return selectRoundRobin(network, preferred);
}

export function reserveEndpoint(network: NetworkState, nowMs: number): EndpointReservation | null {
    const selected = selectEndpointCandidate(network, getEndpointCandidates(network, nowMs));
    if (selected === null) {
        return null;
    }

    const probeToken = selected.requiresProbe ? Symbol("endpoint-probe") : null;
    if (probeToken !== null) {
        selected.endpoint.probeToken = probeToken;
        selected.endpoint.status = "probe";
    }

    network.selectionCursor = selected.endpoint.endpointNumber % network.endpoints.length;
    selected.endpoint.activeGroups += 1;
    network.activeGroups += 1;
    return { ...selected, probeToken };
}

export function updateEndpointLatency(endpoint: EndpointState, sampleMs: number): void {
    const previous = endpoint.latencyEwmaMs;
    endpoint.latencyEwmaMs = previous === null
        ? sampleMs
        : latencyEwmaWeight * sampleMs + (1 - latencyEwmaWeight) * previous;
}

export async function runMeasuredEndpointCall<Result>(
    endpoint: EndpointState,
    runtime: Pick<RuntimeDependencies, "monotonicNow">,
    operation: () => Promise<Result>,
): Promise<Result> {
    const startedAt = runtime.monotonicNow();

    try {
        return await operation();
    } finally {
        updateEndpointLatency(endpoint, runtime.monotonicNow() - startedAt);
    }
}
