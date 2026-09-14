import { OperationTimeoutError, UnknownNetworkError } from "../errors/errors.js";
import { EndpointChainIdVerifier } from "../transport/chain-id.js";
import { EndpointJsonRpcProvider } from "../transport/provider.js";
import { normalizeManagerConfig } from "./config.js";
import { createRetryableRpcClient } from "./retryable-client.js";
import { createRuntime } from "./runtime.js";
import type { RuntimeDependencies, TimerHandle } from "./runtime.js";
import {
    reserveEndpoint,
    runEndpointReservation,
} from "./state.js";
import type { EndpointFailureStreaks, EndpointState, NetworkState, PoolState } from "./state.js";
import type {
    RetryableRpcClient,
    RpcExecutionOptions,
    RpcPoolManagerConfig,
    SingleAttemptRpcClient,
} from "./types.js";

interface ManagedEndpoint extends EndpointState {
    readonly provider: EndpointJsonRpcProvider;
    readonly verifier: EndpointChainIdVerifier;
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

export class RpcPoolManager {
    readonly #operationTimeoutMs: number;
    readonly #runtime: RuntimeDependencies;
    readonly #state: PoolState<ManagedEndpoint>;

    public constructor(config: RpcPoolManagerConfig) {
        const normalized = normalizeManagerConfig(config);
        this.#operationTimeoutMs = normalized.operationTimeoutMs;
        this.#runtime = createRuntime();
        this.#state = {
            networks: new Map(normalized.networks.map((network) => {
                const endpoints = network.rpcUrls.map((rpcUrl, index): ManagedEndpoint => {
                    const provider = new EndpointJsonRpcProvider(rpcUrl, network.chainId, {
                        requestTimeoutMs: normalized.requestTimeoutMs,
                    });
                    const failureStreaks: EndpointFailureStreaks = { long: 0, short: 0 };
                    return {
                        activeGroups: 0,
                        cooldownUntil: null,
                        endpointNumber: index + 1,
                        excludedReason: null,
                        failureStreaks,
                        latencyEwmaMs: null,
                        probeToken: null,
                        provider,
                        rpcUrl,
                        status: "available",
                        verifier: new EndpointChainIdVerifier(provider, network.chainId),
                        version: 0,
                    };
                });
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
        return await this.#execute(
            chainId,
            async (provider) => await callback(createRetryableRpcClient(provider)),
            options,
        );
    }

    public async executeOnce<Result>(
        chainId: number,
        callback: (client: SingleAttemptRpcClient) => Promise<Result>,
        options: RpcExecutionOptions = {},
    ): Promise<Result> {
        return await this.#execute(chainId, callback, options);
    }

    async #execute<Result>(
        chainId: number,
        callback: (client: EndpointJsonRpcProvider) => Promise<Result>,
        options: RpcExecutionOptions,
    ): Promise<Result> {
        const network = this.#network(chainId);
        const timeoutMs = options.timeoutMs ?? this.#operationTimeoutMs;
        assertOperationTimeout(timeoutMs);
        const deadlineMs = this.#runtime.monotonicNow() + timeoutMs;

        return await this.#withDeadline(network, timeoutMs, deadlineMs, async () => {
            const reservation = reserveEndpoint(network, this.#runtime.monotonicNow());
            if (reservation === null) {
                throw new OperationTimeoutError(network.chainId, timeoutMs);
            }
            const managed = reservation.endpoint;

            return await runEndpointReservation(
                network,
                reservation,
                async () => await managed.provider.runWithDeadline(
                    deadlineMs,
                    async () => await managed.verifier.run(async () => await callback(managed.provider)),
                ),
                () => undefined,
            );
        });
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
        operation: () => Promise<Result>,
    ): Promise<Result> {
        const timeout = new OperationDeadline(this.#runtime, network.chainId, timeoutMs, deadlineMs);

        try {
            return await Promise.race([operation(), timeout.promise]);
        } finally {
            timeout.clear();
        }
    }
}
