import { afterEach, describe, expect, it } from "vitest";

import { createRpcTestServer } from "./rpc-server.js";
import type { RpcTestServer } from "./rpc-server.js";

describe("local RPC test server", () => {
    let server: RpcTestServer | undefined;

    afterEach(async () => {
        await server?.close();
    });

    it("serves queued responses and records JSON-RPC requests without external networking", async () => {
        server = await createRpcTestServer();
        server.enqueue((request, response) => {
            response.json({ id: 1, jsonrpc: "2.0", result: "0x1" }, {
                headers: { "retry-after": "30" },
                status: 429,
            });
        });

        const result = await fetch(server.url, {
            body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_chainId", params: [] }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        expect(result.status).toBe(429);
        expect(result.headers.get("retry-after")).toBe("30");
        await expect(result.json()).resolves.toEqual({ id: 1, jsonrpc: "2.0", result: "0x1" });
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]?.payload).toEqual({
            id: 1,
            jsonrpc: "2.0",
            method: "eth_chainId",
            params: [],
        });
    });

    it("uses handlers in order and fails an unexpected request", async () => {
        server = await createRpcTestServer();
        server.enqueue((_request, response) => {
            response.json({ result: "first" });
        });
        server.enqueue((_request, response) => {
            response.json({ result: "second" });
        });

        const first = await fetch(server.url, { method: "POST", body: "{}" });
        const second = await fetch(server.url, { method: "POST", body: "{}" });
        const unexpected = await fetch(server.url, { method: "POST", body: "{}" });

        await expect(first.json()).resolves.toEqual({ result: "first" });
        await expect(second.json()).resolves.toEqual({ result: "second" });
        expect(unexpected.status).toBe(500);
        await expect(unexpected.json()).resolves.toEqual({ error: "No RPC server handler was queued" });
        expect(server.requests).toHaveLength(3);
    });

    it("can disconnect a request and close while a response is intentionally hanging", async () => {
        server = await createRpcTestServer();
        server.enqueue((_request, response) => {
            response.disconnect();
        });
        server.enqueue((_request, response) => {
            response.hang();
        });

        await expect(fetch(server.url, { method: "POST", body: "{}" })).rejects.toThrow();
        const hangingRequest = fetch(server.url, { method: "POST", body: "{}" });
        await waitForRequestCount(server, 2);
        await server.close();
        server = undefined;

        await expect(hangingRequest).rejects.toThrow();
    });
});

async function waitForRequestCount(server: RpcTestServer, count: number): Promise<void> {
    while (server.requests.length < count) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}
