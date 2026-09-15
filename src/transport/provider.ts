import { AsyncLocalStorage } from "node:async_hooks";

import { JsonRpcProvider } from "ethers";
import type {
    JsonRpcError,
    JsonRpcPayload,
    JsonRpcResult,
    Networkish,
} from "ethers";

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
    onComplete(durationMs: number): void;
    onError(error: unknown): void;
    onRequest(method: string): void;
}

interface RequestContext {
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
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

    public constructor(
        url: string,
        network: Networkish,
        options: EndpointJsonRpcProviderOptions,
    ) {
        super(url, network, {
            batchMaxCount: 1,
            staticNetwork: true,
        });

        this.#url = url;
        this.#observer = options.observer;
        this.#request = options.request ?? globalThis.fetch;
        this.#requestTimeoutMs = options.requestTimeoutMs;
        this.#runtime = createRuntime(options.runtime);
    }

    public runWithDeadline<Result>(
        deadlineMs: number,
        operation: () => Promise<Result>,
        signal?: AbortSignal,
    ): Promise<Result> {
        const context = signal === undefined ? { deadlineMs } : { deadlineMs, signal };
        return this.#context.run(context, operation);
    }

    public override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
        const payloads = Array.isArray(payload) ? payload : [payload];

        return await Promise.all(
            payloads.map(async (singlePayload) => await this.#sendOne(singlePayload)),
        );
    }

    async #sendOne(payload: JsonRpcPayload): Promise<JsonRpcResult> {
        const context = this.#context.getStore();
        const deadlineMs = context?.deadlineMs;
        const remainingMs =
            deadlineMs === undefined
                ? Number.POSITIVE_INFINITY
                : deadlineMs - this.#runtime.monotonicNow();
        if (remainingMs <= 0) {
            throw new RpcRequestTimeoutError(0);
        }

        this.#observer?.onRequest(payload.method);
        const startedAt = this.#runtime.monotonicNow();
        try {
            return await this.#requestPayload(payload, context, remainingMs);
        } catch (error: unknown) {
            this.#observer?.onError(error);
            throw error;
        } finally {
            this.#observer?.onComplete(this.#runtime.monotonicNow() - startedAt);
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
            controller.abort(context?.signal?.reason);
        };
        if (context?.signal?.aborted === true) {
            abort();
        } else {
            context?.signal?.addEventListener("abort", abort, { once: true });
        }
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
            if (!response.ok || jsonRpcError !== undefined) {
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
            this.#runtime.clearTimeout(timeout);
        }
    }
}
