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
import { classifyRpcTransportError } from "./classification.js";
import type { RpcErrorClassification } from "./classification.js";

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
    onError(
        method: string,
        error: unknown,
        failure: RpcErrorClassification,
        startedAt: number,
        finishedAt: number,
        durationMs: number,
    ): void;
    onRequest(method: string, startedAt: number): void;
    onResponse(method: string, startedAt: number, finishedAt: number, durationMs: number): void;
}

interface RequestContext {
    readonly controller: AbortController;
    readonly deadlineMs: number;
    readonly isReservationCurrent: () => boolean;
    readonly signal?: AbortSignal;
}

interface TransportResult {
    readonly headers: Readonly<Record<string, string>>;
    readonly result: JsonRpcResult;
    readonly status: number;
}

interface PendingRpcFailure {
    readonly durationMs: number;
    readonly finishedAt: number;
    readonly method: string;
    readonly startedAt: number;
    readonly transportError: RpcTransportResponseError;
}

const rpcFailures = new WeakMap<object, RpcErrorClassification>();

function markRpcFailure(error: object, failure: RpcErrorClassification): void {
    rpcFailures.set(error, failure);
}

export function getRpcFailure(error: unknown): RpcErrorClassification | undefined {
    return typeof error === "object" && error !== null ? rpcFailures.get(error) : undefined;
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
    readonly #pendingRpcFailures = new WeakMap<JsonRpcError, PendingRpcFailure>();
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
        const controller = new AbortController();
        const context: RequestContext = {
            controller,
            deadlineMs,
            isReservationCurrent,
            ...(signal === undefined ? {} : { signal }),
        };
        try {
            return await this.#context.run(context, operation);
        } finally {
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
            throw this.getRpcError(payload, response as JsonRpcError);
        }
        return response.result;
    }

    public override getRpcError(payload: JsonRpcPayload, response: JsonRpcError): Error {
        const error = super.getRpcError(payload, response);
        const pending = this.#pendingRpcFailures.get(response);
        if (pending === undefined) {
            return error;
        }

        this.#pendingRpcFailures.delete(response);
        const failure = classifyRpcTransportError(pending.transportError, pending.finishedAt);
        markRpcFailure(error, failure);
        this.#observer?.onError(
            pending.method,
            error,
            failure,
            pending.startedAt,
            pending.finishedAt,
            pending.durationMs,
        );
        return error;
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
            if (!context.isReservationCurrent()) {
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
            const transportResult = await this.#requestPayload(payload, context, remainingMs);
            const { result } = transportResult;
            const finishedAt = this.#runtime.epochNow();
            if ("error" in result) {
                const transportError = new RpcTransportResponseError(
                    transportResult.status,
                    transportResult.headers,
                    Object.freeze({ ...(result as JsonRpcError).error }),
                );
                this.#pendingRpcFailures.set(result as JsonRpcError, {
                    durationMs: this.#runtime.monotonicNow() - startedMonotonic,
                    finishedAt,
                    method: payload.method,
                    startedAt,
                    transportError,
                });
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
            const finishedAt = this.#runtime.epochNow();
            const failure = classifyRpcTransportError(error, finishedAt);
            if (typeof error === "object" && error !== null) {
                markRpcFailure(error, failure);
            }
            this.#observer?.onError(
                payload.method,
                error,
                failure,
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
    ): Promise<TransportResult> {
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

            return {
                headers,
                result: body as JsonRpcResult,
                status: response.status,
            };
        } finally {
            context?.signal?.removeEventListener("abort", abort);
            attemptSignal?.removeEventListener("abort", abort);
            this.#runtime.clearTimeout(timeout);
        }
    }
}
