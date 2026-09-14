import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationTimeoutError, RpcPoolManager, UnknownNetworkError } from "../../src/index.js";
import type { RpcPoolManagerConfig } from "../../src/index.js";

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
});
