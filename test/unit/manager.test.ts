import { afterEach, describe, expect, it, vi } from "vitest";

import {
    NoUsableRpcEndpointError,
    OperationTimeoutError,
    RpcEndpointDataError,
    RpcPoolClosedError,
    RpcPoolManager,
    UnknownNetworkError,
} from "../../src/index.js";
import { EndpointJsonRpcProvider, RpcTransportResponseError } from "../../src/transport/provider.js";
import type {
    RetryableRpcClient,
    RpcExecutionOptions,
    RpcPoolLoggerEvent,
    RpcPoolManagerConfig,
    SingleAttemptRpcClient,
} from "../../src/index.js";

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

function deferred<Value>(): {
    readonly promise: Promise<Value>;
    readonly reject: (reason: unknown) => void;
    readonly resolve: (value: Value) => void;
} {
    let reject!: (reason: unknown) => void;
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
        reject = rejectPromise;
        resolve = resolvePromise;
    });
    return { promise, reject, resolve };
}

function executeInMode<Result>(
    manager: RpcPoolManager,
    mode: "retry" | "once",
    callback: (client: RetryableRpcClient | SingleAttemptRpcClient) => Promise<Result>,
    options: RpcExecutionOptions,
): Promise<Result> {
    return mode === "retry"
        ? manager.executeWithRetry(1, callback, options)
        : manager.executeOnce(1, callback, options);
}

