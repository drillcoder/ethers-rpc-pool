import { describe, expect, it, vi } from "vitest";

import {
    createEndpointCounters,
    createRpcCounters,
    recordRpcError,
    recordRpcRequest,
} from "../../src/observability/counters.js";
import { EndpointJsonRpcProvider } from "../../src/transport/provider.js";
import type { HttpRequest, RpcTransportObserver } from "../../src/transport/provider.js";

describe("RPC counters", () => {
    it("accumulates total, per-method, per-endpoint, and categorized-error counters", () => {
        const counters = createRpcCounters();
        const first = createEndpointCounters();
        const second = createEndpointCounters();

        recordRpcRequest(counters, first, "eth_chainId");
        recordRpcRequest(counters, first, "eth_blockNumber");
        recordRpcError(counters, first, "network");
        recordRpcRequest(counters, second, "eth_blockNumber");
        recordRpcError(counters, second, "rate-limit");

        expect(counters).toEqual({
            errorsByCategory: new Map([
                ["network", 1],
                ["rate-limit", 1],
            ]),
            requestsByMethod: new Map([
                ["eth_chainId", 1],
                ["eth_blockNumber", 2],
            ]),
            totalRequests: 3,
        });
        expect(first).toEqual({ errorCount: 1, requestCount: 2 });
        expect(second).toEqual({ errorCount: 1, requestCount: 1 });
    });

    it("observes every started transport request and its failure exactly once", async () => {
        const failure = new TypeError("connection reset");
        const request = vi.fn<HttpRequest>().mockRejectedValue(failure);
        const onError = vi.fn();
        const onRequest = vi.fn();
        const observer: RpcTransportObserver = {
            onError,
            onRequest,
            onResponse: vi.fn(),
        };
        const provider = new EndpointJsonRpcProvider("https://rpc.example", 1, {
            observer,
            request,
            requestTimeoutMs: 1_000,
        });

        await expect(provider.send("eth_chainId", [])).rejects.toBe(failure);

        expect(onRequest).toHaveBeenCalledOnce();
        expect(onRequest).toHaveBeenCalledWith("eth_chainId", expect.any(Number));
        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(
            "eth_chainId",
            failure,
            { action: "cooldown", category: "network", httpStatus: null },
            expect.any(Number),
            expect.any(Number),
            expect.any(Number),
        );
        provider.destroy();
    });
});
