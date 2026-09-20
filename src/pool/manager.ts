import type { JsonRpcProvider } from "ethers";

import {
    OperationTimeoutError,
    RpcEndpointDataError,
    RpcPoolClosedError,
    UnknownNetworkError,
} from "../errors/errors.js";
import {
    createEndpointCounters,
    createRpcCounters,
    recordRpcError,
    recordRpcRequest,
} from "../observability/counters.js";
import type { RpcErrorCategory, RpcPoolLogger, RpcPoolLoggerEvent, RpcPoolSnapshot } from "../observability/types.js";
import { EndpointChainIdVerifier, RpcChainIdMismatchError } from "../transport/chain-id.js";
import type { RpcErrorClassification } from "../transport/classification.js";
import { EndpointJsonRpcProvider, getRpcFailure } from "../transport/provider.js";
import { normalizeManagerConfig } from "./config.js";
import { EndpointReservationUnavailableError } from "./attempt.js";
import {
    applyEndpointDataCooldown,
    applyLongCooldown,
    applyShortCooldownWithMinimum,
    excludeEndpoint,
} from "./cooldown.js";
import { createRuntime } from "./runtime.js";
import type { RuntimeDependencies, TimerHandle } from "./runtime.js";
import {
    isEndpointReservationCurrent,
    notifyNetworkStateChanged,
    reserveEndpoint,
    runEndpointReservation,
    updateEndpointLatency,
    waitForEndpointAvailability,
} from "./state.js";
import type { EndpointFailureStreaks, EndpointState, NetworkState, PoolState } from "./state.js";
import type {
    RpcExecutionOptions,
    RpcPoolManagerConfig,
} from "./types.js";

class ManagedEndpoint implements EndpointState {
    public activeGroups = 0;
    public cooldownUntil: number | null = null;
    public readonly counters = createEndpointCounters();
    public excludedReason: EndpointState["excludedReason"] = null;
    public readonly failureStreaks: EndpointFailureStreaks = { long: 0, short: 0 };
    public latencyEwmaMs: number | null = null;
    public lastReserved = 0;
    public probeToken: EndpointState["probeToken"] = null;
    public readonly provider: EndpointJsonRpcProvider;
    public status: EndpointState["status"] = "available";
    public readonly verifier: EndpointChainIdVerifier;
    public version = 0;
    readonly #chainId: number;
    public readonly hostname: string;
    readonly #logger: RpcPoolLogger | undefined;
    readonly #runtime: RuntimeDependencies;

    public constructor(
        public readonly endpointNumber: number,
        rpcUrl: string,
        chainId: number,
        requestTimeoutMs: number,
        counters: PoolState["counters"],
        runtime: RuntimeDependencies,
        logger: RpcPoolLogger | undefined,
    ) {
        this.#chainId = chainId;
        this.hostname = new URL(rpcUrl).hostname;
        this.#logger = logger;
        this.#runtime = runtime;
        this.provider = new EndpointJsonRpcProvider(rpcUrl, chainId, {
            observer: {
                onError: (method, _error, classification, startedAt, finishedAt, durationMs) => {
                    recordRpcError(counters, this.counters, classification.category);
                    updateEndpointLatency(this, durationMs);
                    if (this.#logger === undefined) {
                        return;
                    }
                    this.#emit({
                        ...this.#transportEvent("error", method, startedAt, finishedAt),
                        category: classification.category,
                        durationMs,
                        ...(classification.httpStatus === null ? {} : { httpStatus: classification.httpStatus }),
                        ...("retryAfterMs" in classification
                            ? { retryAfterMs: classification.retryAfterMs }
                            : {}),
                    });
                },
                onRequest: (method, startedAt) => {
                    recordRpcRequest(counters, this.counters, method);
                    if (this.#logger === undefined) {
                        return;
                    }
                    this.#emit({
                        ...this.#baseEvent("request", startedAt),
                        method,
                        startedAt,
                    });
                },
                onResponse: (method, startedAt, finishedAt, durationMs) => {
                    updateEndpointLatency(this, durationMs);
                    if (this.#logger === undefined) {
                        return;
                    }
                    this.#emit({
                        ...this.#transportEvent("response", method, startedAt, finishedAt),
                        durationMs,
                    });
                },
            },
            requestTimeoutMs,
        });
        this.verifier = new EndpointChainIdVerifier(this.provider, chainId);
    }

    public emit(event: RpcPoolLoggerEvent): void {
        this.#emit(event);
    }

    public get loggingEnabled(): boolean {
        return this.#logger !== undefined;
    }

    public eventBase<Type extends RpcPoolLoggerEvent["type"]>(type: Type): {
        readonly chainId: number;
        readonly hostname: string;
        readonly endpointNumber: number;
        readonly timestamp: number;
        readonly type: Type;
    } {
        return this.#baseEvent(type, this.#runtime.epochNow());
    }

    #baseEvent<Type extends RpcPoolLoggerEvent["type"]>(type: Type, timestamp: number) {
        return {
            chainId: this.#chainId,
            hostname: this.hostname,
            endpointNumber: this.endpointNumber,
            timestamp,
            type,
        } as const;
    }

    #emit(event: RpcPoolLoggerEvent): void {
        try {
            void Promise.resolve(this.#logger?.(Object.freeze(event))).catch(() => undefined);
        } catch {
            // Logging is observational and must not affect pool control flow.
        }
    }

    #transportEvent<Type extends "error" | "response">(
        type: Type,
        method: string,
        startedAt: number,
        finishedAt: number,
    ) {
        return { ...this.#baseEvent(type, finishedAt), finishedAt, method, startedAt } as const;
    }
}