describe("RpcPoolManager operation entry points", () => {
    afterEach(() => {
        vi.restoreAllMocks();
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

    it("returns an immutable snapshot with counters, endpoint state, and masked identifiers", async () => {
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            if (new URL(requestUrl(input)).hostname === "first.example") {
                return Promise.resolve(Response.json(
                    { id: payload.id, jsonrpc: "2.0", result: "unavailable" },
                    { status: 503 },
                ));
            }
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x2a" }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{
                chainId: 1,
                rpcUrls: [
                    "https://user:password@first.example/secret/token?apiKey=value#fragment",
                    "https://second.example/rpc",
                ],
            }],
        });

        await expect(manager.executeWithRetry(1, async (client) => await client.getBlockNumber())).resolves.toBe(42);
        const snapshot = manager.getSnapshot();
        const firstEndpoint = snapshot.networks[0]?.endpoints[0];
        const secondEndpoint = snapshot.networks[0]?.endpoints[1];

        expect(firstEndpoint?.cooldownUntil).toBeTypeOf("number");
        expect(firstEndpoint?.latencyEwmaMs).toBeTypeOf("number");
        expect(secondEndpoint?.latencyEwmaMs).toBeTypeOf("number");

        expect(snapshot).toEqual({
            closed: false,
            errorsByCategory: { "http-5xx": 1 },
            networks: [{
                chainId: 1,
                endpoints: [
                    {
                        activeGroups: 0,
                        cooldownUntil: firstEndpoint?.cooldownUntil,
                        endpointId: "https://first.example/[redacted]/[redacted]",
                        endpointNumber: 1,
                        errorCount: 1,
                        excludedReason: null,
                        latencyEwmaMs: firstEndpoint?.latencyEwmaMs,
                        requestCount: 2,
                        status: "cooling-down",
                    },
                    {
                        activeGroups: 0,
                        cooldownUntil: null,
                        endpointId: "https://second.example/rpc",
                        endpointNumber: 2,
                        errorCount: 0,
                        excludedReason: null,
                        latencyEwmaMs: secondEndpoint?.latencyEwmaMs,
                        requestCount: 2,
                        status: "available",
                    },
                ],
            }],
            requestsByMethod: { eth_blockNumber: 2, eth_chainId: 2 },
            totalActiveGroups: 0,
            totalRequests: 4,
        });
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.networks)).toBe(true);
        expect(Object.isFrozen(snapshot.networks[0]?.endpoints)).toBe(true);
        expect(() => {
            (snapshot as { totalRequests: number }).totalRequests = 0;
        }).toThrow(TypeError);
        expect(manager.getSnapshot().totalRequests).toBe(4);
    });

    it("reports active groups while an operation is running", async () => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager(config);
        const callbackStarted = deferred<undefined>();
        const callbackFinished = deferred<undefined>();
        const operation = manager.executeOnce(1, async () => {
            callbackStarted.resolve(undefined);
            await callbackFinished.promise;
        });
        await callbackStarted.promise;

        expect(manager.getSnapshot().totalActiveGroups).toBe(1);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.activeGroups).toBe(1);

        callbackFinished.resolve(undefined);
        await operation;
    });

    it("shares active-group selection and counters between concurrent consumers", async () => {
        const firstStarted = deferred<undefined>();
        const secondStarted = deferred<undefined>();
        const releaseCallbacks = deferred<undefined>();
        const requests: string[] = [];
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            requests.push(`${new URL(requestUrl(input)).hostname}:${payload.method}`);
            return Promise.resolve(rpcResponse(init ?? {}));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{
                chainId: 1,
                rpcUrls: ["https://first.example", "https://second.example"],
            }],
        });
        const first = manager.executeOnce(1, async (client) => {
            await client.send("debug_first", []);
            firstStarted.resolve(undefined);
            await releaseCallbacks.promise;
        });
        await firstStarted.promise;
        const second = manager.executeOnce(1, async (client) => {
            await client.send("debug_second", []);
            secondStarted.resolve(undefined);
            await releaseCallbacks.promise;
        });
        await secondStarted.promise;

        expect(manager.getSnapshot()).toMatchObject({
            networks: [{ endpoints: [{ activeGroups: 1 }, { activeGroups: 1 }] }],
            requestsByMethod: { debug_first: 1, debug_second: 1, eth_chainId: 2 },
            totalActiveGroups: 2,
            totalRequests: 4,
        });
        expect(requests).toEqual([
            "first.example:eth_chainId",
            "first.example:debug_first",
            "second.example:eth_chainId",
            "second.example:debug_second",
        ]);

        releaseCallbacks.resolve(undefined);
        await Promise.all([first, second]);
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        await manager.close();
    });

    it("keeps health, counters, and selection independent between identically configured managers", async () => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const firstManager = new RpcPoolManager(config);
        const secondManager = new RpcPoolManager(config);

        await expect(firstManager.executeOnce(1, () => Promise.reject(new RpcEndpointDataError())))
            .rejects.toBeInstanceOf(RpcEndpointDataError);
        expect(firstManager.getSnapshot()).toMatchObject({
            errorsByCategory: { "endpoint-data": 1 },
            networks: [{ endpoints: [{ errorCount: 1, requestCount: 1, status: "cooling-down" }] }],
            totalRequests: 1,
        });
        expect(secondManager.getSnapshot()).toMatchObject({
            errorsByCategory: {},
            networks: [{ endpoints: [{ errorCount: 0, requestCount: 0, status: "available" }] }],
            totalRequests: 0,
        });

        await expect(secondManager.executeOnce(1, () => Promise.resolve("available"))).resolves.toBe("available");
        expect(secondManager.getSnapshot()).toMatchObject({
            networks: [{ endpoints: [{ requestCount: 1, status: "available" }] }],
            totalRequests: 1,
        });
        expect(firstManager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("cooling-down");
        await Promise.all([firstManager.close(), secondManager.close()]);
    });

    it("logs transport, cooldown, and switch events with safe endpoint identifiers", async () => {
        const events: RpcPoolLoggerEvent[] = [];
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            if (new URL(requestUrl(input)).hostname === "first.example") {
                return Promise.resolve(Response.json(
                    { id: payload.id, jsonrpc: "2.0", result: "limited" },
                    { headers: { "retry-after": "2" }, status: 429 },
                ));
            }
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x2a" }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            logger: (event) => {
                events.push(event);
            },
            networks: [{
                chainId: 1,
                rpcUrls: [
                    "https://user:password@first.example/v3/0123456789abcdef0123456789abcdef?token=secret",
                    "https://second.example/rpc",
                ],
            }],
        });

        await manager.executeWithRetry(1, async (client) => await client.getBlockNumber());

        expect(events.map(({ type }) => type)).toEqual([
            "request",
            "response",
            "request",
            "error",
            "cooldown",
            "switch",
            "request",
            "response",
            "request",
            "response",
        ]);
        expect(events.find(({ type }) => type === "error")).toMatchObject({
            category: "rate-limit",
            endpointId: "https://first.example/v3/[redacted]",
            httpStatus: 429,
            method: "eth_blockNumber",
            retryAfterMs: 2_000,
        });
        expect(events.find(({ type }) => type === "switch")).toMatchObject({
            category: "rate-limit",
            endpointNumber: 1,
            nextEndpointId: "https://second.example/rpc",
            nextEndpointNumber: 2,
        });
        expect(events.find(({ type }) => type === "cooldown")).toMatchObject({
            category: "rate-limit",
            endpointNumber: 1,
        });
        expect(JSON.stringify(events)).not.toContain("password");
        expect(JSON.stringify(events)).not.toContain("token=secret");
    });

    it("logs recovery after a successful probe", async () => {
        vi.useFakeTimers();
        const events: RpcPoolLoggerEvent[] = [];
        let blockRequests = 0;
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            blockRequests += 1;
            return blockRequests === 1
                ? Promise.reject(new TypeError("connection reset"))
                : Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x2a" }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            logger: (event) => {
                events.push(event);
            },
            operationTimeoutMs: 10_000,
        });
        const operation = manager.executeWithRetry(1, async (client) => await client.getBlockNumber());

        await vi.waitFor(() => {
            expect(events.some(({ type }) => type === "cooldown")).toBe(true);
        });
        const cooldown = events.find((event) => event.type === "cooldown");
        if (cooldown?.type !== "cooldown") {
            throw new Error("Expected cooldown event");
        }
        await vi.advanceTimersByTimeAsync(Math.ceil(cooldown.cooldownUntil - Date.now()) + 1);

        await expect(operation).resolves.toBe(42);
        expect(events.some(({ type }) => type === "recovery")).toBe(true);
    });

    it("ignores synchronous logger exceptions without changing a successful result or endpoint state", async () => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager({
            ...config,
            logger: (event) => {
                if (event.type === "response") {
                    throw new Error("logger failed");
                }
            },
        });

        await expect(manager.executeOnce(1, async (client) => await client.getBlockNumber())).resolves.toBe(42);
        expect(manager.getSnapshot()).toMatchObject({
            errorsByCategory: {},
            networks: [{ endpoints: [{ requestCount: 2, status: "available" }] }],
            totalRequests: 2,
        });
    });

    it("handles rejected logger promises without producing an unhandled rejection", async () => {
        const unhandledRejection = vi.fn();
        process.on("unhandledRejection", unhandledRejection);
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager({
            ...config,
            logger: (event) => event.type === "response"
                ? Promise.reject(new Error("logger failed"))
                : Promise.resolve(),
        });

        try {
            await expect(manager.executeOnce(1, async (client) => await client.getBlockNumber())).resolves.toBe(42);
            await Promise.resolve();
            expect(unhandledRejection).not.toHaveBeenCalled();
        } finally {
            process.off("unhandledRejection", unhandledRejection);
        }
    });

    it("closes active requests, destroys providers once, and rejects new operations", async () => {
        const requestStarted = deferred<undefined>();
        let requestSignal: AbortSignal | undefined;
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                requestSignal = init?.signal ?? undefined;
                requestStarted.resolve(undefined);
                requestSignal?.addEventListener("abort", () => {
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve reason.
                    reject(requestSignal?.reason);
                }, { once: true });
            })));
        const destroy = vi.spyOn(EndpointJsonRpcProvider.prototype, "destroy");
        const callback = vi.fn(() => Promise.resolve());
        const manager = new RpcPoolManager(config);
        const operation = manager.executeOnce(1, callback);
        await requestStarted.promise;

        const firstClose = manager.close();
        const secondClose = manager.close();

        expect(secondClose).toBe(firstClose);
        await expect(firstClose).resolves.toBeUndefined();
        await expect(operation).rejects.toBeInstanceOf(RpcPoolClosedError);
        expect(requestSignal?.aborted).toBe(true);
        expect(requestSignal?.reason).toBeInstanceOf(RpcPoolClosedError);
        expect(callback).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledOnce();
        expect(manager.getSnapshot()).toMatchObject({ closed: true, totalActiveGroups: 0 });
        await expect(manager.executeOnce(1, callback)).rejects.toBeInstanceOf(RpcPoolClosedError);
        expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it("clears operation and cooldown wait timers when closed", async () => {
        vi.useFakeTimers();
        const cooldownStarted = deferred<undefined>();
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            return payload.method === "eth_chainId"
                ? Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }))
                : Promise.reject(new TypeError("connection reset"));
        }));
        const manager = new RpcPoolManager({
            ...config,
            logger: (event) => {
                if (event.type === "cooldown") {
                    cooldownStarted.resolve(undefined);
                }
            },
            operationTimeoutMs: 10_000,
        });
        const operation = manager.executeWithRetry(1, async (client) => await client.getBlockNumber());
        await vi.advanceTimersByTimeAsync(10);
        await cooldownStarted.promise;
        await Promise.resolve();
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("cooling-down");
        const timerCountBeforeClose = vi.getTimerCount();

        await manager.close();

        await expect(operation).rejects.toBeInstanceOf(RpcPoolClosedError);
        expect(timerCountBeforeClose - vi.getTimerCount()).toBeGreaterThanOrEqual(2);
    });

    it("rejects an unknown network before invoking the callback", async () => {
        const callback = vi.fn(() => Promise.resolve());
        const manager = new RpcPoolManager(config);

        await expect(manager.executeOnce(2, callback)).rejects.toEqual(new UnknownNetworkError(2));
        expect(callback).not.toHaveBeenCalled();
    });

    it("rejects immediately when chain verification permanently excludes the last endpoint", async () => {
        const request = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number };
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x2" }));
        });
        vi.stubGlobal("fetch", request);
        const callback = vi.fn(() => Promise.resolve());
        const manager = new RpcPoolManager(config);

        await expect(manager.executeOnce(1, callback)).rejects.toEqual(new NoUsableRpcEndpointError(1));
        await expect(manager.executeWithRetry(1, callback)).rejects.toEqual(new NoUsableRpcEndpointError(1));
        expect(callback).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledOnce();
        expect(manager.getSnapshot().networks[0]?.endpoints[0]).toMatchObject({
            cooldownUntil: null,
            excludedReason: "chain-id-mismatch",
            status: "excluded",
        });
        await manager.close();
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

    it("shares one budget between chain verification and the callback", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((resolve) => {
                setTimeout(() => {
                    resolve(rpcResponse(init ?? {}));
                }, 20);
            })));
        const manager = new RpcPoolManager(config);
        const callback = vi.fn(async () => await new Promise<never>(() => undefined));
        const operation = manager.executeWithRetry(1, callback, { timeoutMs: 30 });
        const rejection = expect(operation).rejects.toEqual(new OperationTimeoutError(1, 30));

        await vi.advanceTimersByTimeAsync(20);
        expect(callback).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(9);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        await vi.advanceTimersByTimeAsync(1);

        await rejection;
    });

    it("keeps the original budget across retries and cooldown waiting", async () => {
        vi.useFakeTimers();
        const methods = new Map<string, string[]>();
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const endpoint = requestUrl(input);
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            methods.set(endpoint, [...(methods.get(endpoint) ?? []), payload.method]);
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            return Promise.reject(new TypeError("connection reset"));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });
        const callback = vi.fn(async (client: RetryableRpcClient) => await client.getBlockNumber());
        const operation = manager.executeWithRetry(1, callback, { timeoutMs: 40 });
        const rejection = expect(operation).rejects.toEqual(new OperationTimeoutError(1, 40));

        await vi.advanceTimersByTimeAsync(39);
        expect(callback).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);

        await rejection;
        expect(methods.get("https://first.example/")).toEqual(["eth_chainId", "eth_blockNumber"]);
        expect(methods.get("https://second.example/")).toEqual(["eth_chainId", "eth_blockNumber"]);
    });

    it.each(["retry", "once"] as const)("deactivates the %s client when its callback times out", async (mode) => {
        vi.useFakeTimers();
        const request = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {})));
        vi.stubGlobal("fetch", request);
        const manager = new RpcPoolManager(config);
        let selectedClient: RetryableRpcClient | SingleAttemptRpcClient | undefined;
        const callback = vi.fn(async (client: RetryableRpcClient | SingleAttemptRpcClient) => {
            selectedClient = client;
            return await new Promise<never>(() => undefined);
        });
        const operation = executeInMode(manager, mode, callback, { timeoutMs: 25 });
        const rejection = expect(operation).rejects.toEqual(new OperationTimeoutError(1, 25));

        await vi.advanceTimersByTimeAsync(25);

        await rejection;
        await expect(selectedClient?.getBlockNumber()).rejects.toThrow("RPC client attempt is no longer active");
        expect(request).toHaveBeenCalledOnce();
    });

    it.each(["retry", "once"] as const)("preserves abort reason during a %s callback", async (mode) => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager(config);
        const controller = new AbortController();
        const reason = new Error("consumer cancelled");
        let selectedClient: RetryableRpcClient | SingleAttemptRpcClient | undefined;
        const callback = vi.fn(async (client: RetryableRpcClient | SingleAttemptRpcClient) => {
            selectedClient = client;
            return await new Promise<never>(() => undefined);
        });
        const operation = executeInMode(manager, mode, callback, { signal: controller.signal });

        await vi.waitFor(() => {
            expect(callback).toHaveBeenCalledOnce();
        });
        controller.abort(reason);

        await expect(operation).rejects.toBe(reason);
        await expect(selectedClient?.getBlockNumber()).rejects.toThrow("RPC client attempt is no longer active");
    });

    it.each(["retry", "once"] as const)("preserves a pre-aborted reason in %s mode", async (mode) => {
        const request = vi.fn();
        vi.stubGlobal("fetch", request);
        const manager = new RpcPoolManager(config);
        const controller = new AbortController();
        const reason = Symbol("cancelled");
        const callback = vi.fn(() => Promise.resolve());
        controller.abort(reason);

        const operation = executeInMode(manager, mode, callback, { signal: controller.signal });

        await expect(operation).rejects.toBe(reason);
        expect(callback).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it.each(["retry", "once"] as const)("aborts an active request in %s mode", async (mode) => {
        let requestSignal: AbortSignal | undefined;
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            requestSignal = init?.signal ?? undefined;
            return new Promise<Response>((_resolve, reject) => {
                requestSignal?.addEventListener("abort", () => {
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Mirror fetch.
                    reject(requestSignal?.reason);
                }, { once: true });
            });
        }));
        const manager = new RpcPoolManager(config);
        const controller = new AbortController();
        const reason = new Error("request cancelled");
        const callback = vi.fn(async (client: RetryableRpcClient | SingleAttemptRpcClient) =>
            await client.getBlockNumber());
        const operation = executeInMode(manager, mode, callback, { signal: controller.signal });

        await vi.waitFor(() => {
            expect(requestSignal).toBeDefined();
        });
        controller.abort(reason);

        await expect(operation).rejects.toBe(reason);
        expect(requestSignal?.aborted).toBe(true);
        expect(requestSignal?.reason).toBe(reason);
        expect(callback).toHaveBeenCalledOnce();
    });

    it.each([
        ["retry", "resolve"],
        ["retry", "reject"],
        ["once", "resolve"],
        ["once", "reject"],
    ] as const)("absorbs a late %s mode callback %s", async (mode, settlement) => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager(config);
        const controller = new AbortController();
        const reason = new Error("cancelled");
        const late = deferred<string>();
        const callback = vi.fn(() => late.promise);
        const operation = executeInMode(manager, mode, callback, { signal: controller.signal });

        await vi.waitFor(() => {
            expect(callback).toHaveBeenCalledOnce();
        });
        controller.abort(reason);
        await expect(operation).rejects.toBe(reason);

        if (settlement === "resolve") {
            late.resolve("too late");
        } else {
            late.reject(new RpcEndpointDataError("too late"));
        }
        await Promise.resolve();

        await expect(manager.executeOnce(1, () => Promise.resolve("available"))).resolves.toBe("available");
    });

    it.each(["retry", "once"] as const)("absorbs a late callback rejection after %s timeout", async (mode) => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager(config);
        const late = deferred<string>();
        const callback = vi.fn(() => late.promise);
        const operation = executeInMode(manager, mode, callback, { timeoutMs: 25 });
        const rejection = expect(operation).rejects.toEqual(new OperationTimeoutError(1, 25));

        await vi.advanceTimersByTimeAsync(25);
        await rejection;
        late.reject(new RpcEndpointDataError("too late"));
        await Promise.resolve();

        await expect(manager.executeOnce(1, () => Promise.resolve("available"))).resolves.toBe("available");
    });

    it.each(["retry", "once"] as const)("absorbs a late transport rejection in %s mode", async (mode) => {
        const late = deferred<Response>();
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            return payload.method === "eth_chainId"
                ? Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }))
                : late.promise;
        }));
        const manager = new RpcPoolManager(config);
        const controller = new AbortController();
        const reason = new Error("cancelled");
        const callback = vi.fn(async (client: RetryableRpcClient | SingleAttemptRpcClient) =>
            await client.getBlockNumber());
        const operation = executeInMode(manager, mode, callback, { signal: controller.signal });

        await vi.waitFor(() => {
            expect(callback).toHaveBeenCalledOnce();
        });
        controller.abort(reason);
        await expect(operation).rejects.toBe(reason);
        late.reject(new TypeError("late connection failure"));
        await Promise.resolve();

        await expect(manager.executeOnce(1, () => Promise.resolve("available"))).resolves.toBe("available");
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

    it.each([
        ["invalid parameters", -32_602, "invalid params"],
        ["unsupported methods", -32_601, "method not found"],
        ["contract execution", 3, "execution reverted"],
    ])("passes through %s failures without retry or cooldown", async (_category, code, message) => {
        for (const mode of ["retry", "once"] as const) {
            const methods: string[] = [];
            const request = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
                const payload = JSON.parse(init?.body as string) as { id: number; method: string };
                methods.push(payload.method);
                if (payload.method === "eth_chainId") {
                    return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
                }
                return Promise.resolve(Response.json({
                    error: { code, message },
                    id: payload.id,
                    jsonrpc: "2.0",
                }));
            });
            vi.stubGlobal("fetch", request);
            const manager = new RpcPoolManager(config);
            const callback = vi.fn(async (client: RetryableRpcClient | SingleAttemptRpcClient) =>
                await client.getBlockNumber());
            const failure = await (mode === "retry"
                ? manager.executeWithRetry(1, callback)
                : manager.executeOnce(1, callback)
            ).catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(RpcTransportResponseError);
            expect(failure).toMatchObject({ jsonRpcError: { code, message }, status: 200 });
            expect(callback).toHaveBeenCalledOnce();
            expect(methods).toEqual(["eth_chainId", "eth_blockNumber"]);
            await expect(manager.executeOnce(1, () => Promise.resolve("available"))).resolves.toBe("available");
        }
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

    it("deactivates a single-attempt client when its callback finishes", async () => {
        const request = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {})));
        vi.stubGlobal("fetch", request);
        const manager = new RpcPoolManager(config);
        const client = await manager.executeOnce(1, (selected) => Promise.resolve(selected));

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
            const result = payload.method === "eth_chainId"
                ? "0x1"
                : endpoint.includes("first") ? "0xa" : methods.length === 2 ? "0x14" : "0x15";
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });
        const clients: RetryableRpcClient[] = [];
        const firstResults: bigint[] = [];
        const callback = vi.fn(async (client: RetryableRpcClient): Promise<bigint[]> => {
            clients.push(client);
            const first = await client.getBalance("0x0000000000000000000000000000000000000001");
            firstResults.push(first);
            const second = await client.getBalance("0x0000000000000000000000000000000000000002");
            return [first, second];
        });

        await expect(manager.executeWithRetry(1, callback)).resolves.toEqual([20n, 21n]);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(firstResults).toEqual([10n, 20n]);
        for (const client of clients) {
            await expect(client.getBlockNumber()).rejects.toThrow("RPC client attempt is no longer active");
        }
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

    it("rejects an obsolete single-attempt call without transport or callback restart", async () => {
        const methods: string[] = [];
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            methods.push(payload.method);
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
        }));
        const manager = new RpcPoolManager(config);
        let resumeFirst: (() => void) | undefined;
        let reportFirstCall: (() => void) | undefined;
        const firstCall = new Promise<void>((resolve) => {
            reportFirstCall = resolve;
        });
        const pause = new Promise<void>((resolve) => {
            resumeFirst = resolve;
        });
        const callback = vi.fn<(client: SingleAttemptRpcClient) => Promise<void>>(async (client) => {
            await client.send("debug_first", []);
            reportFirstCall?.();
            await pause;
            await client.send("debug_second", []);
        });
        const operation = manager.executeOnce(1, callback);

        await firstCall;
        await expect(manager.executeOnce(1, () => Promise.reject(new RpcEndpointDataError()))).rejects
            .toBeInstanceOf(RpcEndpointDataError);
        resumeFirst?.();

        await expect(operation).rejects.toThrow("Reserved RPC endpoint is no longer available");
        expect(callback).toHaveBeenCalledOnce();
        expect(methods).toEqual(["eth_chainId", "debug_first"]);
    });
});
