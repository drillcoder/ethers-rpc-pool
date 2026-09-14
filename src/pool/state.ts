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
        },
      ]),
    ),
  };
}
