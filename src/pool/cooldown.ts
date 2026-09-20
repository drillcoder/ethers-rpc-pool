import type { RuntimeDependencies } from "./runtime.js";
import type { EndpointState } from "./state.js";

const shortBaseDelayMs = 5_000;
const shortMaxDelayMs = 60_000;
const longBaseDelayMs = 30_000;
const longMaxDelayMs = 300_000;
const maximumJitterRatio = 0.2;

interface CooldownPolicy {
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly streak: keyof EndpointState["failureStreaks"];
}

const shortPolicy: CooldownPolicy = { baseDelayMs: shortBaseDelayMs, maxDelayMs: shortMaxDelayMs, streak: "short" };
const longPolicy: CooldownPolicy = { baseDelayMs: longBaseDelayMs, maxDelayMs: longMaxDelayMs, streak: "long" };

function applyCooldown(
    endpoint: EndpointState,
    nowMs: number,
    runtime: Pick<RuntimeDependencies, "random">,
    policy: CooldownPolicy,
    retryAfterMs: number | null,
): number {
    if (endpoint.status === "excluded") {
        return endpoint.cooldownUntil ?? nowMs;
    }

    endpoint.failureStreaks[policy.streak] += 1;

    const exponentialDelayMs = policy.baseDelayMs * 2 ** (endpoint.failureStreaks[policy.streak] - 1);
    const policyDelayMs = Math.min(exponentialDelayMs, policy.maxDelayMs);
    const baseDelayMs = Math.max(policyDelayMs, retryAfterMs ?? 0);
    const cooldownDelayMs = baseDelayMs * (1 + maximumJitterRatio * runtime.random());
    const cooldownUntil = nowMs + cooldownDelayMs;

    endpoint.cooldownUntil = Math.max(endpoint.cooldownUntil ?? 0, cooldownUntil);
    endpoint.status = "cooling-down";
    endpoint.version += 1;
    return endpoint.cooldownUntil;
}

export function applyShortCooldown(
    endpoint: EndpointState,
    nowMs: number,
    runtime: Pick<RuntimeDependencies, "random">,
): number {
    return applyCooldown(endpoint, nowMs, runtime, shortPolicy, null);
}

export function applyShortCooldownWithMinimum(
    endpoint: EndpointState,
    nowMs: number,
    runtime: Pick<RuntimeDependencies, "random">,
    retryAfterMs: number | null,
): number {
    return applyCooldown(endpoint, nowMs, runtime, shortPolicy, retryAfterMs);
}

export function applyLongCooldown(
    endpoint: EndpointState,
    nowMs: number,
    runtime: Pick<RuntimeDependencies, "random">,
    retryAfterMs: number | null = null,
): number {
    return applyCooldown(endpoint, nowMs, runtime, longPolicy, retryAfterMs);
}

export function applyEndpointDataCooldown(
    endpoint: EndpointState,
    nowMs: number,
    runtime: Pick<RuntimeDependencies, "random">,
): number {
    if (endpoint.status === "excluded") {
        return endpoint.cooldownUntil ?? nowMs;
    }

    const cooldownDelayMs = shortBaseDelayMs * (1 + maximumJitterRatio * runtime.random());
    const cooldownUntil = nowMs + cooldownDelayMs;

    endpoint.cooldownUntil = Math.max(endpoint.cooldownUntil ?? 0, cooldownUntil);
    endpoint.status = "cooling-down";
    endpoint.version += 1;
    return endpoint.cooldownUntil;
}

export function excludeEndpoint(endpoint: EndpointState, reason: NonNullable<EndpointState["excludedReason"]>,): void {
    if (endpoint.status === "excluded") {
        return;
    }

    endpoint.cooldownUntil = null;
    endpoint.excludedReason = reason;
    endpoint.status = "excluded";
    endpoint.version += 1;
}
