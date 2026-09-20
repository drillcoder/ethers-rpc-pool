import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcProvider } from "ethers";

import { RpcPoolManager } from "../../src/index.js";
import { createRpcTestServer, enqueueRpcResult, rpcRequestId } from "./rpc-server.js";
import type { RpcTestServer } from "./rpc-server.js";

interface FailureCase {
    readonly category: string;
    readonly error?: { readonly code: number; readonly message: string };
    readonly excluded: boolean;
    readonly headers?: Readonly<Record<string, string>>;
    readonly minimumCooldownMs?: number;
    readonly name: string;
    readonly status: number;
}

const cases: readonly FailureCase[] = [
    { category: "authorization", excluded: true, name: "HTTP 401", status: 401 },
    { category: "authorization", excluded: true, name: "HTTP 403", status: 403 },
    { category: "rate-limit", excluded: false, name: "HTTP 429", status: 429 },
    {
        category: "quota-limit",
        excluded: false,
        headers: { "retry-after": "120" },
        minimumCooldownMs: 120_000,
        name: "HTTP 402 with Retry-After seconds",
        status: 402,
    },
    { category: "http-5xx", excluded: false, name: "HTTP 503", status: 503 },
    {
        category: "authorization",
        error: { code: -32_000, message: "invalid API key" },
        excluded: true,
        name: "JSON-RPC authorization at HTTP 200",
        status: 200,
    },
    {
        category: "rate-limit",
        error: { code: -32_005, message: "rate limit exceeded" },
        excluded: false,
        name: "JSON-RPC rate limit at HTTP 200",
        status: 200,
    },
    {
        category: "quota-limit",
        error: { code: 402, message: "quota exceeded" },
        excluded: false,
        name: "JSON-RPC quota limit at HTTP 200",
        status: 200,
    },
];

describe("RPC transport failure matrix", () => {
    const servers: RpcTestServer[] = [];

    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => server.close()));
    });

    it.each(cases)("classifies and retries $name", async (failure) => {
        const first = await createRpcTestServer();
        const second = await createRpcTestServer();
        servers.push(first, second);
        enqueueRpcResult(first, "0x1");
        first.enqueue((request, response) => {
            const body = failure.error === undefined
                ? { id: rpcRequestId(request), jsonrpc: "2.0", result: "rejected" }
                : { error: failure.error, id: rpcRequestId(request), jsonrpc: "2.0" };
            response.json(body, {
                ...(failure.headers === undefined ? {} : { headers: failure.headers }),
                status: failure.status,
            });
        });
        enqueueRpcResult(second, "0x1");
        enqueueRpcResult(second, "0x2a");
        const startedAt = Date.now();
        const manager = new RpcPoolManager({
            networks: [{ chainId: 1, rpcUrls: [first.url, second.url] }],
            operationTimeoutMs: 2_000,
            requestTimeoutMs: 1_000,
        });
        const callback = vi.fn(async (client: JsonRpcProvider) => await client.getBlockNumber());

        await expect(manager.executeWithRetry(1, callback)).resolves.toBe(42);

        const failedEndpoint = manager.getSnapshot().networks[0]?.endpoints[0];
        expect(callback).toHaveBeenCalledTimes(2);
        expect(manager.getSnapshot().errorsByCategory).toEqual({ [failure.category]: 1 });
        expect(failedEndpoint).toMatchObject({
            excludedReason: failure.excluded ? "authorization" : null,
            status: failure.excluded ? "excluded" : "cooling-down",
        });
        if (failure.minimumCooldownMs !== undefined) {
            expect(failedEndpoint?.cooldownUntil).toBeGreaterThanOrEqual(startedAt + failure.minimumCooldownMs);
        }
        expect(first.requests).toHaveLength(2);
        expect(second.requests).toHaveLength(2);
        await manager.close();
    });

    it("uses an HTTP-date Retry-After as the minimum cooldown", async () => {
        const first = await createRpcTestServer();
        const second = await createRpcTestServer();
        servers.push(first, second);
        const retryAt = Date.now() + 120_000;
        enqueueRpcResult(first, "0x1");
        first.enqueue((request, response) => {
            response.json(
                { id: rpcRequestId(request), jsonrpc: "2.0", result: "limited" },
                { headers: { "retry-after": new Date(retryAt).toUTCString() }, status: 429 },
            );
        });
        enqueueRpcResult(second, "0x1");
        enqueueRpcResult(second, "0x2a");
        const manager = new RpcPoolManager({
            networks: [{ chainId: 1, rpcUrls: [first.url, second.url] }],
            operationTimeoutMs: 2_000,
            requestTimeoutMs: 1_000,
        });

        await expect(manager.executeWithRetry(1, async (client) => await client.getBlockNumber())).resolves.toBe(42);

        const failedEndpoint = manager.getSnapshot().networks[0]?.endpoints[0];
        expect(failedEndpoint?.cooldownUntil).toBeGreaterThanOrEqual(retryAt - 1_000);
        expect(manager.getSnapshot().errorsByCategory).toEqual({ "rate-limit": 1 });
        await manager.close();
    });
});
