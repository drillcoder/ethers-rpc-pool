import { JsonRpcProvider } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
    EndpointJsonRpcProvider,
    getRpcFailure,
    RpcRequestTimeoutError,
    RpcTransportResponseError,
} from "../../src/transport/provider.js";
import type { HttpRequest } from "../../src/transport/provider.js";
import type {
    RuntimeDependencies,
    TimerHandle,
} from "../../src/pool/runtime.js";

const rpcUrl = "https://rpc.example/";

function jsonResponse(result: unknown, id: number): Response {
    return Response.json({ id, jsonrpc: "2.0", result });
}

function providerOptions(request: HttpRequest) {
    return {
        request,
        requestTimeoutMs: 1_000,
    };
}

describe("EndpointJsonRpcProvider", () => {
    it.each([
        ["empty object", {}],
        ["array", []],
        ["null", null],
        ["primitive", 7],
        ["foreign id", { id: 2, jsonrpc: "2.0", result: "ok" }],
        ["string id", { id: "1", jsonrpc: "2.0", result: "ok" }],
        ["wrong version", { id: 1, jsonrpc: "1.0", result: "ok" }],
        ["both result and error", { error: { code: -1, message: "bad" }, id: 1, jsonrpc: "2.0", result: null }],
        ["null error", { error: null, id: 1, jsonrpc: "2.0" }],
        ["invalid error", { error: { code: "-1", message: 3 }, id: 1, jsonrpc: "2.0" }],
    ])("rejects an invalid JSON-RPC envelope: %s", async (_name, body) => {
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, providerOptions(() => Promise.resolve(
            Response.json(body),
        )));

        const error = await provider._send({
            id: 1,
            jsonrpc: "2.0",
            method: "test",
            params: [],
        }).catch((reason: unknown) => reason);

        expect(error).toMatchObject({ invalidResponse: true, status: 200 });
        expect(getRpcFailure(error)).toMatchObject({ action: "cooldown", category: "endpoint-data" });
        provider.destroy();
    });

    it.each([null, false, 0, "", [], { value: true }])("accepts a JSON-RPC result value %#", async (result) => {
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, providerOptions(() => Promise.resolve(
            jsonResponse(result, 1),
        )));

        await expect(provider.send("test", [])).resolves.toEqual(result);
        provider.destroy();
    });

    it("rejects invalid JSON as endpoint data without recording a response", async () => {
        const observer = { onError: vi.fn(), onRequest: vi.fn(), onResponse: vi.fn() };
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, {
            ...providerOptions(() => Promise.resolve(new Response("not json"))),
            observer,
        });

        const error = await provider.send("test", []).catch((reason: unknown) => reason);

        expect(getRpcFailure(error)).toMatchObject({ category: "endpoint-data", httpStatus: 200 });
        expect(observer.onRequest).toHaveBeenCalledOnce();
        expect(observer.onError).toHaveBeenCalledOnce();
        expect(observer.onResponse).not.toHaveBeenCalled();
        provider.destroy();
    });

    it("rejects every transport entry point locally after destroy", async () => {
        const request = vi.fn<HttpRequest>();
        const observer = { onError: vi.fn(), onRequest: vi.fn(), onResponse: vi.fn() };
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, { ...providerOptions(request), observer });
        provider.destroy();

        await expect(provider.send("test", [])).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
        await expect(provider.getBlockNumber()).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
        await expect(provider._send({ id: 8, jsonrpc: "2.0", method: "test", params: [] }))
            .rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
        expect(request).not.toHaveBeenCalled();
        expect(observer.onRequest).not.toHaveBeenCalled();
        expect(observer.onError).not.toHaveBeenCalled();
    });

    it("uses the normal ethers error path for responses not produced by its transport", () => {
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, providerOptions(() => Promise.resolve(
            jsonResponse("0x1", 1),
        )));
        const error = provider.getRpcError(
            { id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
            { error: { code: -32_601, message: "method not found" }, id: 1 },
        );

        expect(error).toBeInstanceOf(Error);
        expect(getRpcFailure(error)).toBeUndefined();
        provider.destroy();
    });

    it("forwards an already aborted operation signal to the request", async () => {
        const controller = new AbortController();
        const reason = new Error("already aborted");
        controller.abort(reason);
        const request = vi.fn<HttpRequest>(() => Promise.reject(reason));
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, providerOptions(request));

        await expect(provider.runWithDeadline(
            performance.now() + 1_000,
            async () => await provider.getBlockNumber(),
            controller.signal,
        )).rejects.toBe(reason);
        expect(request).not.toHaveBeenCalled();
        provider.destroy();
    });

    it("uses the environment fetch implementation by default", async () => {
        const request = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(jsonResponse("0x2a", 1));
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, {
            requestTimeoutMs: 1_000,
        });

        await expect(provider.getBlockNumber()).resolves.toBe(42);
        expect(request).toHaveBeenCalledOnce();

        provider.destroy();
        request.mockRestore();
    });

    it("is ethers-compatible and sends one client call as one HTTP request", async () => {
        const request = vi.fn<HttpRequest>(() =>
            Promise.resolve(jsonResponse("0x2a", 1)),
        );
        const provider = new EndpointJsonRpcProvider(
            rpcUrl,
            1,
            providerOptions(request),
        );

        await expect(provider.getBlockNumber()).resolves.toBe(42);

        expect(provider).toBeInstanceOf(EndpointJsonRpcProvider);
        expect(provider).toBeInstanceOf(JsonRpcProvider);
        expect(provider._getOption("batchMaxCount")).toBe(1);
        expect(request).toHaveBeenCalledOnce();
        expect(request.mock.calls[0]?.[0]).toBe(rpcUrl);
        expect(request.mock.calls[0]?.[1].body).toContain(
            '"method":"eth_blockNumber"',
        );
        expect(request.mock.calls[0]?.[1].method).toBe("POST");

        provider.destroy();
    });

    it("sends every explicitly supplied payload in its own request without retry", async () => {
        const request = vi
            .fn<HttpRequest>()
            .mockResolvedValueOnce(jsonResponse("0x1", 1))
            .mockResolvedValueOnce(jsonResponse("0x2", 2));
        const provider = new EndpointJsonRpcProvider(
            rpcUrl,
            1,
            providerOptions(request),
        );

        await expect(
            provider._send([
                { id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
                { id: 2, jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
            ]),
        ).resolves.toEqual([
            { id: 1, jsonrpc: "2.0", result: "0x1" },
            { id: 2, jsonrpc: "2.0", result: "0x2" },
        ]);

        expect(request).toHaveBeenCalledTimes(2);
        for (const call of request.mock.calls) {
            expect(JSON.parse(call[1].body as string)).not.toBeInstanceOf(Array);
        }

        provider.destroy();
    });

    it("does not retry a failed HTTP request", async () => {
        const failure = new Error("connection lost");
        const request = vi.fn<HttpRequest>().mockRejectedValueOnce(failure);
        const provider = new EndpointJsonRpcProvider(
            rpcUrl,
            1,
            providerOptions(request),
        );

        await expect(
            provider._send({
                id: 1,
                jsonrpc: "2.0",
                method: "eth_blockNumber",
                params: [],
            }),
        ).rejects.toBe(failure);
        expect(request).toHaveBeenCalledOnce();

        provider.destroy();
    });

    it("preserves provenance only for the exact RPC error object", async () => {
        const failure = new TypeError("connection reset");
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, providerOptions(() => Promise.reject(failure)));
        const origin = await provider.send("eth_blockNumber", []).catch((reason: unknown) => reason);
        expect(getRpcFailure(origin)).toMatchObject({ action: "cooldown", category: "network" });
        expect(getRpcFailure(new Error("wrapper", { cause: origin }))).toBeUndefined();
        expect(getRpcFailure(new Error("local"))).toBeUndefined();
        const cyclic: { cause?: unknown } = {};
        cyclic.cause = cyclic;
        expect(getRpcFailure(cyclic)).toBeUndefined();
        provider.destroy();
    });

    it("passes through a primitive transport rejection without inventing provenance", async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Exercise an arbitrary fetch rejection.
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, providerOptions(() => Promise.reject("offline")));
        await expect(provider.send("eth_blockNumber", [])).rejects.toBe("offline");
        expect(getRpcFailure("offline")).toBeUndefined();
        provider.destroy();
    });

    it("preserves HTTP status and headers before ethers handles the response", async () => {
        const request = vi.fn<HttpRequest>(() =>
            Promise.resolve(
                Response.json(
                    { id: 1, jsonrpc: "2.0", result: "accepted" },
                    {
                        headers: {
                            "retry-after": "30",
                            "x-request-id": "request-1",
                        },
                        status: 429,
                    },
                ),
            ),
        );
        const provider = new EndpointJsonRpcProvider(
            rpcUrl,
            1,
            providerOptions(request),
        );

        await expect(
            provider._send({
                id: 1,
                jsonrpc: "2.0",
                method: "eth_blockNumber",
                params: [],
            }),
        ).rejects.toMatchObject({
            headers: {
                "retry-after": "30",
                "x-request-id": "request-1",
            },
            jsonRpcError: undefined,
            status: 429,
        });

        const error = await provider
            ._send({
                id: 2,
                jsonrpc: "2.0",
                method: "eth_blockNumber",
                params: [],
            })
            .catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(RpcTransportResponseError);
        expect(
            Object.isFrozen((error as RpcTransportResponseError).headers),
        ).toBe(true);

        provider.destroy();
    });

    it("preserves a JSON-RPC error body on a non-success HTTP response", async () => {
        const rpcError = { code: -32_005, message: "rate limited" };
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, providerOptions(() => Promise.resolve(
            Response.json({ error: rpcError, id: 1, jsonrpc: "2.0" }, { status: 429 }),
        )));

        await expect(provider.send("eth_blockNumber", [])).rejects.toMatchObject({
            jsonRpcError: rpcError,
            status: 429,
        });
        provider.destroy();
    });

    it("preserves JSON-RPC error fields from a successful HTTP response", async () => {
        const rpcError = {
            code: -32_000,
            data: { retryAfter: 15 },
            message: "rate limit exceeded",
        };
        const request = vi.fn<HttpRequest>(() =>
            Promise.resolve(
                Response.json({
                    error: rpcError,
                    id: 1,
                    jsonrpc: "2.0",
                }),
            ),
        );
        const provider = new EndpointJsonRpcProvider(
            rpcUrl,
            1,
            providerOptions(request),
        );

        const error = await provider.send("eth_blockNumber", []).catch((reason: unknown) => reason);
        expect(getRpcFailure(error)).toEqual({
            action: "cooldown",
            category: "rate-limit",
            httpStatus: 200,
        });

        provider.destroy();
    });

    it("retains HTTP metadata when the response body is not JSON", async () => {
        const request = vi.fn<HttpRequest>(() =>
            Promise.resolve(
                new Response("temporarily unavailable", {
                    headers: { "retry-after": "5" },
                    status: 503,
                }),
            ),
        );
        const provider = new EndpointJsonRpcProvider(
            rpcUrl,
            1,
            providerOptions(request),
        );

        const result = await provider
            ._send({
                id: 1,
                jsonrpc: "2.0",
                method: "eth_blockNumber",
                params: [],
            })
            .catch((reason: unknown) => reason);

        expect(result).toMatchObject({
            headers: { "retry-after": "5" },
            jsonRpcError: undefined,
            status: 503,
        });
        expect((result as RpcTransportResponseError).cause).toBeInstanceOf(
            SyntaxError,
        );

        provider.destroy();
    });

    it("uses the smaller remaining operation budget as the request timeout", async () => {
        const timerHandle = {} as TimerHandle;
        const setTimeout = vi.fn(() => timerHandle);
        const clearTimeout = vi.fn();
        const runtime: Partial<RuntimeDependencies> = {
            clearTimeout,
            monotonicNow: () => 750,
            setTimeout,
        };
        const request = vi.fn<HttpRequest>(() =>
            Promise.resolve(jsonResponse("0x2a", 1)),
        );
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, {
            request,
            requestTimeoutMs: 1_000,
            runtime,
        });

        await expect(
            provider.runWithDeadline(1_000, async () => await provider.getBlockNumber()),
        ).resolves.toBe(42);

        expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
        expect(clearTimeout).toHaveBeenCalledWith(timerHandle);
        expect(request.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);

        provider.destroy();
    });

    it("uses requestTimeoutMs when the operation has more time remaining", async () => {
        const setTimeout = vi.fn(globalThis.setTimeout);
        const clearTimeout = vi.fn(globalThis.clearTimeout);
        const request = vi.fn<HttpRequest>(() =>
            Promise.resolve(jsonResponse("0x2a", 1)),
        );
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, {
            request,
            requestTimeoutMs: 100,
            runtime: {
                clearTimeout,
                monotonicNow: () => 0,
                setTimeout,
            },
        });

        await expect(
            provider.runWithDeadline(1_000, async () => await provider.getBlockNumber()),
        ).resolves.toBe(42);

        expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 100);
        expect(clearTimeout).toHaveBeenCalledOnce();

        provider.destroy();
    });

    it("refuses to start a request after the operation deadline", async () => {
        const request = vi.fn<HttpRequest>();
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, {
            request,
            requestTimeoutMs: 1_000,
            runtime: {
                monotonicNow: () => 1_000,
            },
        });

        await expect(
            provider.runWithDeadline(
                1_000,
                async () =>
                    await provider._send({
                        id: 1,
                        jsonrpc: "2.0",
                        method: "eth_blockNumber",
                        params: [],
                    }),
            ),
        ).rejects.toEqual(new RpcRequestTimeoutError(0));
        expect(request).not.toHaveBeenCalled();

        provider.destroy();
    });

    it("aborts a pending request when its timeout expires", async () => {
        let fireTimeout = (): void => undefined;
        const timerHandle = {} as TimerHandle;
        const request = vi.fn<HttpRequest>(
            (_input, init) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener("abort", () => {
                        reject(init.signal?.reason as Error);
                    });
                }),
        );
        const clearTimeout = vi.fn();
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, {
            request,
            requestTimeoutMs: 100,
            runtime: {
                clearTimeout,
                monotonicNow: () => 0,
                setTimeout: (callback) => {
                    fireTimeout = callback;
                    return timerHandle;
                },
            },
        });

        const result = provider._send({
            id: 1,
            jsonrpc: "2.0",
            method: "eth_blockNumber",
            params: [],
        });
        fireTimeout();

        await expect(result).rejects.toEqual(new RpcRequestTimeoutError(100));
        expect(request.mock.calls[0]?.[1].signal?.aborted).toBe(true);
        expect(request.mock.calls[0]?.[1].signal?.reason).toEqual(
            new RpcRequestTimeoutError(100),
        );
        expect(clearTimeout).toHaveBeenCalledWith(timerHandle);

        provider.destroy();
    });

    it("rejects transport when the reservation becomes stale", async () => {
        const request = vi.fn<HttpRequest>();
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, providerOptions(request));

        await expect(provider.runWithDeadline(
            Number.POSITIVE_INFINITY,
            async () => await provider.send("eth_blockNumber", []),
            undefined,
            () => false,
        )).rejects.toThrow("Reserved RPC endpoint is no longer available");
        expect(request).not.toHaveBeenCalled();
        provider.destroy();
    });

    it("aborts an unawaited request when its attempt context closes", async () => {
        let pending: Promise<unknown> | undefined;
        const request = vi.fn<HttpRequest>((_input, init) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
                reject(init.signal?.reason as Error);
            }, { once: true });
        }));
        const provider = new EndpointJsonRpcProvider(rpcUrl, 1, providerOptions(request));

        await provider.runWithDeadline(Number.POSITIVE_INFINITY, () => {
            pending = provider.send("eth_blockNumber", []);
            return Promise.resolve();
        });
        await expect(pending).rejects.toThrow("context is no longer active");
        expect(request).toHaveBeenCalledOnce();
        provider.destroy();
    });
});