interface RetryDecision {
    readonly category: RpcErrorCategory;
    readonly error: unknown;
    readonly retry: boolean;
}

interface PreviousFailure {
    readonly category: RpcErrorCategory;
    readonly endpoint: ManagedEndpoint;
}

type OperationOptions = Omit<RpcExecutionOptions, "signal"> & { readonly signal: AbortSignal };
type ExecutionMode = "once" | "retry";

class OperationDeadline {
    public readonly signal: AbortSignal;
    readonly #controller = new AbortController();
    readonly #runtime: RuntimeDependencies;
    #timer!: TimerHandle;

    public constructor(runtime: RuntimeDependencies, chainId: number, timeoutMs: number, deadlineMs: number) {
        this.#runtime = runtime;
        this.signal = this.#controller.signal;
        this.#timer = runtime.setTimeout(() => {
            this.#controller.abort(new OperationTimeoutError(chainId, timeoutMs));
        }, Math.max(0, deadlineMs - runtime.monotonicNow()));
    }

    public clear(): void {
        this.#runtime.clearTimeout(this.#timer);
    }
}

function assertOperationTimeout(timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError("timeoutMs must be a positive safe integer");
    }
}

async function raceWithAbort<Result>(operation: Promise<Result>, signal: AbortSignal): Promise<Result> {
    signal.throwIfAborted();

    let abort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
        abort = (): void => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve signal.reason.
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
    });

    return await Promise.race([operation, cancellation]).finally(() => {
        signal.removeEventListener("abort", abort);
    });
}

export class RpcPoolManager {
    readonly #closeController = new AbortController();
    #closed = false;
    #closePromise: Promise<void> | null = null;
    readonly #operationTimeoutMs: number;
    readonly #runtime: RuntimeDependencies;
    readonly #state: PoolState<ManagedEndpoint>;

