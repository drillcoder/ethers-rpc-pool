import { OperationTimeoutError, RpcEndpointDataError, UnknownNetworkError } from "../errors/errors.js";
import {
    createEndpointCounters,
    createRpcCounters,
    recordRpcError,
    recordRpcRequest,
} from "../observability/counters.js";
import type { RpcPoolSnapshot } from "../observability/types.js";
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

    public constructor(
        public readonly endpointNumber: number,
        public readonly rpcUrl: string,
        chainId: number,
        requestTimeoutMs: number,
        counters: PoolState["counters"],
        runtime: RuntimeDependencies,
    ) {
        this.provider = new EndpointJsonRpcProvider(rpcUrl, chainId, {
            observer: {
                onComplete: (durationMs) => {
                    updateEndpointLatency(this, durationMs);
                },
                onError: (error) => {
                    const classification = classifyRpcTransportError(error, runtime.epochNow());
                    recordRpcError(counters, this.counters, classification.category);
                },
                onRequest: (method) => {
                    recordRpcRequest(counters, this.counters, method);
                },
            },
            requestTimeoutMs,
        });
        this.verifier = new EndpointChainIdVerifier(this.provider, chainId);
    }
}

interface RetryDecision {
    readonly error: unknown;
    readonly retry: boolean;
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
                endpointId: new URL(endpoint.rpcUrl).origin,
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
    ): Promise<Result> {
        const reservation = reserveEndpoint(network, this.#runtime.monotonicNow());
        if (reservation === null) {
            await this.#waitForEndpoint(network, options, timeoutMs, deadlineMs);
            return await this.#executeOnceAttempt(network, callback, options, timeoutMs, deadlineMs, termination);
        }

        const endpoint = reservation.endpoint;
        let callbackStarted = false;
        try {
            return await runEndpointReservation(
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
        } catch (error: unknown) {
            options.signal?.throwIfAborted();
            const decision = this.#handleSingleFailure(endpoint, error, callbackStarted);
            notifyNetworkStateChanged(network);
            if (!decision.retry) {
                throw decision.error;
            }
            return await this.#executeOnceAttempt(network, callback, options, timeoutMs, deadlineMs, termination);
        }
    }

    async #executeRetryAttempt<Result>(
        network: NetworkState<ManagedEndpoint>,
        callback: (client: RetryableRpcClient) => Promise<Result>,
        options: RpcExecutionOptions,
        timeoutMs: number,
        deadlineMs: number,
        termination: Promise<never>,
    ): Promise<Result> {
        const reservation = reserveEndpoint(network, this.#runtime.monotonicNow());
        if (reservation === null) {
            await this.#waitForEndpoint(network, options, timeoutMs, deadlineMs);
            return await this.#executeRetryAttempt(network, callback, options, timeoutMs, deadlineMs, termination);
        }

        const endpoint = reservation.endpoint;
        let callbackStarted = false;
        try {
            return await runEndpointReservation(
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
        } catch (error: unknown) {
            options.signal?.throwIfAborted();
            const decision = this.#handleRetryFailure(endpoint, error, callbackStarted);
            notifyNetworkStateChanged(network);
            if (!decision.retry) {
                throw decision.error;
            }
            return await this.#executeRetryAttempt(network, callback, options, timeoutMs, deadlineMs, termination);
        }
    }

    #handleRetryFailure(endpoint: ManagedEndpoint, error: unknown, callbackStarted: boolean): RetryDecision {
        if (error instanceof EndpointReservationUnavailableError) {
            return { error, retry: true };
        }
        if (error instanceof RpcEndpointDataError) {
            recordRpcError(this.#state.counters, endpoint.counters, "endpoint-data");
            applyEndpointDataCooldown(endpoint, this.#runtime.monotonicNow(), this.#runtime);
            return { error, retry: true };
        }
        if (error instanceof RpcChainIdMismatchError) {
            excludeEndpointForChainIdMismatch(endpoint);
            return { error, retry: true };
        }
        if (callbackStarted && !(error instanceof RetryableRpcCallError)) {
            return { error, retry: false };
        }

        const transportError = error instanceof RetryableRpcCallError ? error.cause : error;
        return this.#applyTransportFailure(endpoint, transportError);
    }

    #handleSingleFailure(endpoint: ManagedEndpoint, error: unknown, callbackStarted: boolean): RetryDecision {
        if (error instanceof EndpointReservationUnavailableError) {
            return { error, retry: false };
        }
        if (error instanceof RpcEndpointDataError) {
            recordRpcError(this.#state.counters, endpoint.counters, "endpoint-data");
            applyEndpointDataCooldown(endpoint, this.#runtime.monotonicNow(), this.#runtime);
            return { error, retry: false };
        }
        if (error instanceof RpcChainIdMismatchError) {
            excludeEndpointForChainIdMismatch(endpoint);
            return { error, retry: true };
        }
        if (callbackStarted && !(error instanceof SingleRpcCallError)) {
            return { error, retry: false };
        }

        const transportError = error instanceof SingleRpcCallError ? error.cause : error;
        const decision = this.#applyTransportFailure(endpoint, transportError);
        return callbackStarted ? { ...decision, retry: false } : decision;
    }

    #applyTransportFailure(endpoint: ManagedEndpoint, transportError: unknown): RetryDecision {
        const classification = classifyRpcTransportError(transportError, this.#runtime.epochNow());
        if (!classification.retryable) {
            return { error: transportError, retry: false };
        }
        if (classification.action === "exclude") {
            excludeEndpointForAuthorization(endpoint);
        } else if (classification.category === "rate-limit" || classification.category === "quota-limit") {
            applyLongCooldown(
                endpoint,
                this.#runtime.monotonicNow(),
                this.#runtime,
                classification.retryAfterMs ?? null,
            );
        } else {
            applyShortCooldown(endpoint, this.#runtime.monotonicNow(), this.#runtime);
        }
        return { error: transportError, retry: true };
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
