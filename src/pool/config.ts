import type { RpcPoolManagerConfig } from "./types.js";

function assertPositiveSafeInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${path} must be a positive safe integer`);
  }
}

export function validateManagerConfig(config: RpcPoolManagerConfig): void {
  assertPositiveSafeInteger(config.requestTimeoutMs, "requestTimeoutMs");
  assertPositiveSafeInteger(config.operationTimeoutMs, "operationTimeoutMs");

  const chainIds = new Set<number>();

  for (const [networkIndex, network] of config.networks.entries()) {
    const networkPath = `networks[${String(networkIndex)}]`;
    const chainIdPath = `${networkPath}.chainId`;
    assertPositiveSafeInteger(network.chainId, chainIdPath);

    if (chainIds.has(network.chainId)) {
      throw new TypeError(`${chainIdPath} must be unique`);
    }

    chainIds.add(network.chainId);

    if (network.rpcUrls.length === 0) {
      throw new TypeError(`${networkPath}.rpcUrls must not be empty`);
    }
  }
}