    public constructor(config: RpcPoolManagerConfig) {
        const normalized = normalizeManagerConfig(config);
        this.#operationTimeoutMs = normalized.operationTimeoutMs;
        this.#runtime = createRuntime();
        const counters = createRpcCounters();
        this.#state = {
            counters,
            networks: new Map(normalized.networks.map((network) => {
                const endpoints = network.rpcUrls.map((rpcUrl, index) => new ManagedEndpoint(
                    index + 1,
                    rpcUrl,
                    network.chainId,
                    normalized.requestTimeoutMs,
                    counters,
                    this.#runtime,
                    normalized.logger,
                ));
                const state: NetworkState<ManagedEndpoint> = {
                    chainId: network.chainId,
                    endpoints,
                    primaryRetrySelections: 0,
                    reservationClock: 0,
                    selectionCursor: 0,
                };
                return [network.chainId, state];
            })),
        };
    }

    public async executeWithRetry<Result>(
        chainId: number,
        callback: (provider: JsonRpcProvider) => Promise<Result>,
        options: RpcExecutionOptions = {},
    ): Promise<Result> {
        return await this.#execute(
            chainId,
            callback,
            options,
            "retry",
        );
    }

    public async executeOnce<Result>(
        chainId: number,
        callback: (provider: JsonRpcProvider) => Promise<Result>,
        options: RpcExecutionOptions = {},
    ): Promise<Result> {
        return await this.#execute(
            chainId,
            callback,
            options,
            "once",
        );
    }

    public close(): Promise<void> {
        if (this.#closePromise !== null) {
            return this.#closePromise;
        }

        this.#closed = true;
        this.#closeController.abort(new RpcPoolClosedError());
        for (const network of this.#state.networks.values()) {
            for (const endpoint of network.endpoints) {
                endpoint.provider.destroy();
            }
        }
        this.#closePromise = Promise.resolve();
        return this.#closePromise;
    }

    public getSnapshot(): RpcPoolSnapshot {
        const monotonicNow = this.#runtime.monotonicNow();
        const epochNow = this.#runtime.epochNow();
        const requestsByMethod = Object.freeze(Object.fromEntries(this.#state.counters.requestsByMethod));
        const errorsByCategory = Object.freeze(Object.fromEntries(this.#state.counters.errorsByCategory));
        const networks = [...this.#state.networks.values()].map((network) => Object.freeze({
            chainId: network.chainId,
            endpoints: Object.freeze(network.endpoints.map((endpoint) => Object.freeze({
                activeGroups: endpoint.activeGroups,
                cooldownUntil: endpoint.cooldownUntil === null
                    ? null
                    : epochNow + endpoint.cooldownUntil - monotonicNow,
                hostname: endpoint.hostname,
                endpointNumber: endpoint.endpointNumber,
                errorCount: endpoint.counters.errorCount,
                excludedReason: endpoint.excludedReason,
                latencyEwmaMs: endpoint.latencyEwmaMs,
                requestCount: endpoint.counters.requestCount,
                status: endpoint.status,
            }))),
        }));

        return Object.freeze({
            closed: this.#closed,
            errorsByCategory,
            networks: Object.freeze(networks),
            requestsByMethod,
            totalActiveGroups: [...this.#state.networks.values()].reduce((total, network) =>
                total + network.endpoints.reduce((networkTotal, endpoint) =>
                    networkTotal + endpoint.activeGroups, 0), 0),
            totalRequests: this.#state.counters.totalRequests,
        });
    }

    async #execute<Result>(
        chainId: number,
        callback: (client: EndpointJsonRpcProvider) => Promise<Result>,
        options: RpcExecutionOptions,
        mode: ExecutionMode,
    ): Promise<Result> {
        this.#assertOpen();
        const network = this.#network(chainId);
        const timeoutMs = options.timeoutMs ?? this.#operationTimeoutMs;
        assertOperationTimeout(timeoutMs);
        options.signal?.throwIfAborted();
        const deadlineMs = this.#runtime.monotonicNow() + timeoutMs;
        const deadline = new OperationDeadline(this.#runtime, chainId, timeoutMs, deadlineMs);
        const operationOptions = this.#operationOptions(options, deadline.signal);

        try {
            return await this.#executeAttempts(
                network,
                callback,
                operationOptions,
                deadlineMs,
                mode,
            );
        } finally {
            deadline.clear();
        }
    }

    async #executeAttempts<Result>(
        network: NetworkState<ManagedEndpoint>,
        callback: (client: EndpointJsonRpcProvider) => Promise<Result>,
        options: OperationOptions,
        deadlineMs: number,
        mode: ExecutionMode,
    ): Promise<Result> {
        let previousFailure: PreviousFailure | undefined;
        let primaryAttempt = true;
        for (;;) {
            options.signal.throwIfAborted();
            const reservation = reserveEndpoint(network, this.#runtime.monotonicNow(), mode, primaryAttempt);
            if (reservation === null) {
                await this.#waitForEndpoint(network, options);
                continue;
            }

            const endpoint = reservation.endpoint;
            this.#emitSwitch(previousFailure, endpoint);
            let callbackStarted = false;
            try {
                const result = await runEndpointReservation(network, reservation, async () =>
                    await endpoint.provider.runWithDeadline(deadlineMs, async () => {
                        await endpoint.verifier.verify();
                        options.signal.throwIfAborted();
                        callbackStarted = true;
                        return await raceWithAbort(callback(endpoint.provider), options.signal);
                    }, options.signal, () => isEndpointReservationCurrent(reservation)));
                this.#emitRecovery(reservation.requiresProbe, endpoint);
                return result;
            } catch (error: unknown) {
                options.signal.throwIfAborted();
                const decision = this.#handleFailure(endpoint, error, callbackStarted, mode);
                notifyNetworkStateChanged(network);
                if (!decision.retry) {
                    throw decision.error;
                }
                previousFailure = { category: decision.category, endpoint };
                primaryAttempt = false;
            }
        }
    }

    #handleFailure(
        endpoint: ManagedEndpoint,
        error: unknown,
        callbackStarted: boolean,
        mode: ExecutionMode,
    ): RetryDecision {
        if (error instanceof EndpointReservationUnavailableError) {
            return { category: "unknown", error, retry: mode === "retry" };
        }
        if (error instanceof RpcEndpointDataError) {
            recordRpcError(this.#state.counters, endpoint.counters, "endpoint-data");
            const cooldownUntil = applyEndpointDataCooldown(endpoint, this.#runtime.monotonicNow(), this.#runtime);
            this.#emitCooldown(endpoint, "endpoint-data", cooldownUntil);
            return { category: "endpoint-data", error, retry: mode === "retry" };
        }
        if (error instanceof RpcChainIdMismatchError) {
            excludeEndpoint(endpoint, "chain-id-mismatch");
            return { category: "endpoint-data", error, retry: true };
        }
        const failure = getRpcFailure(error);
        if (failure === undefined) {
            return { category: "unknown", error, retry: false };
        }
        const decision = this.#applyTransportFailure(endpoint, error, failure);
        return mode === "once" && callbackStarted ? { ...decision, retry: false } : decision;
    }

    #applyTransportFailure(
        endpoint: ManagedEndpoint,
        error: unknown,
        classification: RpcErrorClassification,
    ): RetryDecision {
        if (classification.action === "none") {
            return { category: classification.category, error, retry: false };
        }
        if (classification.action === "exclude") {
            excludeEndpoint(endpoint, "authorization");
        } else if (classification.category === "rate-limit" || classification.category === "quota-limit") {
            const cooldownUntil = applyLongCooldown(
                endpoint,
                this.#runtime.monotonicNow(),
                this.#runtime,
                classification.retryAfterMs ?? null,
            );
            this.#emitCooldown(endpoint, classification.category, cooldownUntil);
        } else {
            const cooldownUntil = applyShortCooldownWithMinimum(
                endpoint,
                this.#runtime.monotonicNow(),
                this.#runtime,
                classification.retryAfterMs ?? null,
            );
            this.#emitCooldown(endpoint, classification.category, cooldownUntil);
        }
        return { category: classification.category, error, retry: true };
    }

    #emitCooldown(endpoint: ManagedEndpoint, category: RpcErrorCategory, cooldownUntil: number): void {
        if (!endpoint.loggingEnabled) {
            return;
        }
        endpoint.emit({
            ...endpoint.eventBase("cooldown"),
            category,
            cooldownUntil: this.#runtime.epochNow() + cooldownUntil - this.#runtime.monotonicNow(),
        });
    }

    #emitRecovery(requiresProbe: boolean, endpoint: ManagedEndpoint): void {
        if (requiresProbe && endpoint.status === "available" && endpoint.loggingEnabled) {
            endpoint.emit(endpoint.eventBase("recovery"));
        }
    }

    #emitSwitch(previousFailure: PreviousFailure | undefined, endpoint: ManagedEndpoint): void {
        if (previousFailure === undefined || previousFailure.endpoint === endpoint || !previousFailure.endpoint.loggingEnabled) {
            return;
        }
        previousFailure.endpoint.emit({
            ...previousFailure.endpoint.eventBase("switch"),
            category: previousFailure.category,
            nextHostname: endpoint.hostname,
            nextEndpointNumber: endpoint.endpointNumber,
        });
    }

    async #waitForEndpoint(network: NetworkState<ManagedEndpoint>, options: OperationOptions,): Promise<void> {
        await waitForEndpointAvailability(network, {
            runtime: this.#runtime,
            signal: options.signal,
        });
    }

    #network(chainId: number): NetworkState<ManagedEndpoint> {
        const network = this.#state.networks.get(chainId);
        if (network === undefined) {
            throw new UnknownNetworkError(chainId);
        }

        return network;
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw new RpcPoolClosedError();
        }
    }

    #operationOptions(options: RpcExecutionOptions, deadlineSignal: AbortSignal): OperationOptions {
        const signals = options.signal === undefined
            ? [this.#closeController.signal, deadlineSignal]
            : [options.signal, this.#closeController.signal, deadlineSignal];
        const signal = AbortSignal.any(signals);
        return { ...options, signal };
    }
}
