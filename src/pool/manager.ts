import { OperationTimeoutError, RpcEndpointDataError, UnknownNetworkError } from "../errors/errors.js";
import {
    createEndpointCounters,
    createRpcCounters,
    recordRpcError,
    recordRpcRequest,
} from "../observability/counters.js";
import { sanitizeEndpointUrl } from "../observability/sanitizer.js";
import type { RpcErrorCategory, RpcPoolLogger, RpcPoolLoggerEvent, RpcPoolSnapshot } from "../observability/types.js";
import { EndpointChainIdVerifier, RpcChainIdMismatchError } from "../transport/chain-id.js";
import { classifyRpcTransportError } from "../transport/classification.js";
import { EndpointJsonRpcProvider } from "../transport/provider.js";
import { normalizeManagerConfig } from "./config.js";
import { EndpointReservationUnavailableError } from "./attempt.js";
import {
    applyEndpointDataCooldown,
    applyLongCooldown,
    applyShortCooldown,
    excludeEndpointForAuthorization,
    excludeEndpointForChainIdMismatch,
} from "./cooldown.js";
import { createRetryableRpcAttempt, RetryableRpcCallError } from "./retryable-client.js";
import { createRuntime } from "./runtime.js";
import type { RuntimeDependencies, TimerHandle } from "./runtime.js";
import { createSingleRpcAttempt, SingleRpcCallError } from "./single-attempt-client.js";
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
    RetryableRpcClient,
    RpcExecutionOptions,
    RpcPoolManagerConfig,
    SingleAttemptRpcClient,
} from "./types.js";

class ManagedEndpoint implements EndpointState {
    public activeGroups = 0;
    public cooldownUntil: number | null = null;
    public readonly counters = createEndpointCounters();
    public excludedReason: EndpointState["excludedReason"] = null;
    public readonly failureStreaks: EndpointFailureStreaks = { long: 0, short: 0 };
    public latencyEwmaMs: number | null = null;
    public probeToken: EndpointState["probeToken"] = null;
    public readonly provider: EndpointJsonRpcProvider;
    public status: EndpointState["status"] = "available";
    public readonly verifier: EndpointChainIdVerifier;
    public version = 0;
    readonly #chainId: number;
    readonly #endpointId: string;
    readonly #logger: RpcPoolLogger | undefined;
    readonly #runtime: RuntimeDependencies;

