import { describe, expect, it, vi } from "vitest";

import { applyShortCooldown } from "../../src/pool/cooldown.js";
import { createPoolState, getEndpointCandidates } from "../../src/pool/state.js";
import type { EndpointState } from "../../src/pool/state.js";

function createEndpoint(): EndpointState {
    const state = createPoolState([{ chainId: 1, rpcUrls: ["https://rpc.example/"] }]);
    const endpoint = state.networks.get(1)?.endpoints[0];

    if (endpoint === undefined) {
        throw new Error("Expected test endpoint");
    }

    return endpoint;
}

describe("applyShortCooldown", () => {
    it("immediately cools an endpoint for five seconds after its first short failure", () => {
        const endpoint = createEndpoint();
        const random = vi.fn(() => 0);

        expect(applyShortCooldown(endpoint, 1_000, { random })).toBe(6_000);
        expect(endpoint.status).toBe("cooling-down");
        expect(endpoint.cooldownUntil).toBe(6_000);
        expect(endpoint.failureStreaks).toEqual({ long: 0, short: 1 });
        expect(getEndpointCandidates({ chainId: 1, endpoints: [endpoint], activeGroups: 0, selectionCursor: 0 }, 5_999))
            .toEqual([]);
        expect(random).toHaveBeenCalledOnce();
    });

    it("grows exponentially, caps at sixty seconds, and adds up to twenty percent jitter", () => {
        const endpoint = createEndpoint();
        const expectedBaseDelays = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];

        for (const [index, expectedBaseDelay] of expectedBaseDelays.entries()) {
            const nowMs = index * 100_000;
            expect(applyShortCooldown(endpoint, nowMs, { random: () => 1 })).toBe(nowMs + expectedBaseDelay * 1.2);
        }

        expect(endpoint.failureStreaks.short).toBe(6);
        expect(endpoint.failureStreaks.long).toBe(0);
    });
});
