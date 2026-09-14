import type { RpcErrorCategory } from "../observability/types.js";
import { RpcRequestTimeoutError, RpcTransportResponseError } from "./provider.js";

interface RpcErrorClassificationBase {
    readonly category: RpcErrorCategory;
    readonly httpStatus: number | null;
}

export interface RpcCooldownClassification extends RpcErrorClassificationBase {
    readonly action: "cooldown";
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly retryAfterMs?: number;
    readonly retryable: true;
}

export interface RpcExcludeClassification extends RpcErrorClassificationBase {
    readonly action: "exclude";
    readonly retryable: true;
}

export interface RpcPassThroughClassification extends RpcErrorClassificationBase {
    readonly action: "none";
    readonly retryable: false;
}

export type RpcErrorClassification =
    | RpcCooldownClassification
    | RpcExcludeClassification
    | RpcPassThroughClassification;

const shortCooldown = { baseDelayMs: 5_000, maxDelayMs: 60_000 } as const;

const longCooldown = { baseDelayMs: 30_000, maxDelayMs: 300_000 } as const;

const authorizationPattern = /\b(?:access denied|authentication required|forbidden|invalid api key|unauthorized)\b/iu;
const contractExecutionPattern = /\b(?:execution reverted|revert)\b/iu;
const authorizationCodes = new Set([401, 403]);

export const jsonRpcLimitSignatures = Object.freeze({
    quotaLimitCodes: Object.freeze([402]),
    quotaLimitPattern:
        /\b(?:(?:compute units?|credits?|quota) exhausted|monthly capacity limit exceeded|quota exceeded)\b/iu,
    rateLimitCodes: Object.freeze([-32_005, 429]),
    rateLimitPattern: /\b(?:rate limit(?:ed| exceeded| reached)?|too many requests)\b/iu,
});

export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
    if (value === undefined) {
        return null;
    }

    const normalized = value.trim();
    if (/^[+-]?\d+(?:\.\d+)?$/u.test(normalized)) {
        const seconds = Number(normalized);
        const milliseconds = seconds * 1_000;

        return seconds >= 0 && Number.isFinite(milliseconds) ? milliseconds : null;
    }

    const timestamp = Date.parse(normalized);
    return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - nowMs);
}

function cooldown(
    category: RpcErrorCategory,
    policy: typeof shortCooldown | typeof longCooldown,
    httpStatus: number | null,
    retryAfterMs: number | null = null,
): RpcCooldownClassification {
    const classification = {
        action: "cooldown",
        category,
        httpStatus,
        retryable: true,
        ...policy,
    } as const;

    return retryAfterMs === null
        ? Object.freeze(classification)
        : Object.freeze({ ...classification, retryAfterMs });
}

function exclude(category: RpcErrorCategory, httpStatus: number | null): RpcExcludeClassification {
    return Object.freeze({
        action: "exclude",
        category,
        httpStatus,
        retryable: true,
    });
}

function passThrough(category: RpcErrorCategory, httpStatus: number | null): RpcPassThroughClassification {
    return Object.freeze({
        action: "none",
        category,
        httpStatus,
        retryable: false,
    });
}

function classifyJsonRpcError(
    error: NonNullable<RpcTransportResponseError["jsonRpcError"]>,
    httpStatus: number,
    retryAfterMs: number | null,
): RpcErrorClassification {
    const message = error.message ?? "";

    if (authorizationCodes.has(error.code) || authorizationPattern.test(message)) {
        return exclude("authorization", httpStatus);
    }

    if (
        jsonRpcLimitSignatures.quotaLimitCodes.includes(error.code) ||
        jsonRpcLimitSignatures.quotaLimitPattern.test(message)
    ) {
        return cooldown("quota-limit", longCooldown, httpStatus, retryAfterMs);
    }

    if (
        jsonRpcLimitSignatures.rateLimitCodes.includes(error.code) ||
        jsonRpcLimitSignatures.rateLimitPattern.test(message)
    ) {
        return cooldown("rate-limit", longCooldown, httpStatus, retryAfterMs);
    }

    switch (error.code) {
        case -32_602:
            return passThrough("invalid-params", httpStatus);
        case -32_601:
            return passThrough("unsupported-method", httpStatus);
        case 3:
            return passThrough("contract-execution", httpStatus);
        default:
            if (contractExecutionPattern.test(message)) {
                return passThrough("contract-execution", httpStatus);
            }

            return passThrough("unknown", httpStatus);
    }
}

function classifyHttpResponse(error: RpcTransportResponseError, nowMs: number): RpcErrorClassification {
    const retryAfterMs = parseRetryAfter(error.headers["retry-after"], nowMs);

    switch (error.status) {
        case 401:
        case 403:
            return exclude("authorization", error.status);
        case 402:
            return cooldown("quota-limit", longCooldown, error.status, retryAfterMs);
        case 429:
            return cooldown("rate-limit", longCooldown, error.status, retryAfterMs);
        default:
            break;
    }

    if (error.jsonRpcError !== undefined) {
        return classifyJsonRpcError(error.jsonRpcError, error.status, retryAfterMs);
    }

    if (Math.trunc(error.status / 100) === 5) {
        return cooldown("http-5xx", shortCooldown, error.status, retryAfterMs);
    }

    return passThrough("unknown", error.status);
}

export function classifyRpcTransportError(error: unknown, nowMs = Date.now()): RpcErrorClassification {
    if (error instanceof RpcRequestTimeoutError) {
        return cooldown("timeout", shortCooldown, null);
    }

    if (error instanceof RpcTransportResponseError) {
        return classifyHttpResponse(error, nowMs);
    }

    return cooldown("network", shortCooldown, null);
}
