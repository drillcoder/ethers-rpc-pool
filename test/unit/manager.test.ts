import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationTimeoutError, RpcEndpointDataError, RpcPoolManager, UnknownNetworkError } from "../../src/index.js";
import type { RetryableRpcClient, RpcPoolManagerConfig, SingleAttemptRpcClient } from "../../src/index.js";

const config: RpcPoolManagerConfig = {
    networks: [{ chainId: 1, rpcUrls: ["https://rpc.example"] }],
    operationTimeoutMs: 100,
    requestTimeoutMs: 50,
};

function rpcResponse(init: RequestInit): Response {
    const payload = JSON.parse(init.body as string) as { id: number; method: string };
    const result = payload.method === "eth_chainId" ? "0x1" : "0x2a";
    return Response.json({ id: payload.id, jsonrpc: "2.0", result });
}

function requestUrl(input: string | URL | Request): string {
    return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("RpcPoolManager operation entry points", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("shares network verification between both explicit execution modes", async () => {
        const request = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {})));
        vi.stubGlobal("fetch", request);
        const manager = new RpcPoolManager(config);

        await expect(manager.executeWithRetry(1, () => Promise.resolve("retryable"))).resolves.toBe("retryable");
        await expect(manager.executeOnce(1, async (client) => await client.getBlockNumber())).resolves.toBe(42);

        const methods = request.mock.calls.map(([, init]) =>
            (JSON.parse(init?.body as string) as { method: string }).method);
        expect(methods).toEqual(["eth_chainId", "eth_blockNumber"]);
    });

    it("rejects an unknown network before invoking the callback", async () => {
        const callback = vi.fn(() => Promise.resolve());
        const manager = new RpcPoolManager(config);

        await expect(manager.executeOnce(2, callback)).rejects.toEqual(new UnknownNetworkError(2));
        expect(callback).not.toHaveBeenCalled();
    });

    it("uses a local timeout as the whole operation budget even when it exceeds the default", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager({ ...config, operationTimeoutMs: 10 });
        const operation = manager.executeWithRetry(
            1,
            async () => await new Promise<string>((resolve) => {
                setTimeout(() => {
                    resolve("done");
                }, 20);
            }),
            { timeoutMs: 30 },
        );

        await vi.advanceTimersByTimeAsync(20);
        await expect(operation).resolves.toBe("done");
    });

    it("rejects when the single absolute deadline expires during the callback", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager(config);
        const operation = manager.executeOnce(1, async () => await new Promise<never>(() => undefined), {
            timeoutMs: 25,
        });
        const rejection = expect(operation).rejects.toEqual(new OperationTimeoutError(1, 25));

        await vi.advanceTimersByTimeAsync(25);
        await rejection;
    });

    it("rejects an invalid local timeout before invoking the callback", async () => {
        const callback = vi.fn(() => Promise.resolve());
        const manager = new RpcPoolManager(config);

        await expect(manager.executeWithRetry(1, callback, { timeoutMs: 0 })).rejects.toThrow(
            new RangeError("timeoutMs must be a positive safe integer"),
        );
        expect(callback).not.toHaveBeenCalled();
    });

    it("passes through a callback failure", async () => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager(config);
        const failure = new Error("callback failed");

        await expect(manager.executeOnce(1, () => Promise.reject(failure))).rejects.toBe(failure);
    });

    it("deactivates a retryable client when its callback finishes", async () => {
        const request = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {})));
        vi.stubGlobal("fetch", request);
        const manager = new RpcPoolManager(config);
        const client = await manager.executeWithRetry(1, (selected) => Promise.resolve(selected));

        await expect(client.getBlockNumber()).rejects.toThrow("RPC client attempt is no longer active");
        expect(request).toHaveBeenCalledOnce();
    });

    it("restarts the whole callback on another endpoint after a retryable client failure", async () => {
        const calls = new Map<string, string[]>();
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const endpoint = requestUrl(input);
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            const methods = calls.get(endpoint) ?? [];
            methods.push(payload.method);
            calls.set(endpoint, methods);
            if (endpoint.includes("first") && methods.length === 3) {
                return Promise.reject(new TypeError("connection reset"));
            }
            const result = payload.method === "eth_chainId" ? "0x1" : "0x1";
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });
        const callback = vi.fn<(client: RetryableRpcClient) => Promise<bigint[]>>(async (client) => [
            await client.getBalance("0x0000000000000000000000000000000000000001"),
            await client.getBalance("0x0000000000000000000000000000000000000002"),
        ]);

        await expect(manager.executeWithRetry(1, callback)).resolves.toEqual([1n, 1n]);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(calls.get("https://first.example/")).toEqual(["eth_chainId", "eth_getBalance", "eth_getBalance"]);
        expect(calls.get("https://second.example/")).toEqual(["eth_chainId", "eth_getBalance", "eth_getBalance"]);
    });

    it("retries the callback after RpcEndpointDataError but passes through an arbitrary callback error", async () => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });
        const dataCallback = vi.fn()
            .mockRejectedValueOnce(new RpcEndpointDataError("inconsistent response"))
            .mockResolvedValueOnce("valid response");

        await expect(manager.executeWithRetry(1, dataCallback)).resolves.toBe("valid response");
        expect(dataCallback).toHaveBeenCalledTimes(2);

        const failure = new Error("domain failure");
        const domainCallback = vi.fn(() => Promise.reject(failure));
        await expect(manager.executeWithRetry(1, domainCallback)).rejects.toBe(failure);
        expect(domainCallback).toHaveBeenCalledOnce();
    });

    it("switches endpoints after chain verification failure without starting the single callback twice", async () => {
        const methods = new Map<string, string[]>();
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const endpoint = requestUrl(input);
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            methods.set(endpoint, [...(methods.get(endpoint) ?? []), payload.method]);
            if (endpoint.includes("first")) {
                return Promise.reject(new TypeError("chain check failed"));
            }
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });
        const callback = vi.fn(() => Promise.resolve("done"));

        await expect(manager.executeOnce(1, callback)).resolves.toBe("done");
        expect(callback).toHaveBeenCalledOnce();
        expect(methods.get("https://first.example/")).toEqual(["eth_chainId"]);
        expect(methods.get("https://second.example/")).toEqual(["eth_chainId"]);
    });

    it("returns a started single-attempt transport failure without retrying its callback or request", async () => {
        const failure = new TypeError("response lost");
        const methods = new Map<string, string[]>();
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const endpoint = requestUrl(input);
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            methods.set(endpoint, [...(methods.get(endpoint) ?? []), payload.method]);
            if (payload.method === "eth_sendRawTransaction") {
                return Promise.reject(failure);
            }
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });
        const callback = vi.fn<(client: SingleAttemptRpcClient) => Promise<unknown>>(
            async (client) => {
                await client.send("eth_sendRawTransaction", ["0x01"]);
            },
        );

        await expect(manager.executeOnce(1, callback)).rejects.toBe(failure);
        expect(callback).toHaveBeenCalledOnce();
        expect(methods.get("https://first.example/")).toEqual(["eth_chainId", "eth_sendRawTransaction"]);
        expect(methods.has("https://second.example/")).toBe(false);
    });

    it("cools endpoint data failures without retrying a started single callback", async () => {
        const endpoints: string[] = [];
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const endpoint = requestUrl(input);
            endpoints.push(endpoint);
            return Promise.resolve(rpcResponse(init ?? {}));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });
        const failure = new RpcEndpointDataError("invalid response");
        const callback = vi.fn(() => Promise.reject(failure));

        await expect(manager.executeOnce(1, callback)).rejects.toBe(failure);
        expect(callback).toHaveBeenCalledOnce();
        await manager.executeOnce(1, async (client) => {
            await client.send("debug_custom", []);
        });
        expect(endpoints).toEqual([
            "https://first.example/",
            "https://second.example/",
            "https://second.example/",
        ]);
    });
});
