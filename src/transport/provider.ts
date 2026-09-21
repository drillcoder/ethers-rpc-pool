import { AsyncLocalStorage } from "node:async_hooks";

import { JsonRpcProvider, makeError } from "ethers";
import type {
    JsonRpcError,
    JsonRpcPayload,
    JsonRpcResult,
    Networkish,
    Subscriber,
    Subscription,
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
    public readonly invalidResponse: boolean;

    public constructor(
        status: number,
        headers: Readonly<Record<string, string>>,
        jsonRpcError: Readonly<JsonRpcError["error"]> | undefined,
        options?: ErrorOptions,
        invalidResponse = false,
    ) {
        super("RPC transport received an error response", options);
        this.status = status;
        this.headers = headers;
        this.jsonRpcError = jsonRpcError;
        this.invalidResponse = invalidResponse;
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
    readonly #subscriberWrappers = new WeakMap<Subscriber, Subscriber>();
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
        return (response as { readonly result: unknown }).result;
    }

    public override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
        const payloads = Array.isArray(payload) ? payload : [payload];

        return await Promise.all(
            payloads.map(async (singlePayload) => await this.#sendOne(singlePayload)),
        );
    }

    public override _getSubscriber(subscription: Subscription): Subscriber {
        return this.#wrapSubscriber(super._getSubscriber(subscription));
    }

    public override _recoverSubscriber(oldSubscriber: Subscriber, newSubscriber: Subscriber): void {
        super._recoverSubscriber(
            this.#wrapSubscriber(oldSubscriber),
            this.#wrapSubscriber(newSubscriber),
        );
    }

    #wrapSubscriber(subscriber: Subscriber): Subscriber {
        const existing = this.#subscriberWrappers.get(subscriber);
        if (existing !== undefined) {
            return existing;
        }
        const runOutsideAttempt = (operation: () => void): void => {
            this.#context.exit(operation);
        };
        const wrapper: Subscriber = {
            pause: (dropWhilePaused?: boolean) => {
                runOutsideAttempt(() => {
                    subscriber.pause(dropWhilePaused);
                });
            },
            resume: () => {
                runOutsideAttempt(() => {
                    subscriber.resume();
                });
            },
            start: () => {
                runOutsideAttempt(() => {
                    subscriber.start();
                });
            },
            stop: () => {
                runOutsideAttempt(() => {
                    subscriber.stop();
                });
            },
        };
        if (subscriber.pollingInterval !== undefined) {
            Object.defineProperty(wrapper, "pollingInterval", {
                configurable: true,
                enumerable: true,
                get: () => subscriber.pollingInterval,
                set: (value: number) => {
                    subscriber.pollingInterval = value;
                },
            });
        }
        this.#subscriberWrappers.set(subscriber, wrapper);
        return wrapper;
    }

    async #sendOne(payload: JsonRpcPayload): Promise<JsonRpcResult> {
        if (this.destroyed) {
            throw makeError("provider destroyed", "UNSUPPORTED_OPERATION", { operation: "send" });
        }
        const context = this.#context.getStore();
        if (context !== undefined) {
            context.signal?.throwIfAborted();
            context.controller.signal.throwIfAborted();
            if (!context.isReservationCurrent()) {
                throw new EndpointReservationUnavailableError();
            }
        }
        const serializedBody = JSON.stringify(payload);
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
            const transportResult = await this.#requestPayload(payload, serializedBody, context, remainingMs);
            const { result } = transportResult;
            const finishedAt = this.#runtime.epochNow();
            if ("error" in result) {
                const transportError = new RpcTransportResponseError(
                    transportResult.status,
                    transportResult.headers,
                    Object.freeze({ ...(result as JsonRpcError).error }),
                );
                const error = super.getRpcError(payload, result as JsonRpcError);
                const failure = classifyRpcTransportError(transportError, finishedAt);
                markRpcFailure(error, failure);
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
            this.#observer?.onResponse(
                payload.method,
                startedAt,
                finishedAt,
                this.#runtime.monotonicNow() - startedMonotonic,
            );
            return result;
        } catch (error: unknown) {
            if (getRpcFailure(error) !== undefined) {
                throw error;
            }
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
        serializedBody: string,
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
                body: serializedBody,
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
                    response.ok,
                );
            }

            const validEnvelope = isJsonRpcResult(body, payload.id);
            const jsonRpcError = validEnvelope && "error" in (body as JsonRpcResult)
                ? (body as JsonRpcError).error
                : undefined;
            if (!response.ok) {
                throw new RpcTransportResponseError(
                    response.status,
                    headers,
                    jsonRpcError === undefined
                        ? undefined
                        : Object.freeze({ ...jsonRpcError }),
                );
            }

            if (!validEnvelope) {
                throw new RpcTransportResponseError(
                    response.status,
                    headers,
                    undefined,
                    undefined,
                    true,
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

function isJsonRpcResult(body: unknown, expectedId: number | string): body is JsonRpcResult {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return false;
    }
    const record = body as Record<string, unknown>;
    if (record.jsonrpc !== "2.0" || record.id !== expectedId) {
        return false;
    }
    const hasResult = Object.hasOwn(record, "result");
    const hasError = Object.hasOwn(record, "error");
    if (hasResult === hasError) {
        return false;
    }
    if (!hasError) {
        return true;
    }
    const error = record.error;
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
        return false;
    }
    const rpcError = error as Record<string, unknown>;
    return typeof rpcError.code === "number" && Number.isInteger(rpcError.code) && typeof rpcError.message === "string";
}
