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

function normalizeRpcUrl(value: string, path: string): string {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        throw new TypeError(`${path} must be a valid HTTP or HTTPS URL`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError(`${path} must use the HTTP or HTTPS protocol`);
    }

    return url.href;
}

export function normalizeManagerConfig(config: RpcPoolManagerConfig): RpcPoolManagerConfig {
    validateManagerConfig(config);

    const networks = config.networks.map((network, networkIndex) => {
        const rpcUrls = new Set<string>();

        for (const [urlIndex, rpcUrl] of network.rpcUrls.entries()) {
            const path = `networks[${String(networkIndex)}].rpcUrls[${String(urlIndex)}]`;
            rpcUrls.add(normalizeRpcUrl(rpcUrl, path));
        }

        return Object.freeze({
            chainId: network.chainId,
            rpcUrls: Object.freeze([...rpcUrls]),
        });
    });

    return Object.freeze({
        ...config,
        networks: Object.freeze(networks),
    });
}
