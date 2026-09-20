import { NoUsableRpcEndpointError } from "../errors/errors.js";
import type { EndpointCounters, RpcCounters } from "../observability/counters.js";
import type { RpcEndpointExcludedReason, RpcEndpointStatus } from "../observability/types.js";
import type { RuntimeDependencies, TimerHandle } from "./runtime.js";

const latencyEwmaWeight = 0.2;
const networkStateListeners = new WeakMap<NetworkState, Set<() => void>>();

export interface EndpointFailureStreaks {
    long: number;
    short: number;
}

export type EndpointProbeToken = symbol;

export interface EndpointState {
    activeGroups: number;
    readonly counters: EndpointCounters;
    readonly endpointNumber: number;
    cooldownUntil: number | null;
    excludedReason: RpcEndpointExcludedReason;
    readonly failureStreaks: EndpointFailureStreaks;
    latencyEwmaMs: number | null;
    lastReserved: number;
    probeToken: EndpointProbeToken | null;
    status: RpcEndpointStatus;
    version: number;
}

export interface NetworkState<Endpoint extends EndpointState = EndpointState> {
    readonly chainId: number;
    readonly endpoints: readonly Endpoint[];
    primaryRetrySelections: number;
    reservationClock: number;
    selectionCursor: number;
}

export type EndpointSelectionMode = "once" | "retry";

export interface PoolState<Endpoint extends EndpointState = EndpointState> {
    readonly counters: RpcCounters;
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

export interface EndpointAvailabilityWaitOptions {
    readonly runtime: Pick<RuntimeDependencies, "clearTimeout" | "monotonicNow" | "setTimeout">;
    readonly signal: AbortSignal;
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

    const measured = candidates.filter((candidate): candidate is EndpointCandidate<Endpoint> & {
        endpoint: Endpoint & { latencyEwmaMs: number };
    } => candidate.endpoint.latencyEwmaMs !== null);
    let preferred: readonly EndpointCandidate<Endpoint>[];
    if (measured.length > 0) {
        const score = (endpoint: Endpoint & { latencyEwmaMs: number }): number =>
            endpoint.latencyEwmaMs * (endpoint.activeGroups + 1);
        const minimumScore = Math.min(...measured.map(({ endpoint }) => score(endpoint)));
        preferred = measured.filter(({ endpoint }) => score(endpoint) === minimumScore);
    } else {
        const minimumActiveGroups = Math.min(...candidates.map(({ endpoint }) => endpoint.activeGroups));
        preferred = candidates.filter(({ endpoint }) => endpoint.activeGroups === minimumActiveGroups);
    }

    return selectRoundRobin(network, preferred);
}

export function reserveEndpoint<Endpoint extends EndpointState>(
    network: NetworkState<Endpoint>,
    nowMs: number,
    mode: EndpointSelectionMode = "once",
    primaryAttempt = false,
): EndpointReservation<Endpoint> | null {
    const candidates = getEndpointCandidates(network, nowMs);
    const coldCandidates = mode === "retry" && primaryAttempt
        ? candidates.filter(({ endpoint }) =>
            endpoint.latencyEwmaMs === null && endpoint.activeGroups === 0)
        : [];
    let selected = coldCandidates.length > 0
        ? selectRoundRobin(network, coldCandidates)
        : selectEndpointCandidate(network, candidates);
    if (selected === null) {
        return null;
    }

    if (mode === "retry" && primaryAttempt && coldCandidates.length === 0) {
        network.primaryRetrySelections += 1;
        if (network.primaryRetrySelections % 20 === 0) {
            const alternatives = candidates.filter(({ endpoint }) =>
                endpoint !== selected?.endpoint && endpoint.activeGroups === 0);
            if (alternatives.length > 0) {
                const oldest = Math.min(...alternatives.map(({ endpoint }) => endpoint.lastReserved));
                selected = selectRoundRobin(
                    network,
                    alternatives.filter(({ endpoint }) => endpoint.lastReserved === oldest),
                );
            }
        }
    }

    const probeToken = selected.requiresProbe ? Symbol("endpoint-probe") : null;
    if (probeToken !== null) {
        selected.endpoint.probeToken = probeToken;
        selected.endpoint.status = "probe";
    }

    network.selectionCursor = selected.endpoint.endpointNumber % network.endpoints.length;
    network.reservationClock += 1;
    selected.endpoint.lastReserved = network.reservationClock;
    selected.endpoint.activeGroups += 1;
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
        const signal = options.signal;
        networkStateListeners.set(network, listeners);

        const cleanup = (): void => {
            listeners.delete(evaluate);
            signal.removeEventListener("abort", abort);
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
            settle(signal.reason);
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

            const cooldownDeadlines = network.endpoints.flatMap(({ cooldownUntil, status }) =>
                status === "cooling-down" && cooldownUntil !== null ? [cooldownUntil] : []);
            if (cooldownDeadlines.length > 0) {
                const nearestCooldownMs = Math.min(...cooldownDeadlines);
                timer = options.runtime.setTimeout(evaluate, Math.max(0, nearestCooldownMs - nowMs));
            }
        }

        listeners.add(evaluate);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
            abort();
        } else {
            evaluate();
        }
    });
}

function releaseEndpointReservation(network: NetworkState, reservation: EndpointReservation): void {
    reservation.endpoint.activeGroups -= 1;

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
): Promise<Result> {
    let succeeded = false;

    try {
        const result = await operation();
        succeeded = true;
        return result;
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
