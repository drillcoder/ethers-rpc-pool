import type { RpcEndpointExcludedReason, RpcEndpointStatus } from "../observability/types.js";
import type { RpcNetworkConfig } from "./types.js";

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

function selectRoundRobin(network: NetworkState, candidates: readonly EndpointState[]): EndpointState {
  const selected = candidates.reduce((current, candidate) => {
    const currentDistance = (current.endpointNumber - 1 - network.selectionCursor + network.endpoints.length)
      % network.endpoints.length;
    const candidateDistance = (candidate.endpointNumber - 1 - network.selectionCursor + network.endpoints.length)
      % network.endpoints.length;
    return candidateDistance < currentDistance ? candidate : current;
  });

  network.selectionCursor = selected.endpointNumber % network.endpoints.length;
  return selected;
}

export function reserveEndpoint(network: NetworkState): EndpointState | null {
  const available = network.endpoints.filter((endpoint) => endpoint.status === "available");
  if (available.length === 0) {
    return null;
  }

  const minimumActiveGroups = Math.min(...available.map((endpoint) => endpoint.activeGroups));
  const leastActive = available.filter((endpoint) => endpoint.activeGroups === minimumActiveGroups);
  let candidates = leastActive.filter((endpoint) => endpoint.latencyEwmaMs === null);

  if (candidates.length === 0) {
    const measured = leastActive as readonly (EndpointState & { latencyEwmaMs: number })[];
    const minimumLatency = Math.min(...measured.map((endpoint) => endpoint.latencyEwmaMs));
    candidates = leastActive.filter((endpoint) => endpoint.latencyEwmaMs === minimumLatency);
  }

  const selected = selectRoundRobin(network, candidates);
  selected.activeGroups += 1;
  network.activeGroups += 1;
  return selected;
}
