import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcProvider } from "ethers";

import { RpcPoolManager } from "../../src/index.js";
import { createRpcTestServer, enqueueRpcResult, rpcRequestId } from "./rpc-server.js";
import type { RpcTestServer } from "./rpc-server.js";

describe("RPC chain ID verification", () => {
    const servers: RpcTestServer[] = [];

    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => server.close()));
    });

    it("accepts a matching chain ID and caches the successful verification", async () => {
        const server = await startServer(servers);
        enqueueRpcResult(server, "0x1");
        enqueueRpcResult(server, "0x2a");
        enqueueRpcResult(server, "0x2b");
        const manager = createManager([server.url]);

        await expect(manager.executeWithRetry(1, async (client) => await client.getBalance(
            "0x0000000000000000000000000000000000000001",
        ))).resolves.toBe(42n);
        await expect(manager.executeWithRetry(1, async (client) => await client.getBalance(
            "0x0000000000000000000000000000000000000002",
        ))).resolves.toBe(43n);

        expect(methods(server)).toEqual(["eth_chainId", "eth_getBalance", "eth_getBalance"]);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("available");
        await manager.close();
    });

    it("permanently excludes only the endpoint with a mismatching chain ID", async () => {
        const mismatching = await startServer(servers);
        const matching = await startServer(servers);
        enqueueRpcResult(mismatching, "0x2");
        enqueueRpcResult(matching, "0x1");
        enqueueRpcResult(matching, "0x2a");
        const manager = createManager([mismatching.url, matching.url]);
        const callback = vi.fn(async (client: JsonRpcProvider) => await client.getBlockNumber());

        await expect(manager.executeWithRetry(1, callback)).resolves.toBe(42);

        expect(callback).toHaveBeenCalledOnce();
        expect(methods(mismatching)).toEqual(["eth_chainId"]);
        expect(methods(matching)).toEqual(["eth_chainId", "eth_blockNumber"]);
        expect(manager.getSnapshot().networks[0]?.endpoints).toMatchObject([
            { cooldownUntil: null, excludedReason: "chain-id-mismatch", status: "excluded" },
            { excludedReason: null, status: "available" },
        ]);
        await manager.close();
    });

    it("cools a temporarily unavailable chain ID endpoint and continues with another endpoint", async () => {
        const unavailable = await startServer(servers);
        const matching = await startServer(servers);
        unavailable.enqueue((request, response) => {
            response.json(
                { id: rpcRequestId(request), jsonrpc: "2.0", result: "temporarily unavailable" },
                { status: 503 },
            );
        });
        enqueueRpcResult(matching, "0x1");
        enqueueRpcResult(matching, "0x2a");
        const manager = createManager([unavailable.url, matching.url]);
        const callback = vi.fn(async (client: JsonRpcProvider) => await client.getBlockNumber());

        await expect(manager.executeWithRetry(1, callback)).resolves.toBe(42);

        expect(callback).toHaveBeenCalledOnce();
        expect(methods(unavailable)).toEqual(["eth_chainId"]);
        expect(manager.getSnapshot()).toMatchObject({
            errorsByCategory: { "http-5xx": 1 },
            networks: [{ endpoints: [
                { excludedReason: null, status: "cooling-down" },
                { excludedReason: null, status: "available" },
            ] }],
        });
        await manager.close();
    });
});

function createManager(rpcUrls: readonly string[]): RpcPoolManager {
    return new RpcPoolManager({
        networks: [{ chainId: 1, rpcUrls }],
        operationTimeoutMs: 2_000,
        requestTimeoutMs: 1_000,
    });
}

function methods(server: RpcTestServer): unknown[] {
    return server.requests.map((request) => {
        return typeof request.payload === "object" && request.payload !== null && "method" in request.payload
            ? request.payload.method
            : null;
    });
}

async function startServer(servers: RpcTestServer[]): Promise<RpcTestServer> {
    const server = await createRpcTestServer();
    servers.push(server);
    return server;
}
