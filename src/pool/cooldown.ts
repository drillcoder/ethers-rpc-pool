import type { RuntimeDependencies } from "./runtime.js";
import type { EndpointState } from "./state.js";

const shortBaseDelayMs = 5_000;
const shortMaxDelayMs = 60_000;
const maximumJitterRatio = 0.2;

export function applyShortCooldown(
    endpoint: EndpointState,
    nowMs: number,
    runtime: Pick<RuntimeDependencies, "random">,
): number {
    endpoint.failureStreaks.short += 1;

    const exponentialDelayMs = shortBaseDelayMs * 2 ** (endpoint.failureStreaks.short - 1);
    const baseDelayMs = Math.min(exponentialDelayMs, shortMaxDelayMs);
    const cooldownDelayMs = baseDelayMs * (1 + maximumJitterRatio * runtime.random());
    const cooldownUntil = nowMs + cooldownDelayMs;

    endpoint.cooldownUntil = cooldownUntil;
    endpoint.status = "cooling-down";
    return cooldownUntil;
}
