import { NoUsableRpcEndpointError, OperationTimeoutError } from "../errors/errors.js";
import type { RpcEndpointExcludedReason, RpcEndpointStatus } from "../observability/types.js";
import type { RuntimeDependencies, TimerHandle } from "./runtime.js";
import type { RpcNetworkConfig } from "./types.js";

const latencyEwmaWeight = 0.2;
const networkStateListeners = new WeakMap<NetworkState, Set<() => void>>();

export interface EndpointFailureStreaks {
    long: number;
    short: number;
}

export type EndpointProbeToken = symbol;

export interface EndpointState {
    readonly endpointNumber: number;
    readonly rpcUrl: string;
    activeGroups: number;
    cooldownUntil: number | null;
    excludedReason: RpcEndpointExcludedReason;
    readonly failureStreaks: EndpointFailureStreaks;
    latencyEwmaMs: number | null;
    probeToken: EndpointProbeToken | null;
    status: RpcEndpointStatus;
    version: number;
}

export interface NetworkState<Endpoint extends EndpointState = EndpointState> {
    readonly chainId: number;
    readonly endpoints: readonly Endpoint[];
    activeGroups: number;
    selectionCursor: number;
}

export interface PoolState<Endpoint extends EndpointState = EndpointState> {
    readonly networks: ReadonlyMap<number, NetworkState<Endpoint>>;
}

export interface EndpointCandidate<Endpoint extends EndpointState = EndpointState> {
    readonly endpoint: Endpoint;
    readonly requiresProbe: boolean;
}

export interface EndpointReservation<Endpoint extends EndpointState = EndpointState>
    extends EndpointCandidate<Endpoint> {
    readonly probeToken: EndpointProbeToken | null;
    readonly version: number;
}

export type EndpointReservationFailureHandler = (error: unknown, endpoint: EndpointState) => void;

export interface EndpointAvailabilityWaitOptions {
    readonly deadlineMs: number;
    readonly runtime: Pick<RuntimeDependencies, "clearTimeout" | "monotonicNow" | "setTimeout">;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
}

function createEndpointState(rpcUrl: string, endpointNumber: number): EndpointState {
    return {
        endpointNumber,
        rpcUrl,
        activeGroups: 0,
        cooldownUntil: null,
        excludedReason: null,
        failureStreaks: {
            long: 0,
            short: 0,
        },
        latencyEwmaMs: null,
        probeToken: null,
        status: "available",
        version: 0,
    };
}

export function createPoolState(networks: readonly RpcNetworkConfig[]): PoolState {
    return {
        networks: new Map(
            networks.map((network) => [
                network.chainId,
                {
                    chainId: network.chainId,
                    endpoints: network.rpcUrls.map((rpcUrl, index) => createEndpointState(rpcUrl, index + 1)),
                    activeGroups: 0,
                    selectionCursor: 0,
                },
            ]),
        ),
    };
}

function selectRoundRobin<Endpoint extends EndpointState>(
    network: NetworkState<Endpoint>,
    candidates: readonly EndpointCandidate<Endpoint>[],
): EndpointCandidate<Endpoint> {
    const endpointCount = network.endpoints.length;
    const cursor = network.selectionCursor;
    return candidates.reduce((current, candidate) => {
        const currentDistance = (current.endpoint.endpointNumber - 1 - cursor + endpointCount) % endpointCount;
        const candidateDistance = (candidate.endpoint.endpointNumber - 1 - cursor + endpointCount) % endpointCount;
        return candidateDistance < currentDistance ? candidate : current;
    });
}

export function getEndpointCandidates<Endpoint extends EndpointState>(
    network: NetworkState<Endpoint>,
    nowMs: number,
): readonly EndpointCandidate<Endpoint>[] {
    return network.endpoints.flatMap<EndpointCandidate<Endpoint>>((endpoint) => {
        if (endpoint.status === "available") {
            return [{ endpoint, requiresProbe: false }];
        }

        if (endpoint.status === "cooling-down" && endpoint.cooldownUntil !== null && endpoint.cooldownUntil <= nowMs) {
            return [{ endpoint, requiresProbe: true }];
        }

        return [];
    });
}

export function selectEndpointCandidate<Endpoint extends EndpointState>(
    network: NetworkState<Endpoint>,
    candidates: readonly EndpointCandidate<Endpoint>[],
): EndpointCandidate<Endpoint> | null {
    if (candidates.length === 0) {
        return null;
    }

    const minimumActiveGroups = Math.min(...candidates.map(({ endpoint }) => endpoint.activeGroups));
    const leastActive = candidates.filter(({ endpoint }) => endpoint.activeGroups === minimumActiveGroups);
    let preferred = leastActive.filter(({ endpoint }) => endpoint.latencyEwmaMs === null);

    if (preferred.length === 0) {
        const measured = leastActive as readonly (EndpointCandidate<Endpoint> & {
            endpoint: { latencyEwmaMs: number };
        })[];
        const minimumLatency = Math.min(...measured.map(({ endpoint }) => endpoint.latencyEwmaMs));
        preferred = leastActive.filter(({ endpoint }) => endpoint.latencyEwmaMs === minimumLatency);
    }

    return selectRoundRobin(network, preferred);
}

