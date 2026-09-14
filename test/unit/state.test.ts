import { describe, expect, it } from "vitest";

import { createPoolState, reserveEndpoint } from "../../src/pool/state.js";
import type { NetworkState } from "../../src/pool/state.js";

const networks = [
    { chainId: 1, rpcUrls: ["https://first.example/", "https://second.example/"] },
    { chainId: 10, rpcUrls: ["https://optimism.example/"] },
] as const;

describe("createPoolState", () => {
    it("initializes network and endpoint state with stable network-local numbers", () => {
        const state = createPoolState(networks);

        expect([...state.networks.keys()]).toEqual([1, 10]);
        expect(state.networks.get(1)).toEqual({
            chainId: 1,
            activeGroups: 0,
            selectionCursor: 0,
            endpoints: [
                {
                    endpointNumber: 1,
                    rpcUrl: "https://first.example/",
                    activeGroups: 0,
                    cooldownUntil: null,
                    excludedReason: null,
                    failureStreaks: { long: 0, short: 0 },
                    latencyEwmaMs: null,
                    probeToken: null,
                    status: "available",
                    version: 0,
                },
                {
                    endpointNumber: 2,
                    rpcUrl: "https://second.example/",
                    activeGroups: 0,
                    cooldownUntil: null,
                    excludedReason: null,
                    failureStreaks: { long: 0, short: 0 },
                    latencyEwmaMs: null,
                    probeToken: null,
                    status: "available",
                    version: 0,
                },
            ],
        });
        expect(state.networks.get(10)?.endpoints[0]?.endpointNumber).toBe(1);
    });

    it("does not share mutable state between pool instances or endpoints", () => {
        const first = createPoolState(networks);
        const second = createPoolState(networks);
        const firstEndpoint = first.networks.get(1)?.endpoints[0];
        const siblingEndpoint = first.networks.get(1)?.endpoints[1];
        const secondEndpoint = second.networks.get(1)?.endpoints[0];

        expect(firstEndpoint).toBeDefined();
        if (firstEndpoint === undefined) {
            return;
        }

        firstEndpoint.activeGroups = 1;
        firstEndpoint.failureStreaks.short = 2;
        firstEndpoint.probeToken = Symbol("probe");
        firstEndpoint.status = "probe";
        firstEndpoint.version = 3;

        expect(siblingEndpoint?.activeGroups).toBe(0);
        expect(siblingEndpoint?.failureStreaks.short).toBe(0);
        expect(secondEndpoint?.activeGroups).toBe(0);
        expect(secondEndpoint?.failureStreaks.short).toBe(0);
        expect(secondEndpoint?.probeToken).toBeNull();
        expect(secondEndpoint?.status).toBe("available");
        expect(secondEndpoint?.version).toBe(0);
    });
});

function createNetwork(): NetworkState {
    const network = createPoolState(networks).networks.get(1);
    if (network === undefined) {
        throw new Error("Expected test network");
    }

    return network;
}

describe("reserveEndpoint", () => {
    it("reserves the least-active endpoint before considering latency", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];

        if (first === undefined || second === undefined) {
            throw new Error("Expected test endpoints");
        }

        first.activeGroups = 1;
        first.latencyEwmaMs = 10;
        second.latencyEwmaMs = 100;

        expect(reserveEndpoint(network)).toBe(second);
        expect(second.activeGroups).toBe(1);
        expect(network.activeGroups).toBe(1);
    });

    it("reserves the lowest-latency endpoint when load is equal", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];

        if (first === undefined || second === undefined) {
            throw new Error("Expected test endpoints");
        }

        first.latencyEwmaMs = 100;
        second.latencyEwmaMs = 20;

        expect(reserveEndpoint(network)).toBe(second);
    });

    it("uses round-robin for cold start and equal measured latency", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];

        if (first === undefined || second === undefined) {
            throw new Error("Expected test endpoints");
        }

        expect(reserveEndpoint(network)).toBe(first);
        first.activeGroups = 0;
        network.activeGroups = 0;
        expect(reserveEndpoint(network)).toBe(second);

        second.activeGroups = 0;
        network.activeGroups = 0;
        first.latencyEwmaMs = 50;
        second.latencyEwmaMs = 50;
        expect(reserveEndpoint(network)).toBe(first);
        first.activeGroups = 0;
        network.activeGroups = 0;
        expect(reserveEndpoint(network)).toBe(second);
    });

    it("returns null when no endpoint is available", () => {
        const network = createNetwork();

        for (const endpoint of network.endpoints) {
            endpoint.status = "cooling-down";
        }

        expect(reserveEndpoint(network)).toBeNull();
        expect(network.activeGroups).toBe(0);
    });
});
