import { describe, expect, it } from "vitest";

import { applyShortCooldown, excludeEndpointForAuthorization } from "../../src/pool/cooldown.js";
import {
    getEndpointCandidates,
    isEndpointReservationCurrent,
    reserveEndpoint,
    runEndpointReservation,
    selectEndpointCandidate,
    updateEndpointLatency,
} from "../../src/pool/state.js";
import type { EndpointReservation, EndpointState, NetworkState } from "../../src/pool/state.js";
import { createPoolState } from "../helpers/pool-state.js";

const networks = [
    { chainId: 1, rpcUrls: ["https://first.example/", "https://second.example/"] },
    { chainId: 10, rpcUrls: ["https://optimism.example/"] },
] as const;

describe("createPoolState", () => {
    it("initializes network and endpoint state with stable network-local numbers", () => {
        const state = createPoolState(networks);

        expect([...state.networks.keys()]).toEqual([1, 10]);
        expect(state.counters).toEqual({
            errorsByCategory: new Map(),
            requestsByMethod: new Map(),
            totalRequests: 0,
        });
        expect(state.networks.get(1)).toEqual({
            chainId: 1,
            activeGroups: 0,
            primaryRetrySelections: 0,
            reservationClock: 0,
            selectionCursor: 0,
            endpoints: [
                {
                    counters: { errorCount: 0, requestCount: 0 },
                    endpointNumber: 1,
                    rpcUrl: "https://first.example/",
                    activeGroups: 0,
                    cooldownUntil: null,
                    excludedReason: null,
                    failureStreaks: { long: 0, short: 0 },
                    lastReserved: 0,
                    latencyEwmaMs: null,
                    probeToken: null,
                    status: "available",
                    version: 0,
                },
                {
                    counters: { errorCount: 0, requestCount: 0 },
                    endpointNumber: 2,
                    rpcUrl: "https://second.example/",
                    activeGroups: 0,
                    cooldownUntil: null,
                    excludedReason: null,
                    failureStreaks: { long: 0, short: 0 },
                    lastReserved: 0,
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

function reserveExpiredProbe(): {
    readonly endpoint: EndpointState;
    readonly network: NetworkState;
    readonly reservation: EndpointReservation;
} {
    const network = createNetwork();
    const endpoint = network.endpoints[0];
    const sibling = network.endpoints[1];

    if (endpoint === undefined || sibling === undefined) {
        throw new Error("Expected test endpoints");
    }

    endpoint.status = "cooling-down";
    endpoint.cooldownUntil = 100;
    sibling.status = "excluded";

    const reservation = reserveEndpoint(network, 100);
    if (reservation === null) {
        throw new Error("Expected probe reservation");
    }

    return { endpoint, network, reservation };
}

describe("reserveEndpoint", () => {
    it("minimizes latency multiplied by active groups plus one", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];

        if (first === undefined || second === undefined) {
            throw new Error("Expected test endpoints");
        }

        first.activeGroups = 2;
        first.latencyEwmaMs = 20;
        second.latencyEwmaMs = 100;

        expect(reserveEndpoint(network, 0)?.endpoint).toBe(first);
        expect(first.activeGroups).toBe(3);
        expect(network.activeGroups).toBe(1);

        first.activeGroups = 5;
        network.activeGroups = 0;
        expect(reserveEndpoint(network, 0)?.endpoint).toBe(second);
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

        expect(reserveEndpoint(network, 0)?.endpoint).toBe(second);
    });

    it("uses primary retry reservations to sample every endpoint during cold start", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];

        if (first === undefined || second === undefined) {
            throw new Error("Expected test endpoints");
        }

        expect(reserveEndpoint(network, 0, "retry", true)?.endpoint).toBe(first);
        first.activeGroups = 0;
        first.latencyEwmaMs = 1;
        network.activeGroups = 0;
        expect(reserveEndpoint(network, 0, "retry", true)?.endpoint).toBe(second);
    });

    it("uses round-robin when measured latency is equal", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];

        if (first === undefined || second === undefined) {
            throw new Error("Expected test endpoints");
        }

        first.latencyEwmaMs = 50;
        second.latencyEwmaMs = 50;
        expect(reserveEndpoint(network, 0)?.endpoint).toBe(first);
        first.activeGroups = 0;
        network.activeGroups = 0;
        expect(reserveEndpoint(network, 0)?.endpoint).toBe(second);
    });

    it("explores only every twentieth measured primary retry reservation", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];
        if (first === undefined || second === undefined) throw new Error("Expected test endpoints");
        first.latencyEwmaMs = 10;
        second.latencyEwmaMs = 100;

        const selected: number[] = [];
        for (let position = 1; position <= 40; position += 1) {
            const reservation = reserveEndpoint(network, 0, "retry", true);
            if (reservation === null) throw new Error("Expected reservation");
            selected.push(reservation.endpoint.endpointNumber);
            reservation.endpoint.activeGroups = 0;
            network.activeGroups = 0;
        }

        expect(selected.filter((endpointNumber) => endpointNumber === 2)).toHaveLength(2);
        expect(selected[19]).toBe(2);
        expect(selected[39]).toBe(2);
        expect(network.reservationClock).toBe(40);
    });

    it("consumes an exploration position when no free alternative exists", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];
        if (first === undefined || second === undefined) throw new Error("Expected test endpoints");
        first.latencyEwmaMs = 10;
        second.latencyEwmaMs = 100;
        second.activeGroups = 1;
        network.activeGroups = 1;
        network.primaryRetrySelections = 19;

        expect(reserveEndpoint(network, 0, "retry", true)?.endpoint).toBe(first);
        expect(network.primaryRetrySelections).toBe(20);
        first.activeGroups = 0;
        second.activeGroups = 0;
        network.activeGroups = 0;
        expect(reserveEndpoint(network, 0, "retry", true)?.endpoint).toBe(first);
        expect(network.primaryRetrySelections).toBe(21);
    });

    it("does not advance exploration for once, retry attempts, or cold start", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];
        if (first === undefined || second === undefined) throw new Error("Expected test endpoints");

        expect(reserveEndpoint(network, 0, "retry", true)?.endpoint).toBe(first);
        first.activeGroups = 0;
        network.activeGroups = 0;
        expect(network.primaryRetrySelections).toBe(0);
        first.latencyEwmaMs = 10;
        second.latencyEwmaMs = 20;
        reserveEndpoint(network, 0, "once", true);
        first.activeGroups = 0;
        second.activeGroups = 0;
        network.activeGroups = 0;
        reserveEndpoint(network, 0, "retry", false);
        expect(network.primaryRetrySelections).toBe(0);
    });

    it("returns null when no endpoint is available", () => {
        const network = createNetwork();

        for (const endpoint of network.endpoints) {
            endpoint.status = "cooling-down";
        }

        expect(reserveEndpoint(network, 0)).toBeNull();
        expect(network.activeGroups).toBe(0);
    });

    it("recognizes current normal and probe reservations and rejects stale versions or tokens", () => {
        const network = createNetwork();
        const reservation = reserveEndpoint(network, 0);
        if (reservation === null) {
            throw new Error("Expected endpoint reservation");
        }

        expect(isEndpointReservationCurrent(reservation)).toBe(true);
        reservation.endpoint.version += 1;
        expect(isEndpointReservationCurrent(reservation)).toBe(false);

        const probe = reserveExpiredProbe();
        expect(isEndpointReservationCurrent(probe.reservation)).toBe(true);
        probe.endpoint.probeToken = Symbol("new-probe");
        expect(isEndpointReservationCurrent(probe.reservation)).toBe(false);
    });
});

