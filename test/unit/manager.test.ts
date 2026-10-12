import { Wallet, keccak256 } from "ethers";
import type { JsonRpcProvider } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    NoUsableRpcEndpointError,
    OperationTimeoutError,
    RpcEndpointDataError,
    RpcPoolClosedError,
    RpcPoolManager,
    UnknownNetworkError,
} from "../../src/index.js";
import { EndpointJsonRpcProvider, getRpcErrorResponse } from "../../src/transport/provider.js";
import type {
    RpcExecutionOptions,
    RpcPoolLoggerEvent,
    RpcPoolManagerConfig,
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
    callback: (client: JsonRpcProvider) => Promise<Result>,
    options: RpcExecutionOptions,
): Promise<Result> {
    return mode === "retry"
        ? manager.executeWithRetry(1, callback, options)
        : manager.executeOnce(1, callback, options);
}

async function coolDownOnlyEndpoint(manager: RpcPoolManager): Promise<void> {
    const operation = manager.executeOnce(1, () => Promise.reject(new RpcEndpointDataError("invalid data")));
    const rejection = expect(operation).rejects.toBeInstanceOf(RpcEndpointDataError);
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
}

async function createManagerDuringCooldown(): Promise<RpcPoolManager> {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(rpcResponse(init ?? {}))));
    const manager = new RpcPoolManager({ ...config, operationTimeoutMs: 10_000 });
    await coolDownOnlyEndpoint(manager);
    return manager;
}

