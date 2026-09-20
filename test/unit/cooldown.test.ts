import { describe, expect, it, vi } from "vitest";

import {
    applyEndpointDataCooldown,
    applyLongCooldown,
    applyShortCooldown,
    excludeEndpoint,
} from "../../src/pool/cooldown.js";
import { getEndpointCandidates } from "../../src/pool/state.js";
import type { EndpointState } from "../../src/pool/state.js";
import { createPoolState } from "../helpers/pool-state.js";

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
        expect(getEndpointCandidates({
            chainId: 1,
            endpoints: [endpoint],
            primaryRetrySelections: 0,
            reservationClock: 0,
            selectionCursor: 0,
        }, 5_999))
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

    it("never shortens a newer cooldown and increments the endpoint version", () => {
        const endpoint = createEndpoint();

        endpoint.cooldownUntil = 20_000;
        expect(applyShortCooldown(endpoint, 1_000, { random: () => 0 })).toBe(20_000);
        expect(endpoint.version).toBe(1);
    });
});

describe("applyLongCooldown", () => {
    it("grows from thirty seconds to a five-minute cap independently of the short streak", () => {
        const endpoint = createEndpoint();
        const expectedBaseDelays = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];

        endpoint.failureStreaks.short = 3;
        for (const [index, expectedBaseDelay] of expectedBaseDelays.entries()) {
            const nowMs = index * 1_000_000;
            expect(applyLongCooldown(endpoint, nowMs, { random: () => 0 })).toBe(nowMs + expectedBaseDelay);
        }

        expect(endpoint.failureStreaks).toEqual({ long: 6, short: 3 });
    });

    it("uses Retry-After above the policy maximum as the lower bound before jitter", () => {
        const endpoint = createEndpoint();

        expect(applyLongCooldown(endpoint, 1_000, { random: () => 0.5 }, 600_000)).toBe(661_000);
        expect(endpoint.cooldownUntil).toBe(661_000);
        expect(endpoint.status).toBe("cooling-down");
    });
});

describe("authorization and endpoint-data failures", () => {
    it("permanently excludes an unauthorized endpoint without a recovery deadline", () => {
        const endpoint = createEndpoint();
        const network = {
            chainId: 1,
            endpoints: [endpoint],
            primaryRetrySelections: 0,
            reservationClock: 0,
            selectionCursor: 0,
        };

        endpoint.cooldownUntil = 10_000;
        excludeEndpoint(endpoint, "authorization");

        expect(endpoint.status).toBe("excluded");
        expect(endpoint.excludedReason).toBe("authorization");
        expect(endpoint.cooldownUntil).toBeNull();
        expect(getEndpointCandidates(network, Infinity)).toEqual([]);
    });

    it("permanently excludes a mismatched-chain endpoint without a recovery deadline", () => {
        const endpoint = createEndpoint();

        endpoint.cooldownUntil = 10_000;
        excludeEndpoint(endpoint, "chain-id-mismatch");

        expect(endpoint.status).toBe("excluded");
        expect(endpoint.excludedReason).toBe("chain-id-mismatch");
        expect(endpoint.cooldownUntil).toBeNull();
        expect(endpoint.version).toBe(1);
        excludeEndpoint(endpoint, "chain-id-mismatch");
        expect(endpoint.version).toBe(1);
    });

    it("uses a fixed five-second endpoint-data cooldown without changing failure streaks", () => {
        const endpoint = createEndpoint();

        expect(applyEndpointDataCooldown(endpoint, 1_000, { random: () => 0 })).toBe(6_000);
        expect(applyEndpointDataCooldown(endpoint, 10_000, { random: () => 1 })).toBe(16_000);
        expect(endpoint.status).toBe("cooling-down");
        expect(endpoint.cooldownUntil).toBe(16_000);
        expect(endpoint.failureStreaks).toEqual({ long: 0, short: 0 });
        expect(endpoint.version).toBe(2);
    });

    it("keeps permanent exclusion immutable for every cooldown mutation", () => {
        const endpoint = createEndpoint();
        const random = vi.fn(() => 0);

        endpoint.excludedReason = "chain-id-mismatch";
        endpoint.status = "excluded";
        endpoint.version = 3;

        expect(applyShortCooldown(endpoint, 1_000, { random })).toBe(1_000);
        expect(applyLongCooldown(endpoint, 2_000, { random })).toBe(2_000);
        expect(applyEndpointDataCooldown(endpoint, 3_000, { random })).toBe(3_000);
        excludeEndpoint(endpoint, "authorization");

        expect(endpoint.status).toBe("excluded");
        expect(endpoint.excludedReason).toBe("chain-id-mismatch");
        expect(endpoint.cooldownUntil).toBeNull();
        expect(endpoint.failureStreaks).toEqual({ long: 0, short: 0 });
        expect(endpoint.version).toBe(3);
        expect(random).not.toHaveBeenCalled();
    });
});