describe("candidate inspection and reservation", () => {
    it("inspects an expired cooldown without reserving its probe slot", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];

        if (first === undefined || second === undefined) {
            throw new Error("Expected test endpoints");
        }

        first.status = "cooling-down";
        first.cooldownUntil = 100;
        second.status = "excluded";

        const candidates = getEndpointCandidates(network, 100);
        expect(candidates).toEqual([{ endpoint: first, requiresProbe: true }]);
        expect(selectEndpointCandidate(network, candidates)).toEqual(candidates[0]);
        expect(first.status).toBe("cooling-down");
        expect(first.probeToken).toBeNull();
        expect(first.activeGroups).toBe(0);
        expect(network.activeGroups).toBe(0);
        expect(network.selectionCursor).toBe(0);
    });

    it("atomically permits only one reservation of an expired endpoint", () => {
        const network = createNetwork();
        const first = network.endpoints[0];
        const second = network.endpoints[1];

        if (first === undefined || second === undefined) {
            throw new Error("Expected test endpoints");
        }

        first.status = "cooling-down";
        first.cooldownUntil = 100;
        second.status = "cooling-down";
        second.cooldownUntil = 101;

        const reservation = reserveEndpoint(network, 100);
        expect(reservation?.endpoint).toBe(first);
        expect(reservation?.probeToken).toBe(first.probeToken);
        expect(first.status).toBe("probe");
        expect(first.probeToken).not.toBeNull();
        expect(reserveEndpoint(network, 100)).toBeNull();
    });

    it("recovers a successful probe, resets failure streaks, and releases its slot", async () => {
        const network = createNetwork();
        const endpoint = network.endpoints[0];

        if (endpoint === undefined) {
            throw new Error("Expected test endpoint");
        }

        endpoint.status = "cooling-down";
        endpoint.cooldownUntil = 100;
        endpoint.failureStreaks.long = 2;
        endpoint.failureStreaks.short = 3;
        const sibling = network.endpoints[1];
        if (sibling === undefined) {
            throw new Error("Expected sibling endpoint");
        }
        sibling.status = "excluded";

        const reservation = reserveEndpoint(network, 100);
        if (reservation === null) {
            throw new Error("Expected probe reservation");
        }

        await expect(runEndpointReservation(network, reservation, () => Promise.resolve("recovered")))
            .resolves.toBe("recovered");
        expect(endpoint.status).toBe("available");
        expect(endpoint.cooldownUntil).toBeNull();
        expect(endpoint.failureStreaks).toEqual({ long: 0, short: 0 });
        expect(endpoint.probeToken).toBeNull();
        expect(endpoint.activeGroups).toBe(0);
        expect(network.activeGroups).toBe(0);
    });

    it("releases a successful ordinary reservation without changing endpoint health", async () => {
        const network = createNetwork();
        const reservation = reserveEndpoint(network, 0);

        if (reservation === null) {
            throw new Error("Expected ordinary reservation");
        }

        await expect(runEndpointReservation(network, reservation, () => Promise.resolve(42)))
            .resolves.toBe(42);
        expect(reservation.endpoint.status).toBe("available");
        expect(reservation.endpoint.activeGroups).toBe(0);
        expect(network.activeGroups).toBe(0);
    });

    it("extends cooldown after a failed probe and always releases its slot", async () => {
        const network = createNetwork();
        const endpoint = network.endpoints[0];
        const error = new Error("probe failed");

        if (endpoint === undefined) {
            throw new Error("Expected test endpoint");
        }

        endpoint.status = "cooling-down";
        endpoint.cooldownUntil = 100;
        endpoint.failureStreaks.short = 1;
        const sibling = network.endpoints[1];
        if (sibling === undefined) {
            throw new Error("Expected sibling endpoint");
        }
        sibling.status = "excluded";

        const reservation = reserveEndpoint(network, 100);
        if (reservation === null) {
            throw new Error("Expected probe reservation");
        }

        await expect(runEndpointReservation(network, reservation, async () => {
            try {
                return await Promise.reject(error);
            } catch (failure: unknown) {
                applyShortCooldown(endpoint, 100, { random: () => 0 });
                throw failure;
            }
        })).rejects.toBe(error);
        expect(endpoint.status).toBe("cooling-down");
        expect(endpoint.cooldownUntil).toBe(10_100);
        expect(endpoint.failureStreaks.short).toBe(2);
        expect(endpoint.probeToken).toBeNull();
        expect(endpoint.activeGroups).toBe(0);
        expect(network.activeGroups).toBe(0);
    });

    it("releases the probe slot when the operation rejects during cancellation", async () => {
        const network = createNetwork();
        const endpoint = network.endpoints[0];
        const cancellation = new DOMException("Cancelled", "AbortError");

        if (endpoint === undefined) {
            throw new Error("Expected test endpoint");
        }

        endpoint.status = "cooling-down";
        endpoint.cooldownUntil = 100;
        const sibling = network.endpoints[1];
        if (sibling === undefined) {
            throw new Error("Expected sibling endpoint");
        }
        sibling.status = "excluded";

        const reservation = reserveEndpoint(network, 100);
        if (reservation === null) {
            throw new Error("Expected probe reservation");
        }

        await expect(runEndpointReservation(network, reservation, () => Promise.reject(cancellation)))
            .rejects.toBe(cancellation);
        expect(endpoint.status).toBe("cooling-down");
        expect(endpoint.probeToken).toBeNull();
        expect(endpoint.activeGroups).toBe(0);
        expect(network.activeGroups).toBe(0);
    });

    it("does not let a late probe success erase a newer cooldown", async () => {
        const { endpoint, network, reservation } = reserveExpiredProbe();

        applyShortCooldown(endpoint, 200, { random: () => 0 });
        await runEndpointReservation(network, reservation, () => Promise.resolve());

        expect(endpoint.status).toBe("cooling-down");
        expect(endpoint.cooldownUntil).toBe(5_200);
        expect(endpoint.failureStreaks.short).toBe(1);
        expect(endpoint.probeToken).toBeNull();
    });

    it("does not let a late probe success reverse permanent exclusion", async () => {
        const { endpoint, network, reservation } = reserveExpiredProbe();

        excludeEndpointForAuthorization(endpoint);
        await runEndpointReservation(network, reservation, () => Promise.resolve());

        expect(endpoint.status).toBe("excluded");
        expect(endpoint.excludedReason).toBe("authorization");
        expect(endpoint.cooldownUntil).toBeNull();
        expect(endpoint.probeToken).toBeNull();
    });

    it("does not clear or recover a probe slot owned by another token", async () => {
        const { endpoint, network, reservation } = reserveExpiredProbe();
        const replacementToken = Symbol("replacement-probe");

        endpoint.probeToken = replacementToken;
        await runEndpointReservation(network, reservation, () => Promise.resolve());

        expect(endpoint.status).toBe("probe");
        expect(endpoint.cooldownUntil).toBe(100);
        expect(endpoint.probeToken).toBe(replacementToken);
    });

    it("does not recover an endpoint that became excluded without changing the reservation version", async () => {
        const { endpoint, network, reservation } = reserveExpiredProbe();

        endpoint.status = "excluded";
        await runEndpointReservation(network, reservation, () => Promise.resolve());

        expect(endpoint.status).toBe("excluded");
        expect(endpoint.probeToken).toBeNull();
    });
});

describe("updateEndpointLatency", () => {
    it("uses the first sample as the initial EWMA and smooths later samples", () => {
        const network = createNetwork();
        const endpoint = network.endpoints[0];

        if (endpoint === undefined) {
            throw new Error("Expected test endpoint");
        }

        updateEndpointLatency(endpoint, 100);
        expect(endpoint.latencyEwmaMs).toBe(100);
        updateEndpointLatency(endpoint, 200);
        expect(endpoint.latencyEwmaMs).toBe(120);
    });
});