export function reserveEndpoint<Endpoint extends EndpointState>(
    network: NetworkState<Endpoint>,
    nowMs: number,
): EndpointReservation<Endpoint> | null {
    const selected = selectEndpointCandidate(network, getEndpointCandidates(network, nowMs));
    if (selected === null) {
        return null;
    }

    const probeToken = selected.requiresProbe ? Symbol("endpoint-probe") : null;
    if (probeToken !== null) {
        selected.endpoint.probeToken = probeToken;
        selected.endpoint.status = "probe";
    }

    network.selectionCursor = selected.endpoint.endpointNumber % network.endpoints.length;
    selected.endpoint.activeGroups += 1;
    network.activeGroups += 1;
    return { ...selected, probeToken, version: selected.endpoint.version };
}

export function isEndpointReservationCurrent(reservation: EndpointReservation): boolean {
    if (reservation.endpoint.version !== reservation.version) {
        return false;
    }

    return reservation.probeToken === null
        ? reservation.endpoint.status === "available"
        : reservation.endpoint.status === "probe" && reservation.endpoint.probeToken === reservation.probeToken;
}

export function notifyNetworkStateChanged(network: NetworkState): void {
    for (const listener of networkStateListeners.get(network) ?? []) {
        listener();
    }
}

export function waitForEndpointAvailability(
    network: NetworkState,
    options: EndpointAvailabilityWaitOptions,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let timer: TimerHandle | null = null;
        const listeners = networkStateListeners.get(network) ?? new Set<() => void>();
        networkStateListeners.set(network, listeners);

        const cleanup = (): void => {
            listeners.delete(evaluate);
            options.signal?.removeEventListener("abort", abort);
            if (timer !== null) {
                options.runtime.clearTimeout(timer);
                timer = null;
            }
        };
        const settle = (error?: unknown): void => {
            cleanup();
            if (error === undefined) {
                resolve();
            } else {
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve reason.
                reject(error);
            }
        };
        const abort = (): void => {
            if (options.signal !== undefined) {
                settle(options.signal.reason);
            }
        };
        function evaluate(): void {
            if (timer !== null) {
                options.runtime.clearTimeout(timer);
                timer = null;
            }

            const nowMs = options.runtime.monotonicNow();
            if (getEndpointCandidates(network, nowMs).length > 0) {
                settle();
                return;
            }

            if (network.endpoints.every(({ status }) => status === "excluded")) {
                settle(new NoUsableRpcEndpointError(network.chainId));
                return;
            }

            const remainingMs = options.deadlineMs - nowMs;
            if (remainingMs <= 0) {
                settle(new OperationTimeoutError(network.chainId, options.timeoutMs));
                return;
            }

            const cooldownDeadlines = network.endpoints.flatMap(({ cooldownUntil, status }) =>
                status === "cooling-down" && cooldownUntil !== null ? [cooldownUntil] : []);
            const nearestCooldownMs = Math.min(...cooldownDeadlines, options.deadlineMs);
            timer = options.runtime.setTimeout(evaluate, Math.max(0, nearestCooldownMs - nowMs));
        }

        listeners.add(evaluate);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted === true) {
            abort();
        } else {
            evaluate();
        }
    });
}

function releaseEndpointReservation(network: NetworkState, reservation: EndpointReservation): void {
    reservation.endpoint.activeGroups -= 1;
    network.activeGroups -= 1;

    if (reservation.probeToken !== null && reservation.endpoint.probeToken === reservation.probeToken) {
        reservation.endpoint.probeToken = null;
        if (reservation.endpoint.status === "probe") {
            reservation.endpoint.status = "cooling-down";
        }
    }

    notifyNetworkStateChanged(network);
}

function recoverProbedEndpoint(reservation: EndpointReservation): void {
    if (
        reservation.probeToken === null
        || reservation.endpoint.probeToken !== reservation.probeToken
        || reservation.endpoint.version !== reservation.version
        || reservation.endpoint.status === "excluded"
    ) {
        return;
    }

    reservation.endpoint.cooldownUntil = null;
    reservation.endpoint.failureStreaks.long = 0;
    reservation.endpoint.failureStreaks.short = 0;
    reservation.endpoint.status = "available";
}

export async function runEndpointReservation<Result>(
    network: NetworkState,
    reservation: EndpointReservation,
    operation: () => Promise<Result>,
    onFailure: EndpointReservationFailureHandler,
): Promise<Result> {
    let succeeded = false;

    try {
        const result = await operation();
        succeeded = true;
        return result;
    } catch (error: unknown) {
        onFailure(error, reservation.endpoint);
        throw error;
    } finally {
        if (succeeded) {
            recoverProbedEndpoint(reservation);
        }

        releaseEndpointReservation(network, reservation);
    }
}

export function updateEndpointLatency(endpoint: EndpointState, sampleMs: number): void {
    const previous = endpoint.latencyEwmaMs;
    endpoint.latencyEwmaMs = previous === null
        ? sampleMs
        : latencyEwmaWeight * sampleMs + (1 - latencyEwmaWeight) * previous;
}

export async function runMeasuredEndpointCall<Result>(
    endpoint: EndpointState,
    runtime: Pick<RuntimeDependencies, "monotonicNow">,
    operation: () => Promise<Result>,
): Promise<Result> {
    const startedAt = runtime.monotonicNow();

    try {
        return await operation();
    } finally {
        updateEndpointLatency(endpoint, runtime.monotonicNow() - startedAt);
    }
}
