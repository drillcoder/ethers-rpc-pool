import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcProvider } from "ethers";

import { RpcPoolManager } from "../../src/index.js";
import { EndpointJsonRpcProvider, RpcRequestTimeoutError } from "../../src/transport/provider.js";
import { createRpcTestServer, enqueueRpcResult } from "./rpc-server.js";
import type { RpcTestServer } from "./rpc-server.js";

describe("RPC network transport", () => {
    const servers: RpcTestServer[] = [];

    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => server.close()));
    });

    it("retries the callback on another endpoint after a connection is dropped", async () => {
        const first = await startServer(servers);
        const second = await startServer(servers);
        enqueueRpcResult(first, "0x1");
        first.enqueue((_request, response) => {
            response.disconnect();
        });
        enqueueRpcResult(second, "0x1");
        enqueueRpcResult(second, "0x2a");
        const manager = createManager([first.url, second.url]);
        const callback = vi.fn(async (client: JsonRpcProvider) => await client.getBlockNumber());

        await expect(manager.executeWithRetry(1, callback)).resolves.toBe(42);

        expect(callback).toHaveBeenCalledTimes(2);
        expect(first.requests).toHaveLength(2);
        expect(second.requests).toHaveLength(2);
        expect(manager.getSnapshot()).toMatchObject({
            errorsByCategory: { network: 1 },
            networks: [{ endpoints: [{ status: "cooling-down" }, { status: "available" }] }],
        });
        await manager.close();
    });

    it("aborts a hanging HTTP request when its request timeout expires", async () => {
        const server = await startServer(servers);
        enqueueRpcResult(server, "0x1");
        let responseClosed: Promise<void> | undefined;
        server.enqueue((_request, response) => {
            responseClosed = response.closed;
            response.hang();
        });
        const manager = createManager([server.url], 50);

        const failure = await manager.executeOnce(1, async (client) => await client.getBlockNumber())
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(RpcRequestTimeoutError);
        await expect(responseClosed).resolves.toBeUndefined();
        expect(server.requests).toHaveLength(2);
        expect(manager.getSnapshot()).toMatchObject({
            errorsByCategory: { timeout: 1 },
            networks: [{ endpoints: [{ status: "cooling-down" }] }],
        });
        await manager.close();
    });

    it("sends every payload separately without batching or hidden retries", async () => {
        const server = await startServer(servers);
        enqueueRpcResult(server, "0x1");
        enqueueRpcResult(server, "0x2");
        const provider = new EndpointJsonRpcProvider(server.url, 1, { requestTimeoutMs: 1_000 });

        await expect(provider._send([
            { id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
            { id: 2, jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
        ])).resolves.toEqual([
            { id: 1, jsonrpc: "2.0", result: "0x1" },
            { id: 2, jsonrpc: "2.0", result: "0x2" },
        ]);

        expect(server.requests).toHaveLength(2);
        expect(server.requests.every((request) => !Array.isArray(request.payload))).toBe(true);
        provider.destroy();
    });

    it("does not retry a disconnected single-attempt request", async () => {
        const server = await startServer(servers);
        enqueueRpcResult(server, "0x1");
        server.enqueue((_request, response) => {
            response.disconnect();
        });
        const manager = createManager([server.url]);
        const callback = vi.fn(async (client: JsonRpcProvider): Promise<unknown> => {
            return await client.send("eth_sendRawTransaction", ["0x01"]) as unknown;
        });

        await expect(manager.executeOnce(1, callback)).rejects.toThrow();

        expect(callback).toHaveBeenCalledOnce();
        expect(server.requests).toHaveLength(2);
        await manager.close();
    });
});

function createManager(rpcUrls: readonly string[], requestTimeoutMs = 1_000): RpcPoolManager {
    return new RpcPoolManager({
        networks: [{ chainId: 1, rpcUrls }],
        operationTimeoutMs: 2_000,
        requestTimeoutMs,
    });
}

async function startServer(servers: RpcTestServer[]): Promise<RpcTestServer> {
    const server = await createRpcTestServer();
    servers.push(server);
    return server;
}
