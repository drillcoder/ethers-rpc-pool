import { afterEach, describe, expect, it, vi } from "vitest";

import { NoUsableRpcEndpointError, OperationTimeoutError } from "../../src/index.js";
import { createRuntime } from "../../src/pool/runtime.js";
import {
    notifyNetworkStateChanged,
    reserveEndpoint,
    runEndpointReservation,
    waitForEndpointAvailability,
} from "../../src/pool/state.js";
import type { EndpointState, NetworkState } from "../../src/pool/state.js";
import { createPoolState } from "../helpers/pool-state.js";

function createNetwork(): NetworkState {
    const network = createPoolState([{
        chainId: 1,
        rpcUrls: ["https://first.example/", "https://second.example/"],
    }]).networks.get(1);

    if (network === undefined) {
        throw new Error("Expected test network");
    }

    return network;
}

function getEndpoints(network: NetworkState): readonly [EndpointState, EndpointState] {
    const first = network.endpoints[0];
    const second = network.endpoints[1];

    if (first === undefined || second === undefined) {
        throw new Error("Expected test endpoints");
    }

    return [first, second];
}

function createWaitOptions(timeoutMs: number, signal?: AbortSignal) {
    const options = {
        deadlineMs: Date.now() + timeoutMs,
        runtime: createRuntime({ monotonicNow: () => Date.now() }),
        timeoutMs,
    };
    return signal === undefined ? options : { ...options, signal };
}

describe("waitForEndpointAvailability", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("waits for the nearest cooldown without a busy loop", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const network = createNetwork();
        const [first, second] = getEndpoints(network);

        first.status = "cooling-down";
        first.cooldownUntil = 100;
        second.status = "cooling-down";
        second.cooldownUntil = 200;

        const waiting = waitForEndpointAvailability(network, createWaitOptions(500));
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(99);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);

        await expect(waiting).resolves.toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("fails immediately without a timer when every endpoint is excluded", async () => {
        vi.useFakeTimers();
        const network = createNetwork();

        for (const endpoint of network.endpoints) {
            endpoint.status = "excluded";
        }

        const waiting = waitForEndpointAvailability(network, createWaitOptions(500));
        await expect(waiting).rejects.toBeInstanceOf(NoUsableRpcEndpointError);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops at the operation deadline before a later recovery", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const network = createNetwork();

        for (const endpoint of network.endpoints) {
            endpoint.status = "cooling-down";
            endpoint.cooldownUntil = 200;
        }

        const waiting = waitForEndpointAvailability(network, createWaitOptions(50));
        const rejection = expect(waiting).rejects.toEqual(new OperationTimeoutError(1, 50));
        await vi.advanceTimersByTimeAsync(50);

        await rejection;
        expect(vi.getTimerCount()).toBe(0);
    });

    it("reacts to cancellation and preserves the signal reason", async () => {
        vi.useFakeTimers();
        const network = createNetwork();
        const controller = new AbortController();
        const reason = new Error("cancelled by caller");

        for (const endpoint of network.endpoints) {
            endpoint.status = "probe";
        }

        const waiting = waitForEndpointAvailability(network, createWaitOptions(500, controller.signal));
        controller.abort(reason);

        await expect(waiting).rejects.toBe(reason);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves the standard reason of a pre-aborted signal", async () => {
        vi.useFakeTimers();
        const network = createNetwork();
        const controller = new AbortController();
        controller.abort();

        const waiting = waitForEndpointAvailability(network, createWaitOptions(500, controller.signal));

        await expect(waiting).rejects.toBe(controller.signal.reason);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("reschedules on state changes and wakes when an endpoint becomes available", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const network = createNetwork();
        const [first] = getEndpoints(network);

        for (const endpoint of network.endpoints) {
            endpoint.status = "cooling-down";
            endpoint.cooldownUntil = 400;
        }

        const waiting = waitForEndpointAvailability(network, createWaitOptions(500));
        first.cooldownUntil = 100;
        notifyNetworkStateChanged(network);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(100);
        await expect(waiting).resolves.toBeUndefined();
    });

    it("wakes waiters when a successful probe releases its reservation", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(100);
        const network = createNetwork();
        const [first, second] = getEndpoints(network);

        first.status = "cooling-down";
        first.cooldownUntil = 100;
        second.status = "excluded";
        const reservation = reserveEndpoint(network, 100);
        if (reservation === null) {
            throw new Error("Expected probe reservation");
        }

        const waiting = waitForEndpointAvailability(network, createWaitOptions(500));
        await runEndpointReservation(network, reservation, () => Promise.resolve());

        await expect(waiting).resolves.toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });
});
