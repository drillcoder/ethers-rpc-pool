import { Wallet, Transaction } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RpcBroadcastError, RpcPoolManager } from "../../src/index.js";
import type { RpcPoolLoggerEvent } from "../../src/index.js";
import { createRpcTestServer, enqueueRpcResult, rpcRequestId } from "./rpc-server.js";
import type { RpcServerResponse, RpcTestServer } from "./rpc-server.js";

const signedTx = await new Wallet("0x" + "11".repeat(32)).signTransaction({
    chainId: 1,
    gasLimit: 21_000,
    gasPrice: 1,
});
const hash = Transaction.from(signedTx).hash;
function gate<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((done) => { resolve = done; });
    return { promise, resolve };
}

describe("parallel broadcast HTTP transport", () => {
    const servers: RpcTestServer[] = [];
    const managers: RpcPoolManager[] = [];
    afterEach(async () => {
        await Promise.all(managers.splice(0).map((manager) => manager.close()));
        await Promise.all(servers.splice(0).map((server) => server.close()));
    });

    async function setup(): Promise<{
        pool: RpcPoolManager;
        first: RpcTestServer;
        second: RpcTestServer;
        events: RpcPoolLoggerEvent[];
    }> {
        const first = await createRpcTestServer(); servers.push(first);
        const second = await createRpcTestServer(); servers.push(second);
        enqueueRpcResult(first, "0x1"); enqueueRpcResult(second, "0x1");
        const events: RpcPoolLoggerEvent[] = [];
        const pool = new RpcPoolManager({
            networks: [{ chainId: 1, rpcUrls: [first.url, second.url] }],
            requestTimeoutMs: 1_000,
            operationTimeoutMs: 2_000,
            logger: (event) => { events.push(event); },
        });
        managers.push(pool);
        return { pool, first, second, events };
    }

    function assertRequests(first: RpcTestServer, second: RpcTestServer): void {
        for (const server of [first, second]) {
            expect(server.requests.map(({ payload }) => payload)).toEqual([
                { id: 1, jsonrpc: "2.0", method: "eth_chainId", params: [] },
                { id: 2, jsonrpc: "2.0", method: "eth_sendRawTransaction", params: [signedTx] },
            ]);
        }
    }

    it("starts both real sends before accepting the first and aborts the hanging sibling after success", async () => {
        const { pool, first, second, events } = await setup();
        const started = gate<RpcServerResponse>();
        first.enqueue(async (request, response) => {
            await started.promise;
            response.json({ id: rpcRequestId(request), jsonrpc: "2.0", result: hash });
        });
        second.enqueue((_request, response) => { started.resolve(response); response.hang(); });
        const controller = new AbortController();
        await expect(pool.broadcastTransaction(1, signedTx, { signal: controller.signal })).resolves.toBe(hash);
        assertRequests(first, second);
        expect(pool.getSnapshot().totalActiveGroups).toBe(1);
        expect(pool.getSnapshot().totalRequests).toBe(4);
        controller.abort(new Error("stop residual send"));
        await (await started.promise).closed;
        expect(pool.getSnapshot().totalActiveGroups).toBe(0);
        expect(pool.getSnapshot().networks[0]?.endpoints.every(({ status }) => status === "available")).toBe(true);
        expect(events.filter(({ type }) => type === "request")).toHaveLength(4);
    });

    it("applies a late authorization failure even after returning the accepted hash", async () => {
        const { pool, first, second, events } = await setup();
        const later = gate<undefined>();
        const excluded = gate<undefined>();
        // An observational logger error event precedes pool exclusion; wait for HTTP completion as well.
        enqueueRpcResult(first, hash);
        second.enqueue(async (request, response) => {
            await later.promise;
            response.json({
                id: rpcRequestId(request),
                jsonrpc: "2.0",
                error: { code: -32000, message: "already known" },
            }, { status: 401 });
            await response.closed;
            excluded.resolve(undefined);
        });
        await expect(pool.broadcastTransaction(1, signedTx)).resolves.toBe(hash);
        later.resolve(undefined); await excluded.promise;
        await vi.waitFor(() => {
            expect(pool.getSnapshot().networks[0]?.endpoints[1]?.excludedReason).toBe("authorization");
        });
        expect(pool.getSnapshot().totalActiveGroups).toBe(0);
        expect(pool.getSnapshot().errorsByCategory.authorization).toBe(1);
        expect(events.find((event) => event.type === "error" && event.endpointNumber === 2)).toMatchObject({
            category: "authorization",
            httpStatus: 401,
            method: "eth_sendRawTransaction",
        });
        assertRequests(first, second);
    });

    it("preserves rejection versus lost-response uncertainty without extra requests", async () => {
        const { pool, first, second } = await setup();
        first.enqueue((request, response) => {
            response.json({
                id: rpcRequestId(request),
                jsonrpc: "2.0",
                error: { code: -32000, message: "nonce too low" },
            });
        });
        second.enqueue((_request, response) => { response.disconnect(); });
        const error: unknown = await pool.broadcastTransaction(1, signedTx).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(RpcBroadcastError);
        if (!(error instanceof RpcBroadcastError)) throw new Error("Expected broadcast error");
        expect(error.hash).toBe(hash);
        expect(error.failures.map(({ outcome }) => outcome)).toEqual(["rejected", "unknown"]);
        expect(pool.getSnapshot().networks[0]?.endpoints.map(({ status }) => status)).toEqual([
            "available",
            "cooling-down",
        ]);
        assertRequests(first, second);
    });

    it("aborts all in-flight real HTTP sends on close without endpoint cooldown", async () => {
        const { pool, first, second } = await setup();
        const firstStarted = gate<RpcServerResponse>(); const secondStarted = gate<RpcServerResponse>();
        first.enqueue((_request, response) => { firstStarted.resolve(response); response.hang(); });
        second.enqueue((_request, response) => { secondStarted.resolve(response); response.hang(); });
        const operation = pool.broadcastTransaction(1, signedTx);
        const rejection = expect(operation).rejects.toMatchObject({ name: "RpcPoolClosedError" });
        const responses = await Promise.all([firstStarted.promise, secondStarted.promise]);
        await pool.close(); await rejection;
        await Promise.all(responses.map(({ closed }) => closed));
        expect(pool.getSnapshot().totalActiveGroups).toBe(0);
        expect(pool.getSnapshot().networks[0]?.endpoints.every(({ status }) => status === "available")).toBe(true);
        assertRequests(first, second);
    });
});
