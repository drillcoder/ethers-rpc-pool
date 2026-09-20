import { AsyncLocalStorage } from "node:async_hooks";

import { JsonRpcProvider } from "ethers";
import type {
    JsonRpcError,
    JsonRpcPayload,
    JsonRpcResult,
    Networkish,
} from "ethers";

import { EndpointReservationUnavailableError } from "../pool/attempt.js";
import { createRuntime } from "../pool/runtime.js";
import type { RuntimeDependencies } from "../pool/runtime.js";

export type HttpRequest = (
    input: string,
    init: RequestInit,
) => Promise<Response>;

export interface EndpointJsonRpcProviderOptions {
    readonly requestTimeoutMs: number;
    readonly observer?: RpcTransportObserver;
    readonly request?: HttpRequest;
    readonly runtime?: Partial<RuntimeDependencies>;
}

export interface RpcTransportObserver {
    onError(method: string, error: unknown, startedAt: number, finishedAt: number, durationMs: number): void;
    onRequest(method: string, startedAt: number): void;
    onResponse(method: string, startedAt: number, finishedAt: number, durationMs: number): void;
}

interface RequestContext {
    readonly active: () => boolean;
    readonly controller: AbortController;
    readonly deadlineMs: number;
    readonly isReservationCurrent: () => boolean;
    readonly signal?: AbortSignal;
}

const rpcOriginErrors = new WeakSet();
const rpcOriginCauses = new WeakMap<object, unknown>();

function markRpcOrigin(error: object, cause: unknown = error): void {
    rpcOriginErrors.add(error);
    rpcOriginCauses.set(error, cause);
}

export function getRpcOriginError(error: unknown): unknown {
    let current = error;
    const visited = new Set<object>();
    while (typeof current === "object" && current !== null && !visited.has(current)) {
        if (rpcOriginErrors.has(current)) {
            return rpcOriginCauses.get(current);
        }
        visited.add(current);
        current = "cause" in current ? current.cause : undefined;
    }
    return undefined;
}

export class RpcTransportResponseError extends Error {
    public override readonly name = "RpcTransportResponseError";
    public readonly headers: Readonly<Record<string, string>>;
    public readonly jsonRpcError: Readonly<JsonRpcError["error"]> | undefined;
    public readonly status: number;

    public constructor(
        status: number,
        headers: Readonly<Record<string, string>>,
        jsonRpcError: Readonly<JsonRpcError["error"]> | undefined,
        options?: ErrorOptions,
    ) {
        super("RPC transport received an error response", options);
        this.status = status;
        this.headers = headers;
        this.jsonRpcError = jsonRpcError;
    }
}

export class RpcRequestTimeoutError extends Error {
    public override readonly name = "RpcRequestTimeoutError";
    public readonly timeoutMs: number;

    public constructor(timeoutMs: number) {
        super(`RPC request timed out after ${String(timeoutMs)} ms`);
        this.timeoutMs = timeoutMs;
    }
}

export class EndpointJsonRpcProvider extends JsonRpcProvider {
    readonly #context = new AsyncLocalStorage<RequestContext>();
    readonly #observer: RpcTransportObserver | undefined;
    readonly #request: HttpRequest;
    readonly #requestTimeoutMs: number;
    readonly #runtime: RuntimeDependencies;
    readonly #url: string;
    #nextId = 1;

    public constructor(
        url: string,
        network: Networkish,
        options: EndpointJsonRpcProviderOptions,
    ) {
        super(url, network, {
            batchMaxCount: 1,
            cacheTimeout: -1,
            staticNetwork: true,
        });

        this.#url = url;
        this.#observer = options.observer;
        this.#request = options.request ?? globalThis.fetch;
        this.#requestTimeoutMs = options.requestTimeoutMs;
        this.#runtime = createRuntime(options.runtime);
    }

    public async runWithDeadline<Result>(
        deadlineMs: number,
        operation: () => Promise<Result>,
        signal?: AbortSignal,
        isReservationCurrent: () => boolean = () => true,
    ): Promise<Result> {
        let active = true;
        const controller = new AbortController();
        const context: RequestContext = {
            active: () => active,
            controller,
            deadlineMs,
            isReservationCurrent,
            ...(signal === undefined ? {} : { signal }),
        };
        try {
            return await this.#context.run(context, operation);
        } finally {
            active = false;
            controller.abort(new Error("RPC attempt context is no longer active"));
        }
    }

