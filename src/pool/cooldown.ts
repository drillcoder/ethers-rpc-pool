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
    endpoint.failureStreaks[policy.streak] += 1;

    const exponentialDelayMs = policy.baseDelayMs * 2 ** (endpoint.failureStreaks[policy.streak] - 1);
    const policyDelayMs = Math.min(exponentialDelayMs, policy.maxDelayMs);
    const baseDelayMs = Math.max(policyDelayMs, retryAfterMs ?? 0);
    const cooldownDelayMs = baseDelayMs * (1 + maximumJitterRatio * runtime.random());
    const cooldownUntil = nowMs + cooldownDelayMs;

    endpoint.cooldownUntil = cooldownUntil;
    endpoint.status = "cooling-down";
    return cooldownUntil;
}

export function applyShortCooldown(
    endpoint: EndpointState,
    nowMs: number,
    runtime: Pick<RuntimeDependencies, "random">,
): number {
    return applyCooldown(endpoint, nowMs, runtime, shortPolicy, null);
}

export function applyLongCooldown(
    endpoint: EndpointState,
    nowMs: number,
    runtime: Pick<RuntimeDependencies, "random">,
    retryAfterMs: number | null = null,
): number {
    return applyCooldown(endpoint, nowMs, runtime, longPolicy, retryAfterMs);
}