    public constructor(
        public readonly endpointNumber: number,
        public readonly rpcUrl: string,
        chainId: number,
        requestTimeoutMs: number,
        counters: PoolState["counters"],
        runtime: RuntimeDependencies,
        logger: RpcPoolLogger | undefined,
    ) {
        this.#chainId = chainId;
        this.#endpointId = sanitizeEndpointUrl(rpcUrl);
        this.#logger = logger;
        this.#runtime = runtime;
        this.provider = new EndpointJsonRpcProvider(rpcUrl, chainId, {
            observer: {
                onError: (method, error, startedAt, finishedAt, durationMs) => {
                    const classification = classifyRpcTransportError(error, finishedAt);
                    recordRpcError(counters, this.counters, classification.category);
                    updateEndpointLatency(this, durationMs);
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
                    this.#emit({
                        ...this.#baseEvent("request", startedAt),
                        method,
                        startedAt,
                    });
                },
                onResponse: (method, startedAt, finishedAt, durationMs) => {
                    updateEndpointLatency(this, durationMs);
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

    public get endpointId(): string {
        return this.#endpointId;
    }

    public eventBase<Type extends RpcPoolLoggerEvent["type"]>(type: Type): {
        readonly chainId: number;
        readonly endpointId: string;
        readonly endpointNumber: number;
        readonly timestamp: number;
        readonly type: Type;
    } {
        return this.#baseEvent(type, this.#runtime.epochNow());
    }

    #baseEvent<Type extends RpcPoolLoggerEvent["type"]>(type: Type, timestamp: number) {
        return {
            chainId: this.#chainId,
            endpointId: this.#endpointId,
            endpointNumber: this.endpointNumber,
            timestamp,
            type,
        } as const;
    }

    #emit(event: RpcPoolLoggerEvent): void {
        void this.#logger?.(Object.freeze(event));
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

class OperationDeadline {
    public readonly promise: Promise<never>;
    readonly #runtime: RuntimeDependencies;
    #timer!: TimerHandle;

    public constructor(runtime: RuntimeDependencies, chainId: number, timeoutMs: number, deadlineMs: number) {
        this.#runtime = runtime;
        this.promise = new Promise<never>((_resolve, reject) => {
            this.#timer = runtime.setTimeout(() => {
                reject(new OperationTimeoutError(chainId, timeoutMs));
            }, Math.max(0, deadlineMs - runtime.monotonicNow()));
        });
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

async function raceWithAbort<Result>(operation: Promise<Result>, signal: AbortSignal | undefined): Promise<Result> {
    if (signal === undefined) {
        return await operation;
    }
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
                    activeGroups: 0,
                    chainId: network.chainId,
                    endpoints,
                    selectionCursor: 0,
                };
                return [network.chainId, state];
            })),
        };
    }

    public async executeWithRetry<Result>(
        chainId: number,
        callback: (client: RetryableRpcClient) => Promise<Result>,
        options: RpcExecutionOptions = {},
    ): Promise<Result> {
        const network = this.#network(chainId);
        const timeoutMs = options.timeoutMs ?? this.#operationTimeoutMs;
        assertOperationTimeout(timeoutMs);
        options.signal?.throwIfAborted();
        const deadlineMs = this.#runtime.monotonicNow() + timeoutMs;

        return await this.#withDeadline(
            network,
            timeoutMs,
            deadlineMs,
            async (termination) =>
                await this.#executeRetryAttempt(network, callback, options, timeoutMs, deadlineMs, termination),
            options.signal,
        );
    }

    public async executeOnce<Result>(
        chainId: number,
        callback: (client: SingleAttemptRpcClient) => Promise<Result>,
        options: RpcExecutionOptions = {},
    ): Promise<Result> {
        const network = this.#network(chainId);
        const timeoutMs = options.timeoutMs ?? this.#operationTimeoutMs;
        assertOperationTimeout(timeoutMs);
        options.signal?.throwIfAborted();
        const deadlineMs = this.#runtime.monotonicNow() + timeoutMs;

        return await this.#withDeadline(
            network,
            timeoutMs,
            deadlineMs,
            async (termination) =>
                await this.#executeOnceAttempt(network, callback, options, timeoutMs, deadlineMs, termination),
            options.signal,
        );
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
                endpointId: sanitizeEndpointUrl(endpoint.rpcUrl),
                endpointNumber: endpoint.endpointNumber,
                errorCount: endpoint.counters.errorCount,
                excludedReason: endpoint.excludedReason,
                latencyEwmaMs: endpoint.latencyEwmaMs,
                requestCount: endpoint.counters.requestCount,
                status: endpoint.status,
            }))),
        }));

        return Object.freeze({
            closed: false,
            errorsByCategory,
            networks: Object.freeze(networks),
            requestsByMethod,
            totalActiveGroups: [...this.#state.networks.values()].reduce(
                (total, network) => total + network.activeGroups,
                0,
            ),
            totalRequests: this.#state.counters.totalRequests,
        });
    }

    async #executeOnceAttempt<Result>(
        network: NetworkState<ManagedEndpoint>,
        callback: (client: SingleAttemptRpcClient) => Promise<Result>,
        options: RpcExecutionOptions,
        timeoutMs: number,
        deadlineMs: number,
        termination: Promise<never>,
        previousFailure?: PreviousFailure,
    ): Promise<Result> {
        const reservation = reserveEndpoint(network, this.#runtime.monotonicNow());
        if (reservation === null) {
            await this.#waitForEndpoint(network, options, timeoutMs, deadlineMs);
            return await this.#executeOnceAttempt(
                network,
                callback,
                options,
                timeoutMs,
                deadlineMs,
                termination,
                previousFailure,
            );
        }

        const endpoint = reservation.endpoint;
        this.#emitSwitch(previousFailure, endpoint);
        let callbackStarted = false;
        try {
            const result = await runEndpointReservation(
                network,
                reservation,
                async () => await endpoint.provider.runWithDeadline(deadlineMs, async () => {
                    await endpoint.verifier.verify();
                    options.signal?.throwIfAborted();
                    callbackStarted = true;
                    const attempt = createSingleRpcAttempt(
                        endpoint.provider,
                        () => isEndpointReservationCurrent(reservation),
                    );
                    try {
                        return await Promise.race([
                            raceWithAbort(callback(attempt.client), options.signal),
                            termination,
                        ]);
                    } finally {
                        await attempt.deactivate();
                    }
                }, options.signal),
                () => undefined,
            );
            this.#emitRecovery(reservation.requiresProbe, endpoint);
            return result;
        } catch (error: unknown) {
            options.signal?.throwIfAborted();
            const decision = this.#handleSingleFailure(endpoint, error, callbackStarted);
            notifyNetworkStateChanged(network);
            if (!decision.retry) {
                throw decision.error;
            }
            return await this.#executeOnceAttempt(
                network,
                callback,
                options,
                timeoutMs,
                deadlineMs,
                termination,
                { category: decision.category, endpoint },
            );
        }
    }

    async #executeRetryAttempt<Result>(
        network: NetworkState<ManagedEndpoint>,
        callback: (client: RetryableRpcClient) => Promise<Result>,
        options: RpcExecutionOptions,
        timeoutMs: number,
        deadlineMs: number,
        termination: Promise<never>,
        previousFailure?: PreviousFailure,
    ): Promise<Result> {
        const reservation = reserveEndpoint(network, this.#runtime.monotonicNow());
        if (reservation === null) {
            await this.#waitForEndpoint(network, options, timeoutMs, deadlineMs);
            return await this.#executeRetryAttempt(
                network,
                callback,
                options,
                timeoutMs,
                deadlineMs,
                termination,
                previousFailure,
            );
        }

        const endpoint = reservation.endpoint;
        this.#emitSwitch(previousFailure, endpoint);
        let callbackStarted = false;
        try {
            const result = await runEndpointReservation(
                network,
                reservation,
                async () => await endpoint.provider.runWithDeadline(deadlineMs, async () => {
                    await endpoint.verifier.verify();
                    options.signal?.throwIfAborted();
                    callbackStarted = true;
                    const attempt = createRetryableRpcAttempt(
                        endpoint.provider,
                        () => isEndpointReservationCurrent(reservation),
                    );
                    try {
                        return await Promise.race([
                            raceWithAbort(callback(attempt.client), options.signal),
                            termination,
                        ]);
                    } finally {
                        attempt.deactivate();
                    }
                }, options.signal),
                () => undefined,
            );
            this.#emitRecovery(reservation.requiresProbe, endpoint);
            return result;
        } catch (error: unknown) {
            options.signal?.throwIfAborted();
            const decision = this.#handleRetryFailure(endpoint, error, callbackStarted);
            notifyNetworkStateChanged(network);
            if (!decision.retry) {
                throw decision.error;
            }
            return await this.#executeRetryAttempt(
                network,
                callback,
                options,
                timeoutMs,
                deadlineMs,
                termination,
                { category: decision.category, endpoint },
            );
        }
    }

    #handleRetryFailure(endpoint: ManagedEndpoint, error: unknown, callbackStarted: boolean): RetryDecision {
        if (error instanceof EndpointReservationUnavailableError) {
            return { category: "unknown", error, retry: true };
        }
        if (error instanceof RpcEndpointDataError) {
            recordRpcError(this.#state.counters, endpoint.counters, "endpoint-data");
            const cooldownUntil = applyEndpointDataCooldown(endpoint, this.#runtime.monotonicNow(), this.#runtime);
            this.#emitCooldown(endpoint, "endpoint-data", cooldownUntil);
            return { category: "endpoint-data", error, retry: true };
        }
        if (error instanceof RpcChainIdMismatchError) {
            excludeEndpointForChainIdMismatch(endpoint);
            return { category: "endpoint-data", error, retry: true };
        }
        if (callbackStarted && !(error instanceof RetryableRpcCallError)) {
            return { category: "unknown", error, retry: false };
        }

        const transportError = error instanceof RetryableRpcCallError ? error.cause : error;
        return this.#applyTransportFailure(endpoint, transportError);
    }

    #handleSingleFailure(endpoint: ManagedEndpoint, error: unknown, callbackStarted: boolean): RetryDecision {
        if (error instanceof EndpointReservationUnavailableError) {
            return { category: "unknown", error, retry: false };
        }
        if (error instanceof RpcEndpointDataError) {
            recordRpcError(this.#state.counters, endpoint.counters, "endpoint-data");
            const cooldownUntil = applyEndpointDataCooldown(endpoint, this.#runtime.monotonicNow(), this.#runtime);
            this.#emitCooldown(endpoint, "endpoint-data", cooldownUntil);
            return { category: "endpoint-data", error, retry: false };
        }
        if (error instanceof RpcChainIdMismatchError) {
            excludeEndpointForChainIdMismatch(endpoint);
            return { category: "endpoint-data", error, retry: true };
        }
        if (callbackStarted && !(error instanceof SingleRpcCallError)) {
            return { category: "unknown", error, retry: false };
        }

        const transportError = error instanceof SingleRpcCallError ? error.cause : error;
        const decision = this.#applyTransportFailure(endpoint, transportError);
        return callbackStarted ? { ...decision, retry: false } : decision;
    }

    #applyTransportFailure(endpoint: ManagedEndpoint, transportError: unknown): RetryDecision {
        const classification = classifyRpcTransportError(transportError, this.#runtime.epochNow());
        if (!classification.retryable) {
            return { category: classification.category, error: transportError, retry: false };
        }
        if (classification.action === "exclude") {
            excludeEndpointForAuthorization(endpoint);
        } else if (classification.category === "rate-limit" || classification.category === "quota-limit") {
            const cooldownUntil = applyLongCooldown(
                endpoint,
                this.#runtime.monotonicNow(),
                this.#runtime,
                classification.retryAfterMs ?? null,
            );
            this.#emitCooldown(endpoint, classification.category, cooldownUntil);
        } else {
            const cooldownUntil = applyShortCooldown(endpoint, this.#runtime.monotonicNow(), this.#runtime);
            this.#emitCooldown(endpoint, classification.category, cooldownUntil);
        }
        return { category: classification.category, error: transportError, retry: true };
    }

    #emitCooldown(endpoint: ManagedEndpoint, category: RpcErrorCategory, cooldownUntil: number): void {
        endpoint.emit({
            ...endpoint.eventBase("cooldown"),
            category,
            cooldownUntil: this.#runtime.epochNow() + cooldownUntil - this.#runtime.monotonicNow(),
        });
    }

    #emitRecovery(requiresProbe: boolean, endpoint: ManagedEndpoint): void {
        if (requiresProbe && endpoint.status === "available") {
            endpoint.emit(endpoint.eventBase("recovery"));
        }
    }

    #emitSwitch(previousFailure: PreviousFailure | undefined, endpoint: ManagedEndpoint): void {
        if (previousFailure === undefined || previousFailure.endpoint === endpoint) {
            return;
        }
        previousFailure.endpoint.emit({
            ...previousFailure.endpoint.eventBase("switch"),
            category: previousFailure.category,
            nextEndpointId: endpoint.endpointId,
            nextEndpointNumber: endpoint.endpointNumber,
        });
    }

    async #waitForEndpoint(
        network: NetworkState<ManagedEndpoint>,
        options: RpcExecutionOptions,
        timeoutMs: number,
        deadlineMs: number,
    ): Promise<void> {
        const waitOptions = options.signal === undefined
            ? { deadlineMs, runtime: this.#runtime, timeoutMs }
            : { deadlineMs, runtime: this.#runtime, signal: options.signal, timeoutMs };
        await waitForEndpointAvailability(network, waitOptions);
    }

    #network(chainId: number): NetworkState<ManagedEndpoint> {
        const network = this.#state.networks.get(chainId);
        if (network === undefined) {
            throw new UnknownNetworkError(chainId);
        }

        return network;
    }

    async #withDeadline<Result>(
        network: NetworkState,
        timeoutMs: number,
        deadlineMs: number,
        operation: (termination: Promise<never>) => Promise<Result>,
        signal: AbortSignal | undefined,
    ): Promise<Result> {
        const timeout = new OperationDeadline(this.#runtime, network.chainId, timeoutMs, deadlineMs);

        try {
            return await raceWithAbort(operation(timeout.promise), signal);
        } finally {
            timeout.clear();
        }
    }
}