    public override async send(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
        this._start();
        const payload: JsonRpcPayload = {
            id: this.#nextId++,
            jsonrpc: "2.0",
            method,
            params,
        };
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- _send returns one response per payload.
        const response = (await this._send(payload))[0]!;
        if ("error" in response) {
            const error = this.getRpcError(payload, response as JsonRpcError);
            const transportError = new RpcTransportResponseError(
                200,
                Object.freeze({}),
                Object.freeze({ ...(response as JsonRpcError).error }),
            );
            markRpcOrigin(error, transportError);
            throw error;
        }
        return response.result;
    }

    public override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
        const payloads = Array.isArray(payload) ? payload : [payload];

        return await Promise.all(
            payloads.map(async (singlePayload) => await this.#sendOne(singlePayload)),
        );
    }

    async #sendOne(payload: JsonRpcPayload): Promise<JsonRpcResult> {
        const context = this.#context.getStore();
        if (context !== undefined) {
            context.signal?.throwIfAborted();
            context.controller.signal.throwIfAborted();
            if (!context.active() || !context.isReservationCurrent()) {
                throw new EndpointReservationUnavailableError();
            }
        }
        const deadlineMs = context?.deadlineMs;
        const remainingMs =
            deadlineMs === undefined
                ? Number.POSITIVE_INFINITY
                : deadlineMs - this.#runtime.monotonicNow();
        if (remainingMs <= 0) {
            throw new RpcRequestTimeoutError(0);
        }

        const startedAt = this.#runtime.epochNow();
        const startedMonotonic = this.#runtime.monotonicNow();
        this.#observer?.onRequest(payload.method, startedAt);
        try {
            const result = await this.#requestPayload(payload, context, remainingMs);
            const finishedAt = this.#runtime.epochNow();
            if ("error" in result) {
                const transportError = new RpcTransportResponseError(
                    200,
                    Object.freeze({}),
                    Object.freeze({ ...(result as JsonRpcError).error }),
                );
                this.#observer?.onError(
                    payload.method,
                    transportError,
                    startedAt,
                    finishedAt,
                    this.#runtime.monotonicNow() - startedMonotonic,
                );
                return result;
            }
            this.#observer?.onResponse(
                payload.method,
                startedAt,
                finishedAt,
                this.#runtime.monotonicNow() - startedMonotonic,
            );
            return result;
        } catch (error: unknown) {
            if (typeof error === "object" && error !== null) {
                markRpcOrigin(error);
            }
            const finishedAt = this.#runtime.epochNow();
            this.#observer?.onError(
                payload.method,
                error,
                startedAt,
                finishedAt,
                this.#runtime.monotonicNow() - startedMonotonic,
            );
            throw error;
        }
    }

    async #requestPayload(
        payload: JsonRpcPayload,
        context: RequestContext | undefined,
        remainingMs: number,
    ): Promise<JsonRpcResult> {
        const timeoutMs = Math.min(this.#requestTimeoutMs, remainingMs);
        const controller = new AbortController();
        const abort = (): void => {
            controller.abort(context?.signal?.reason ?? context?.controller.signal.reason);
        };
        const attemptSignal = context?.controller.signal;
        context?.signal?.addEventListener("abort", abort, { once: true });
        attemptSignal?.addEventListener("abort", abort, { once: true });
        const timeout = this.#runtime.setTimeout(() => {
            controller.abort(new RpcRequestTimeoutError(timeoutMs));
        }, timeoutMs);

        try {
            const response = await this.#request(this.#url, {
                body: JSON.stringify(payload),
                headers: {
                    "content-type": "application/json",
                },
                method: "POST",
                signal: controller.signal,
            });
            const headers = Object.freeze(
                Object.fromEntries(response.headers.entries()),
            );
            let body: unknown;

            try {
                body = await response.json();
            } catch (cause) {
                throw new RpcTransportResponseError(
                    response.status,
                    headers,
                    undefined,
                    { cause },
                );
            }

            const jsonRpcError = (body as Partial<JsonRpcError>).error;
            if (!response.ok) {
                throw new RpcTransportResponseError(
                    response.status,
                    headers,
                    jsonRpcError === undefined
                        ? undefined
                        : Object.freeze({ ...jsonRpcError }),
                );
            }

            return body as JsonRpcResult;
        } finally {
            context?.signal?.removeEventListener("abort", abort);
            attemptSignal?.removeEventListener("abort", abort);
            this.#runtime.clearTimeout(timeout);
        }
    }
}