async function createCooledEndpointManager(): Promise<RpcPoolManager> {
    const manager = await createManagerDuringCooldown();
    await vi.advanceTimersByTimeAsync(5_000);
    return manager;
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

    it("returns an immutable snapshot with counters, endpoint state, and hostnames", async () => {
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
                        hostname: "first.example",
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
                        hostname: "second.example",
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

    it("reports exact standard URL hostnames without changing full-URL deduplication", async () => {
        const manager = new RpcPoolManager({
            ...config,
            networks: [{
                chainId: 1,
                rpcUrls: [
                    "https://user:password@customer123.rpc.example.com:9443/key?token=value#fragment",
                    "http://localhost:8545/rpc",
                    "http://127.0.0.1:8545/a",
                    "http://[::1]:8545/a",
                    "https://customer123.rpc.example.com/other",
                ],
            }],
        });

        expect(manager.getSnapshot().networks[0]?.endpoints.map(({ hostname }) => hostname)).toEqual([
            "customer123.rpc.example.com",
            "localhost",
            "127.0.0.1",
            "[::1]",
            "customer123.rpc.example.com",
        ]);
        await manager.close();
    });

    it("reports exact request counters and latency EWMA in its snapshot", async () => {
        vi.useFakeTimers();
        let requestNumber = 0;
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            requestNumber += 1;
            const delayMs = requestNumber === 1 ? 10 : 30;
            return new Promise<Response>((resolve) => {
                setTimeout(() => {
                    resolve(rpcResponse(init ?? {}));
                }, delayMs);
            });
        }));
        const manager = new RpcPoolManager(config);
        const operation = manager.executeOnce(1, async (client) => await client.getBlockNumber());

        await vi.advanceTimersByTimeAsync(10);
        await vi.advanceTimersByTimeAsync(10);
        expect(requestNumber).toBe(2);
        await vi.advanceTimersByTimeAsync(30);

        await expect(operation).resolves.toBe(42);
        expect(manager.getSnapshot()).toMatchObject({
            errorsByCategory: {},
            networks: [{ endpoints: [{ errorCount: 0, latencyEwmaMs: 14, requestCount: 2 }] }],
            requestsByMethod: { eth_blockNumber: 1, eth_chainId: 1 },
            totalRequests: 2,
        });
        await manager.close();
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
            operationTimeoutMs: 10_000,
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
            networks: [{ endpoints: [{ activeGroups: 2 }, { activeGroups: 0 }] }],
            requestsByMethod: { debug_first: 1, debug_second: 1, eth_chainId: 1 },
            totalActiveGroups: 2,
            totalRequests: 3,
        });
        expect(requests).toEqual([
            "first.example:eth_chainId",
            "first.example:debug_first",
            "first.example:debug_second",
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

    it("logs transport, cooldown, and switch events with hostnames", async () => {
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
            hostname: "first.example",
            httpStatus: 429,
            method: "eth_blockNumber",
            retryAfterMs: 2_000,
        });
        expect(events.find(({ type }) => type === "switch")).toMatchObject({
            category: "rate-limit",
            endpointNumber: 1,
            nextHostname: "second.example",
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
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });
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
        expect(destroy).toHaveBeenCalledTimes(2);
        expect(new Set(destroy.mock.instances)).toHaveLength(2);
        expect(manager.getSnapshot()).toMatchObject({ closed: true, totalActiveGroups: 0 });
        await expect(manager.executeOnce(1, callback)).rejects.toBeInstanceOf(RpcPoolClosedError);
        expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it("prevents a saved provider from sending after close", async () => {
        const request = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {})));
        vi.stubGlobal("fetch", request);
        const manager = new RpcPoolManager(config);
        let savedProvider: JsonRpcProvider | undefined;
        await manager.executeOnce(1, (provider) => {
            savedProvider = provider;
            return Promise.resolve();
        });
        const requestsBeforeClose = request.mock.calls.length;

        await manager.close();

        await expect(savedProvider?.getBlockNumber()).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
        await expect(manager.executeOnce(1, () => Promise.resolve())).rejects.toBeInstanceOf(RpcPoolClosedError);
        expect(request).toHaveBeenCalledTimes(requestsBeforeClose);
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
        const callback = vi.fn(async (client: JsonRpcProvider) => await client.getBlockNumber());
        const operation = manager.executeWithRetry(1, callback, { timeoutMs: 40 });
        const rejection = expect(operation).rejects.toEqual(new OperationTimeoutError(1, 40));

        await vi.advanceTimersByTimeAsync(39);
        expect(callback).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);

        await rejection;
        expect(methods.get("https://first.example/")).toEqual(["eth_chainId", "eth_blockNumber"]);
        expect(methods.get("https://second.example/")).toEqual(["eth_chainId", "eth_blockNumber"]);
    });

    it("waits for the nearest cooldown after every endpoint temporarily fails", async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0);
        const cooldowns: number[] = [];
        const blockRequests = new Map<string, number>();
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const endpoint = requestUrl(input);
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            const requestCount = (blockRequests.get(endpoint) ?? 0) + 1;
            blockRequests.set(endpoint, requestCount);
            return requestCount === 1
                ? Promise.reject(new TypeError("connection reset"))
                : Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x2a" }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            logger: (event) => {
                if (event.type === "cooldown") {
                    cooldowns.push(event.cooldownUntil);
                }
            },
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
            operationTimeoutMs: 10_000,
        });
        const callback = vi.fn(async (client: JsonRpcProvider) => await client.getBlockNumber());
        const operation = manager.executeWithRetry(1, callback);
        await vi.advanceTimersByTimeAsync(100);
        expect(cooldowns).toHaveLength(2);
        const nearestCooldown = Math.min(...cooldowns);

        await vi.advanceTimersByTimeAsync(nearestCooldown - Date.now() - 1);
        expect(callback).toHaveBeenCalledTimes(2);
        expect([...blockRequests.values()]).toEqual([1, 1]);
        await vi.advanceTimersByTimeAsync(11);

        await expect(operation).resolves.toBe(42);
        expect(callback).toHaveBeenCalledTimes(3);
        expect([...blockRequests.values()].sort()).toEqual([1, 2]);
        await manager.close();
    });

    it("stops selecting an endpoint immediately after its first request timeout", async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0);
        const timedRequestStarted = deferred<undefined>();
        const methods = new Map<string, string[]>();
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const endpoint = requestUrl(input);
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            methods.set(endpoint, [...(methods.get(endpoint) ?? []), payload.method]);
            if (payload.method === "eth_chainId" || endpoint.includes("second")) {
                return Promise.resolve(rpcResponse(init ?? {}));
            }
            return new Promise<Response>((_resolve, reject) => {
                timedRequestStarted.resolve(undefined);
                init?.signal?.addEventListener("abort", () => {
                    reject(init.signal?.reason as Error);
                }, { once: true });
            });
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
            operationTimeoutMs: 1_000,
            requestTimeoutMs: 25,
        });
        const operation = manager.executeWithRetry(1, async (client) => await client.getBlockNumber());
        await vi.advanceTimersByTimeAsync(10);
        await timedRequestStarted.promise;
        await vi.advanceTimersByTimeAsync(25);

        await expect(operation).resolves.toBe(42);
        expect(methods.get("https://first.example/")).toEqual(["eth_chainId", "eth_blockNumber"]);
        expect(methods.get("https://second.example/")).toEqual(["eth_chainId", "eth_blockNumber"]);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]).toMatchObject({
            status: "cooling-down",
        });
        await manager.close();
    });

    it("permits exactly one concurrent probe group after cooldown", async () => {
        const manager = await createCooledEndpointManager();

        const probeStarted = deferred<undefined>();
        const releaseProbe = deferred<undefined>();
        const callback = vi.fn(async () => {
            if (callback.mock.calls.length === 1) {
                probeStarted.resolve(undefined);
                await releaseProbe.promise;
            }
            return "complete";
        });
        const first = manager.executeOnce(1, callback);
        await probeStarted.promise;
        const second = manager.executeOnce(1, callback);
        await Promise.resolve();

        expect(callback).toHaveBeenCalledOnce();
        expect(manager.getSnapshot()).toMatchObject({
            networks: [{ endpoints: [{ activeGroups: 1, status: "probe" }] }],
            totalActiveGroups: 1,
        });

        releaseProbe.resolve(undefined);
        await expect(first).resolves.toBe("complete");
        await expect(second).resolves.toBe("complete");
        expect(callback).toHaveBeenCalledTimes(2);
        expect(manager.getSnapshot()).toMatchObject({
            networks: [{ endpoints: [{ activeGroups: 0, status: "available" }] }],
            totalActiveGroups: 0,
        });
        await manager.close();
    });

    it.each(["abort", "timeout", "close"] as const)("releases a probe slot after operation %s", async (outcome) => {
        const manager = await createCooledEndpointManager();

        const callbackStarted = deferred<undefined>();
        const callbackFinished = deferred<undefined>();
        const controller = new AbortController();
        const reason = new Error("cancelled");
        const operation = manager.executeOnce(1, async () => {
            callbackStarted.resolve(undefined);
            await callbackFinished.promise;
            return "finished";
        }, { signal: controller.signal, timeoutMs: 25 });
        await callbackStarted.promise;
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("probe");

        if (outcome === "abort") {
            controller.abort(reason);
            await expect(operation).rejects.toBe(reason);
        } else if (outcome === "timeout") {
            const timeoutRejection = expect(operation).rejects.toBeInstanceOf(OperationTimeoutError);
            await vi.advanceTimersByTimeAsync(25);
            await timeoutRejection;
        } else {
            await manager.close();
            await expect(operation).rejects.toBeInstanceOf(RpcPoolClosedError);
        }

        expect(manager.getSnapshot()).toMatchObject({
            networks: [{ endpoints: [{ activeGroups: 0, status: "cooling-down" }] }],
            totalActiveGroups: 0,
        });
        callbackFinished.resolve(undefined);
        await manager.close();
    });

    it.each(["retry", "once"] as const)("keeps the shared %s provider usable after callback timeout", async (mode) => {
        vi.useFakeTimers();
        const request = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {})));
        vi.stubGlobal("fetch", request);
        const manager = new RpcPoolManager(config);
        let selectedClient: JsonRpcProvider | undefined;
        const callback = vi.fn(async (client: JsonRpcProvider) => {
            selectedClient = client;
            return await new Promise<never>(() => undefined);
        });
        const operation = executeInMode(manager, mode, callback, { timeoutMs: 25 });
        const rejection = expect(operation).rejects.toEqual(new OperationTimeoutError(1, 25));

        await vi.advanceTimersByTimeAsync(25);

        await rejection;
        await expect(selectedClient?.getBlockNumber()).resolves.toBe(42);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it.each(["retry", "once"] as const)("preserves abort reason during a %s callback", async (mode) => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager(config);
        const controller = new AbortController();
        const reason = new Error("consumer cancelled");
        let selectedClient: JsonRpcProvider | undefined;
        const callback = vi.fn(async (client: JsonRpcProvider) => {
            selectedClient = client;
            return await new Promise<never>(() => undefined);
        });
        const operation = executeInMode(manager, mode, callback, { signal: controller.signal });

        await vi.waitFor(() => {
            expect(callback).toHaveBeenCalledOnce();
        });
        controller.abort(reason);

        await expect(operation).rejects.toBe(reason);
        await expect(selectedClient?.getBlockNumber()).resolves.toBe(42);
    });

    it.each([
        ["retry", "throw"],
        ["retry", "reject"],
        ["retry", "resolve"],
        ["once", "throw"],
        ["once", "reject"],
        ["once", "resolve"],
    ] as const)("preserves synchronous abort during a %s callback that will %s", async (mode, settlement) => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const manager = new RpcPoolManager(config);
        const controller = new AbortController();
        const reason = new Error("cancelled inside callback");
        const callbackError = new Error("callback failed after cancellation");
        const unhandledRejection = vi.fn();
        process.on("unhandledRejection", unhandledRejection);
        try {
            const operation = executeInMode(manager, mode, () => {
                controller.abort(reason);
                if (settlement === "throw") {
                    throw callbackError;
                }
                return settlement === "reject"
                    ? Promise.reject(callbackError)
                    : Promise.resolve("too late");
            }, { signal: controller.signal });

            await expect(operation).rejects.toBe(reason);
            await Promise.resolve();
            expect(unhandledRejection).not.toHaveBeenCalled();
            expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        } finally {
            process.off("unhandledRejection", unhandledRejection);
        }
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

    it.each(["retry", "once"] as const)("aborts chain verification in %s mode", async (mode) => {
        const requestStarted = deferred<undefined>();
        let requestSignal: AbortSignal | undefined;
        vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined;
            requestStarted.resolve(undefined);
            return await new Promise<Response>((_resolve, reject) => {
                requestSignal?.addEventListener("abort", () => {
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Mirror fetch.
                    reject(requestSignal?.reason);
                }, { once: true });
            });
        }));
        const manager = new RpcPoolManager(config);
        const controller = new AbortController();
        const reason = new Error("chain verification cancelled");
        const callback = vi.fn(() => Promise.resolve());
        const operation = executeInMode(manager, mode, callback, { signal: controller.signal });

        await requestStarted.promise;
        controller.abort(reason);

        await expect(operation).rejects.toBe(reason);
        expect(requestSignal?.aborted).toBe(true);
        expect(callback).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        });
    });

    it.each(["retry", "once"] as const)("aborts cooldown waiting in %s mode", async (mode) => {
        const manager = await createManagerDuringCooldown();

        const controller = new AbortController();
        const reason = new Error("cooldown wait cancelled");
        const callback = vi.fn(() => Promise.resolve());
        const operation = executeInMode(manager, mode, callback, { signal: controller.signal });
        await Promise.resolve();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        controller.abort(reason);

        await expect(operation).rejects.toBe(reason);
        expect(callback).not.toHaveBeenCalled();
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        await manager.close();
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
        const callback = vi.fn(async (client: JsonRpcProvider) =>
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
        const unhandledRejection = vi.fn();
        process.on("unhandledRejection", unhandledRejection);
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
        const callback = vi.fn(async (client: JsonRpcProvider) =>
            await client.getBlockNumber());
        try {
            const operation = executeInMode(manager, mode, callback, { signal: controller.signal });

            await vi.waitFor(() => {
                expect(callback).toHaveBeenCalledOnce();
            });
            controller.abort(reason);
            await expect(operation).rejects.toBe(reason);
            late.reject(new TypeError("late connection failure"));
            await Promise.resolve();

            expect(unhandledRejection).not.toHaveBeenCalled();
            await expect(manager.executeOnce(1, () => Promise.resolve("available"))).resolves.toBe("available");
        } finally {
            process.off("unhandledRejection", unhandledRejection);
        }
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
            const callback = vi.fn(async (client: JsonRpcProvider) =>
                await client.getBlockNumber());
            const failure = await (mode === "retry"
                ? manager.executeWithRetry(1, callback)
                : manager.executeOnce(1, callback)
            ).catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect(failure).toMatchObject({ error: { code, message } });
            expect(callback).toHaveBeenCalledOnce();
            expect(methods).toEqual(["eth_chainId", "eth_blockNumber"]);
            await expect(manager.executeOnce(1, () => Promise.resolve("available"))).resolves.toBe("available");
        }
    });

    it.each([
        ["HTTP 401", 401, undefined],
        ["HTTP 403", 403, undefined],
        ["JSON-RPC authorization", 200, { code: -32_000, message: "invalid API key" }],
    ] as const)("permanently excludes an endpoint after %s", async (_case, status, jsonRpcError) => {
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            if (new URL(requestUrl(input)).hostname === "first.example") {
                const body = jsonRpcError === undefined
                    ? { id: payload.id, jsonrpc: "2.0", result: "denied" }
                    : { error: jsonRpcError, id: payload.id, jsonrpc: "2.0" };
                return Promise.resolve(Response.json(body, { status }));
            }
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x2a" }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });
        const callback = vi.fn(async (client: JsonRpcProvider) => await client.getBlockNumber());

        await expect(manager.executeWithRetry(1, callback)).resolves.toBe(42);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(manager.getSnapshot()).toMatchObject({
            errorsByCategory: { authorization: 1 },
            networks: [{ endpoints: [{
                cooldownUntil: null,
                excludedReason: "authorization",
                status: "excluded",
            }, { status: "available" }] }],
        });
        await manager.close();
    });

    it("applies Retry-After to HTTP 402 quota exhaustion before switching endpoint", async () => {
        const startedAt = Date.now();
        vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            if (new URL(requestUrl(input)).hostname === "first.example") {
                return Promise.resolve(Response.json(
                    { id: payload.id, jsonrpc: "2.0", result: "quota exhausted" },
                    { headers: { "retry-after": "600" }, status: 402 },
                ));
            }
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x2a" }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });

        await expect(manager.executeWithRetry(1, async (client) => await client.getBlockNumber())).resolves.toBe(42);
        const firstEndpoint = manager.getSnapshot().networks[0]?.endpoints[0];
        expect(firstEndpoint).toMatchObject({ excludedReason: null, status: "cooling-down" });
        expect(firstEndpoint?.cooldownUntil).toBeGreaterThanOrEqual(startedAt + 600_000);
        expect(firstEndpoint?.cooldownUntil).toBeLessThanOrEqual(Date.now() + 720_000);
        expect(manager.getSnapshot().errorsByCategory).toEqual({ "quota-limit": 1 });
        await manager.close();
    });

    it("keeps a retryable provider usable outside the finished callback", async () => {
        const request = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {})));
        vi.stubGlobal("fetch", request);
        const manager = new RpcPoolManager(config);
        const client = await manager.executeWithRetry(1, (selected) => Promise.resolve(selected));

        await expect(client.getBlockNumber()).resolves.toBe(42);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it("keeps a single-attempt provider usable outside the finished callback", async () => {
        const request = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {})));
        vi.stubGlobal("fetch", request);
        const manager = new RpcPoolManager(config);
        const client = await manager.executeOnce(1, (selected) => Promise.resolve(selected));

        await expect(client.getBlockNumber()).resolves.toBe(42);
        expect(request).toHaveBeenCalledTimes(2);
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
        const clients: JsonRpcProvider[] = [];
        const firstResults: bigint[] = [];
        const callback = vi.fn(async (client: JsonRpcProvider): Promise<bigint[]> => {
            clients.push(client);
            const first = await client.getBalance("0x0000000000000000000000000000000000000001");
            firstResults.push(first);
            const second = await client.getBalance("0x0000000000000000000000000000000000000002");
            return [first, second];
        });

        await expect(manager.executeWithRetry(1, callback)).resolves.toEqual([20n, 21n]);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(firstResults).toEqual([10n, 20n]);
        expect(clients.every((client) => client instanceof EndpointJsonRpcProvider)).toBe(true);
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

    it("does not inherit RPC provenance through a new callback error cause", async () => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            return Promise.resolve(Response.json({
                error: { code: -32_005, message: "rate limit exceeded" },
                id: payload.id,
                jsonrpc: "2.0",
            }));
        }));
        const manager = new RpcPoolManager(config);
        let rpcError: unknown;
        const callback = vi.fn(async (client: JsonRpcProvider) => {
            try {
                await client.send("eth_blockNumber", []);
            } catch (error: unknown) {
                rpcError = error;
                throw new Error("domain failure", { cause: error });
            }
        });

        const failure = await manager.executeWithRetry(1, callback).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).cause).toBe(rpcError);
        expect(callback).toHaveBeenCalledOnce();
        expect(manager.getSnapshot().errorsByCategory).toEqual({ "rate-limit": 1 });
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("available");
    });

    it("retains RPC provenance when the callback rethrows the exact provider error", async () => {
        let blockRequests = 0;
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string };
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            blockRequests += 1;
            return Promise.resolve(blockRequests === 1
                ? Response.json({
                    error: { code: -32_005, message: "rate limit exceeded" },
                    id: payload.id,
                    jsonrpc: "2.0",
                })
                : Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x2a" }));
        }));
        const manager = new RpcPoolManager({
            ...config,
            networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
        });
        let firstError: unknown;
        const callback = vi.fn(async (client: JsonRpcProvider) => {
            try {
                return await client.getBlockNumber();
            } catch (error: unknown) {
                firstError ??= error;
                throw error;
            }
        });

        await expect(manager.executeWithRetry(1, callback)).resolves.toBe(42);

        expect(firstError).toBeInstanceOf(Error);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("cooling-down");
    });

    it.each(["retry", "once"] as const)(
        "passes a revert-like provider error through unchanged in %s mode",
        async (mode) => {
            vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
                const payload = JSON.parse(init?.body as string) as { id: number; method: string };
                if (payload.method === "eth_chainId") {
                    return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
                }
                return Promise.resolve(Response.json({
                    error: {
                        code: -32_000,
                        data: "0xdeadbeef",
                        message: "execution reverted: unauthorized and rate limit exceeded",
                    },
                    id: payload.id,
                    jsonrpc: "2.0",
                }));
            }));
            const manager = new RpcPoolManager({
                ...config,
                networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
            });
            let providerError: unknown;
            const callback = vi.fn<(client: JsonRpcProvider) => Promise<unknown>>(async (client) => {
                try {
                    return await (client.send("test", []) as Promise<unknown>);
                } catch (error: unknown) {
                    providerError = error;
                    throw error;
                }
            });

            const operation = mode === "retry"
                ? manager.executeWithRetry(1, callback)
                : manager.executeOnce(1, callback);
            const result: unknown = await operation.catch((error: unknown) => error);

            expect(result).toBe(providerError);
            expect(result).toMatchObject({ code: "UNKNOWN_ERROR", error: { code: -32_000, data: "0xdeadbeef" } });
            expect(callback).toHaveBeenCalledOnce();
            expect(manager.getSnapshot().errorsByCategory).toEqual({ "contract-execution": 1 });
            expect(manager.getSnapshot().networks[0]?.endpoints[0]).toMatchObject({
                excludedReason: null,
                status: "available",
            });
            await manager.close();
        },
    );

    it.each(["retry", "once"] as const)(
        "keeps serialization failures local in %s mode",
        async (mode) => {
            const methods = new Map<string, string[]>();
            vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
                const endpoint = requestUrl(input);
                const payload = JSON.parse(init?.body as string) as { id: number; method: string };
                methods.set(endpoint, [...(methods.get(endpoint) ?? []), payload.method]);
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }));
            const manager = new RpcPoolManager({
                ...config,
                networks: [{ chainId: 1, rpcUrls: ["https://first.example", "https://second.example"] }],
            });
            const failure = new Error("toJSON failed");
            const callback = vi.fn<(client: JsonRpcProvider) => Promise<unknown>>(async (client) =>
                await (client.send("test", [{
                    toJSON: () => { throw failure; },
                }]) as Promise<unknown>));

            const operation = mode === "retry"
                ? manager.executeWithRetry(1, callback)
                : manager.executeOnce(1, callback);

            await expect(operation).rejects.toBe(failure);
            expect(callback).toHaveBeenCalledOnce();
            expect(methods.get("https://first.example/")).toEqual(["eth_chainId"]);
            expect(methods.has("https://second.example/")).toBe(false);
            expect(manager.getSnapshot()).toMatchObject({ errorsByCategory: {}, totalRequests: 1 });
            expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("available");
            await manager.close();
        },
    );

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
        const callback = vi.fn<(client: JsonRpcProvider) => Promise<unknown>>(
            async (client) => {
                await client.send("eth_sendRawTransaction", ["0x01"]);
            },
        );

        await expect(manager.executeOnce(1, callback)).rejects.toBe(failure);
        expect(callback).toHaveBeenCalledOnce();
        expect(methods.get("https://first.example/")).toEqual(["eth_chainId", "eth_sendRawTransaction"]);
        expect(methods.has("https://second.example/")).toBe(false);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("cooling-down");
    });

    it("supports broadcastTransaction and a connected Signer only in single-attempt callbacks", async () => {
        const sentTransactions: string[] = [];
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { id: number; method: string; params: string[] };
            if (payload.method === "eth_chainId") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            if (payload.method === "eth_blockNumber") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x2a" }));
            }
            if (payload.method === "eth_getTransactionCount") {
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0x1" }));
            }
            const signedTransaction = payload.params[0];
            if (payload.method !== "eth_sendRawTransaction" || signedTransaction === undefined) {
                throw new Error(`Unexpected RPC method: ${payload.method}`);
            }
            sentTransactions.push(signedTransaction);
            return Promise.resolve(Response.json({
                id: payload.id,
                jsonrpc: "2.0",
                result: keccak256(signedTransaction),
            }));
        }));
        const manager = new RpcPoolManager(config);
        const wallet = new Wallet("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        const transaction = {
            chainId: 1,
            gasLimit: 21_000n,
            gasPrice: 1n,
            to: "0x0000000000000000000000000000000000000001",
            type: 0,
            value: 0n,
        } as const;
        const signedTransaction = await wallet.signTransaction({ ...transaction, nonce: 0 });
        const broadcastCallback = vi.fn(async (client: JsonRpcProvider) =>
            await client.broadcastTransaction(signedTransaction));
        const signerCallback = vi.fn(async (client: JsonRpcProvider) =>
            await wallet.connect(client).getNonce("latest"));

        await expect(manager.executeOnce(1, broadcastCallback)).resolves.toMatchObject({ nonce: 0 });
        await expect(manager.executeOnce(1, signerCallback)).resolves.toBe(1);
        expect(broadcastCallback).toHaveBeenCalledOnce();
        expect(signerCallback).toHaveBeenCalledOnce();
        expect(sentTransactions).toHaveLength(1);
        await manager.close();
    });

    it("leaves shared-provider listeners under consumer control", async () => {
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(rpcResponse(init ?? {}))));
        const on = vi.spyOn(EndpointJsonRpcProvider.prototype, "on").mockResolvedValue({} as EndpointJsonRpcProvider);
        const off = vi.spyOn(EndpointJsonRpcProvider.prototype, "off").mockResolvedValue({} as EndpointJsonRpcProvider);
        const manager = new RpcPoolManager(config);
        const listener = vi.fn();

        await manager.executeOnce(1, async (client) => {
            await client.on("block", listener);
            await expect(client.send("debug_after_listener", [])).resolves.toBe("0x2a");
            await client.off("block", listener);
        });

        expect(on).toHaveBeenCalledWith("block", listener);
        expect(off).toHaveBeenCalledWith("block", listener);
        await expect(manager.executeOnce(1, () => Promise.resolve("still active"))).resolves.toBe("still active");
        await manager.close();
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

    it("restarts a retryable callback after its endpoint cools between client calls", async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0);
        const methods: string[] = [];
        vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(init?.body as string) as { method: string };
            methods.push(payload.method);
            return Promise.resolve(rpcResponse(init ?? {}));
        }));
        const manager = new RpcPoolManager({ ...config, operationTimeoutMs: 10_000 });
        const firstCallFinished = deferred<undefined>();
        const resumeFirstCallback = deferred<undefined>();
        const callback = vi.fn(async (client: JsonRpcProvider) => {
            await client.getBlockNumber();
            if (callback.mock.calls.length === 1) {
                firstCallFinished.resolve(undefined);
                await resumeFirstCallback.promise;
            }
            return await client.getBalance("0x0000000000000000000000000000000000000001");
        });
        const operation = manager.executeWithRetry(1, callback);
        await vi.advanceTimersByTimeAsync(10);
        await firstCallFinished.promise;

        const cooling = manager.executeOnce(1, () => Promise.reject(new RpcEndpointDataError("invalid data")));
        const coolingRejection = expect(cooling).rejects.toBeInstanceOf(RpcEndpointDataError);
        await vi.advanceTimersByTimeAsync(10);
        await coolingRejection;
        resumeFirstCallback.resolve(undefined);
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(operation).resolves.toBe(42n);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(methods).toEqual(["eth_chainId", "eth_blockNumber", "eth_blockNumber", "eth_getBalance"]);
        await manager.close();
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
        const callback = vi.fn<(client: JsonRpcProvider) => Promise<void>>(async (client) => {
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

const broadcastWallet = new Wallet("0x" + "11".repeat(32));
const broadcastTx = await broadcastWallet.signTransaction({
    chainId: 1,
    type: 2,
    nonce: 0,
    gasLimit: 21_000,
    maxFeePerGas: 10,
    maxPriorityFeePerGas: 1,
});
const broadcastHash = keccak256(broadcastTx);

function broadcastManager(count = 3): RpcPoolManager {
    return new RpcPoolManager({
        ...config,
        networks: [{
            chainId: 1,
            rpcUrls: Array.from({ length: count }, (_, index) => `https://rpc${String(index)}.example`),
        }],
    });
}

interface BroadcastPayload {
    id: number;
    method: string;
    params: string[];
}

function broadcastPayload(init?: RequestInit): BroadcastPayload {
    return JSON.parse(init?.body as string) as BroadcastPayload;
}

function broadcastResponse(payload: BroadcastPayload, result: unknown = broadcastHash): Response {
    return Response.json({
        id: payload.id, jsonrpc: "2.0", result: payload.method === "eth_chainId" ? "0x1" : result,
    });
}

describe("RpcPoolManager broadcastTransaction", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });
    it.each([undefined, 1, 10])("sends original bytes once per endpoint with maxCount %s", async (maxCount) => {
        const request = vi.fn((_input: string, init?: RequestInit) =>
            Promise.resolve(broadcastResponse(broadcastPayload(init), broadcastHash.toUpperCase())));
        vi.stubGlobal("fetch", request);
        const manager = broadcastManager(4);
        expect(await manager.broadcastTransaction(1, broadcastTx, maxCount === undefined ? {} : { maxCount }))
            .toBe(broadcastHash);
        const sends = request.mock.calls.filter(([, init]) =>
            broadcastPayload(init).method === "eth_sendRawTransaction");
        expect(sends).toHaveLength(Math.min(maxCount ?? 3, 4));
        expect(new Set(sends.map(([url]) => url)).size).toBe(sends.length);
        expect(sends.map(([, init]) => broadcastPayload(init).params)).toEqual(sends.map(() => [broadcastTx]));
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        await manager.close();
    });

    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects count %s", async (maxCount) => {
        const request = vi.fn();
        vi.stubGlobal("fetch", request);
        const manager = broadcastManager();
        await expect(manager.broadcastTransaction(1, broadcastTx, { maxCount })).rejects.toBeInstanceOf(RangeError);
        expect(request).not.toHaveBeenCalled();
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        await manager.close();
    });

    it("rejects bad timeout, malformed, unsigned, wrong-chain and unprotected transactions without HTTP", async () => {
        const request = vi.fn();
        vi.stubGlobal("fetch", request);
        const manager = broadcastManager();
        const { Transaction } = await import("ethers");
        const unsigned = Transaction.from({ chainId: 1, type: 2, gasLimit: 21000 }).unsignedSerialized;
        const wrong = await broadcastWallet.signTransaction({ chainId: 10, gasLimit: 21000 });
        const legacy = await broadcastWallet.signTransaction({ type: 0, chainId: 0, gasLimit: 21000, gasPrice: 1 });
        for (const tx of ["0xno", unsigned, wrong, legacy])
            await expect(manager.broadcastTransaction(1, tx)).rejects.toBeInstanceOf(Error);
        for (const timeoutMs of [0, -1, 0.5, Infinity])
            await expect(manager.broadcastTransaction(1, broadcastTx, { timeoutMs }))
                .rejects.toBeInstanceOf(RangeError);
        expect(request).not.toHaveBeenCalled();
        await manager.close();
    });

    it("launches all branches before an answer and returns early while siblings continue", async () => {
        vi.useFakeTimers();
        const pending: {
            payload: BroadcastPayload;
            response: ReturnType<typeof deferred<Response>>;
        }[] = [];
        vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
            const payload = broadcastPayload(init);
            if (payload.method === "eth_chainId")
                return Promise.resolve(broadcastResponse(payload));
            const response = deferred<Response>();
            pending.push({ payload, response });
            return response.promise;
        }));
        const manager = broadcastManager();
        const operation = manager.broadcastTransaction(1, broadcastTx);
        await vi.advanceTimersByTimeAsync(0);
        expect(pending).toHaveLength(3);
        pending[0]?.response.resolve(broadcastResponse(pending[0].payload));
        await expect(operation).resolves.toBe(broadcastHash);
        expect(manager.getSnapshot().totalActiveGroups).toBe(2);
        for (const branch of pending.slice(1))
            branch.response.resolve(broadcastResponse(branch.payload));
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        await manager.close();
    });

    it("never replaces or repeats a failed verifier or send branch", async () => {
        const request = vi.fn((url: string, init?: RequestInit) => {
            const payload = broadcastPayload(init);
            if (url.includes("rpc0"))
                return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0xa" }));
            if (payload.method === "eth_sendRawTransaction")
                return Promise.resolve(Response.json({
                    id: payload.id, jsonrpc: "2.0", error: { code: -32000, message: "nonce too low" },
                }));
            return Promise.resolve(broadcastResponse(payload));
        });
        vi.stubGlobal("fetch", request);
        const manager = broadcastManager(3);
        const { RpcBroadcastError } = await import("../../src/index.js");
        const error: unknown = await manager.broadcastTransaction(1, broadcastTx, { maxCount: 2 })
            .catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(RpcBroadcastError);
        if (!(error instanceof RpcBroadcastError))
            throw new Error("Expected broadcast error");
        expect(error.chainId).toBe(1);
        expect(error.hash).toBe(broadcastHash);
        expect(error.failures.map(({ endpointNumber, outcome }) => [endpointNumber, outcome]))
            .toEqual([[1, "not-sent"], [2, "rejected"]]);
        expect(error.failures[1]?.error).toBeInstanceOf(Error);
        expect(request.mock.calls.map(([url, init]) => [url, broadcastPayload(init).method])).toEqual([
            ["https://rpc0.example/", "eth_chainId"],
            ["https://rpc1.example/", "eth_chainId"],
            ["https://rpc1.example/", "eth_sendRawTransaction"],
        ]);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.excludedReason).toBe("chain-id-mismatch");
        await manager.close();
    });

    it.each([
        [200, -32000, "  Already Known  ", true, "available"],
        [200, -32000, "nonce too low", false, "available"],
        [200, -32602, "already known", false, "available"],
        [200, -32601, "already known", false, "available"],
        [200, 3, "already known", false, "available"],
        [200, 401, "already known", false, "excluded"],
        [200, 429, "already known", false, "cooling-down"],
        [200, 402, "already known", false, "cooling-down"],
        [401, -32000, "already known", false, "excluded"],
        [429, -32000, "already known", false, "cooling-down"],
        [503, -32000, "already known", false, "cooling-down"],
        [200, -32000, "transaction already known", false, "available"],
    ] as const)("recognizes already known (%s, %s, %s)", async (status, code, message, success, endpointStatus) => {
        vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
            const payload = broadcastPayload(init);
            return Promise.resolve(payload.method === "eth_chainId"
                ? broadcastResponse(payload)
                : Response.json({ id: payload.id, jsonrpc: "2.0", error: { code, message } }, { status }));
        }));
        const manager = broadcastManager(1);
        const operation = manager.broadcastTransaction(1, broadcastTx);
        if (success)
            await expect(operation).resolves.toBe(broadcastHash);
        else
            await expect(operation).rejects.toMatchObject({ name: "RpcBroadcastError" });
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe(endpointStatus);
        expect(manager.getSnapshot().totalRequests).toBe(2);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.errorCount).toBe(1);
        await manager.close();
    });

    it.each(["invalid", "0x" + "ff".repeat(32), null])("treats hash %s as uncertain delivery", async (result) => {
        vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
            Promise.resolve(broadcastResponse(broadcastPayload(init), result))));
        const manager = broadcastManager(1);
        await expect(manager.broadcastTransaction(1, broadcastTx)).rejects.toMatchObject({
            failures: [{
                    outcome: "unknown", error: expect.any(RpcEndpointDataError) as unknown,
                }],
        });
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("cooling-down");
        expect(manager.getSnapshot().errorsByCategory["endpoint-data"]).toBe(1);
        await manager.close();
    });

    it("does not accept a similar local exception and preserves it as unknown delivery", async () => {
        const error = new Error("already known");
        expect(getRpcErrorResponse("already known")).toBeUndefined();
        expect(getRpcErrorResponse(null)).toBeUndefined();
        vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
            broadcastPayload(init).method === "eth_chainId"
                ? Promise.resolve(broadcastResponse(broadcastPayload(init)))
                : Promise.reject(error)));
        const manager = broadcastManager(1);
        await expect(manager.broadcastTransaction(1, broadcastTx))
            .rejects.toMatchObject({ failures: [{ error, outcome: "unknown" }] });
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("cooling-down");
        await manager.close();
    });
});
describe("broadcast deadlines and endpoint recovery", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });
    it("recovers an actual probe on already known without changing RPC error counters", async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0);
        vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
            const payload = broadcastPayload(init);
            return Promise.resolve(payload.method === "eth_chainId" ? broadcastResponse(payload) : Response.json({
                id: payload.id, jsonrpc: "2.0", error: { code: -32000, message: "already known" },
            }));
        }));
        const pool = broadcastManager(1);
        await expect(pool.executeOnce(1, () => Promise.reject(new RpcEndpointDataError())))
            .rejects.toBeInstanceOf(RpcEndpointDataError);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(pool.broadcastTransaction(1, broadcastTx)).resolves.toBe(broadcastHash);
        expect(pool.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("available");
        expect(pool.getSnapshot().errorsByCategory).toEqual({ "endpoint-data": 1, unknown: 1 });
        expect(vi.getTimerCount()).toBe(0);
        await pool.close();
    });

    it("treats request timeout as unknown delivery, cooling only the failed branch", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
            const payload = broadcastPayload(init);
            if (payload.method === "eth_chainId" || url.includes("rpc1"))
                return Promise.resolve(broadcastResponse(payload));
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    reject(init.signal?.reason as Error);
                }, { once: true });
            });
        }));
        const manager = broadcastManager(2);
        await expect(manager.broadcastTransaction(1, broadcastTx)).resolves.toBe(broadcastHash);
        expect(manager.getSnapshot().totalActiveGroups).toBe(1);
        await vi.advanceTimersByTimeAsync(50);
        expect(manager.getSnapshot().networks[0]?.endpoints.map(({ status }) => status))
            .toEqual(["cooling-down", "available"]);
        expect(manager.getSnapshot().errorsByCategory).toEqual({ timeout: 1 });
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        await manager.close();
    });

    it("preserves unknown network and no candidates errors", async () => {
        vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
            const payload = broadcastPayload(init);
            return Promise.resolve(Response.json({ id: payload.id, jsonrpc: "2.0", result: "0xa" }));
        }));
        const manager = broadcastManager(1);
        await expect(manager.broadcastTransaction(10, broadcastTx)).rejects.toBeInstanceOf(UnknownNetworkError);
        await expect(manager.broadcastTransaction(1, broadcastTx)).rejects.toMatchObject({
            name: "RpcBroadcastError", failures: [{ outcome: "not-sent" }],
        });
        await expect(manager.broadcastTransaction(1, broadcastTx)).rejects.toBeInstanceOf(NoUsableRpcEndpointError);
        await manager.close();
    });

    it.each(["signal", "close", "deadline"] as const)("cancels remaining sends with %s after success", async (kind) => {
        vi.useFakeTimers();
        let aborted = false;
        vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
            const payload = broadcastPayload(init);
            if (payload.method === "eth_chainId" || url.includes("rpc0"))
                return Promise.resolve(broadcastResponse(payload));
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    aborted = true;
                    reject(init.signal?.reason as Error);
                }, { once: true });
            });
        }));
        const controller = new AbortController();
        const manager = new RpcPoolManager({
            ...config, requestTimeoutMs: 200, networks: [{
                    chainId: 1, rpcUrls: ["https://rpc0.example", "https://rpc1.example"],
                }],
        });
        await expect(manager.broadcastTransaction(1, broadcastTx, { signal: controller.signal }))
            .resolves.toBe(broadcastHash);
        expect(manager.getSnapshot().totalActiveGroups).toBe(1);
        if (kind === "signal")
            controller.abort(new Error("user cancelled"));
        if (kind === "close")
            await manager.close();
        await vi.advanceTimersByTimeAsync(kind === "deadline" ? 100 : 0);
        expect(aborted).toBe(true);
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        expect(manager.getSnapshot().networks[0]?.endpoints.every(({ status }) => status === "available")).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        await manager.close();
    });

    it.each(["signal", "close", "deadline"] as const)("preserves %s cancellation during verification", async (kind) => {
        vi.useFakeTimers();
        const request = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => { reject(init.signal?.reason as Error); }, { once: true });
        }));
        vi.stubGlobal("fetch", request);
        const controller = new AbortController();
        const reason = new Error("cancelled");
        const manager = new RpcPoolManager({ ...config, requestTimeoutMs: 200 });
        const operation = manager.broadcastTransaction(1, broadcastTx, { signal: controller.signal });
        const rejection = kind === "signal"
            ? expect(operation).rejects.toBe(reason)
            : expect(operation).rejects.toBeInstanceOf(kind === "close" ? RpcPoolClosedError : OperationTimeoutError);
        await vi.advanceTimersByTimeAsync(0);
        if (kind === "signal")
            controller.abort(reason);
        if (kind === "close")
            await manager.close();
        await vi.advanceTimersByTimeAsync(kind === "deadline" ? 100 : 0);
        await rejection;
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("available");
        expect(vi.getTimerCount()).toBe(0);
        await manager.close();
    });

    it("does no work for a pre-aborted signal or closed manager", async () => {
        const request = vi.fn();
        vi.stubGlobal("fetch", request);
        const manager = broadcastManager();
        const reason = new Error("already cancelled");
        await expect(manager.broadcastTransaction(1, broadcastTx, { signal: AbortSignal.abort(reason) }))
            .rejects.toBe(reason);
        await manager.close();
        await expect(manager.broadcastTransaction(1, broadcastTx)).rejects.toBeInstanceOf(RpcPoolClosedError);
        expect(request).not.toHaveBeenCalled();
    });

    it("spends the same deadline while waiting for availability", async () => {
        const manager = await createManagerDuringCooldown();
        const operation = manager.broadcastTransaction(1, broadcastTx, { timeoutMs: 100 });
        const rejection = expect(operation).rejects.toBeInstanceOf(OperationTimeoutError);
        await vi.advanceTimersByTimeAsync(100);
        await rejection;
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        await manager.close();
    });
});
describe("broadcast concurrency boundaries", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });
    it("rejects a reservation invalidated by a concurrent read before sending", async () => {
        vi.useFakeTimers();
        const verification = deferred<Response>();
        let first = true;
        vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
            const payload = broadcastPayload(init);
            if (first) {
                first = false;
                return verification.promise;
            }
            return Promise.resolve(broadcastResponse(payload));
        }));
        const manager = broadcastManager(1);
        const broadcast = manager.broadcastTransaction(1, broadcastTx);
        const rejection = expect(broadcast).rejects.toMatchObject({ failures: [{ outcome: "not-sent" }] });
        await expect(manager.executeOnce(1, () => Promise.reject(new RpcEndpointDataError())))
            .rejects.toBeInstanceOf(RpcEndpointDataError);
        verification.resolve(Response.json({ id: 1, jsonrpc: "2.0", result: "0x1" }));
        await rejection;
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.getSnapshot().requestsByMethod.eth_sendRawTransaction).toBeUndefined();
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        await manager.close();
    });

    it("keeps an unrelated read alive when broadcast is cancelled", async () => {
        vi.useFakeTimers();
        const reading = deferred<Response>();
        let readPayload: BroadcastPayload | undefined;
        let readSignal: AbortSignal | null | undefined;
        vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
            const payload = broadcastPayload(init);
            if (payload.method === "eth_chainId")
                return Promise.resolve(broadcastResponse(payload));
            if (payload.method === "eth_blockNumber") {
                readPayload = payload;
                readSignal = init?.signal;
                return reading.promise;
            }
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    reject(init.signal?.reason as Error);
                }, { once: true });
            });
        }));
        const manager = broadcastManager(1);
        const controller = new AbortController();
        const reason = new Error("stop broadcast");
        const read = manager.executeOnce(1, async (provider) => await provider.send("eth_blockNumber", []) as unknown);
        await vi.advanceTimersByTimeAsync(0);
        const broadcast = manager.broadcastTransaction(1, broadcastTx, { signal: controller.signal });
        const rejection = expect(broadcast).rejects.toBe(reason);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort(reason);
        await rejection;
        await vi.advanceTimersByTimeAsync(0);
        expect(readSignal?.aborted).toBe(false);
        expect(manager.getSnapshot().totalActiveGroups).toBe(1);
        if (readPayload === undefined)
            throw new Error("Expected read request");
        reading.resolve(broadcastResponse(readPayload, "0x2a"));
        await expect(read).resolves.toBe("0x2a");
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
        await manager.close();
    });

    it.each(["resolve", "reject"] as const)("ignores late %s after cancellation of a probe", async (settle) => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0);
        const late = deferred<Response>();
        let pendingPayload: BroadcastPayload | undefined;
        vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
            const payload = broadcastPayload(init);
            if (payload.method === "eth_chainId")
                return Promise.resolve(broadcastResponse(payload));
            pendingPayload = payload;
            return late.promise;
        }));
        const manager = broadcastManager(1);
        await expect(manager.executeOnce(1, () => Promise.reject(new RpcEndpointDataError())))
            .rejects.toBeInstanceOf(RpcEndpointDataError);
        await vi.advanceTimersByTimeAsync(5000);
        const controller = new AbortController();
        const reason = new Error("cancel probe");
        const operation = manager.broadcastTransaction(1, broadcastTx, { signal: controller.signal });
        const rejection = expect(operation).rejects.toBe(reason);
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("probe");
        controller.abort(reason);
        await rejection;
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("cooling-down");
        if (pendingPayload === undefined)
            throw new Error("Expected send request");
        if (settle === "resolve")
            late.resolve(broadcastResponse(pendingPayload));
        else
            late.reject(new Error("late network rejection"));
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("cooling-down");
        expect(vi.getTimerCount()).toBe(0);
        await manager.close();
    });

    it("cancellation wins when acceptance is delivered in the same turn", async () => {
        vi.useFakeTimers();
        const response = deferred<Response>();
        let payload: BroadcastPayload | undefined;
        vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
            const current = broadcastPayload(init);
            if (current.method === "eth_chainId")
                return Promise.resolve(broadcastResponse(current));
            payload = current;
            return response.promise;
        }));
        const manager = broadcastManager(1);
        const controller = new AbortController();
        const reason = new Error("cancel race");
        const operation = manager.broadcastTransaction(1, broadcastTx, { signal: controller.signal });
        const rejection = expect(operation).rejects.toBe(reason);
        await vi.advanceTimersByTimeAsync(0);
        if (payload === undefined)
            throw new Error("Expected send request");
        response.resolve(broadcastResponse(payload));
        controller.abort(reason);
        await rejection;
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.getSnapshot().totalActiveGroups).toBe(0);
        expect(manager.getSnapshot().networks[0]?.endpoints[0]?.status).toBe("available");
        expect(vi.getTimerCount()).toBe(0);
        await manager.close();
    });
});
