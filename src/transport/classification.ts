import type { RpcErrorCategory } from "../observability/types.js";
import { RpcRequestTimeoutError, RpcTransportResponseError } from "./provider.js";

interface RpcErrorClassificationBase {
    readonly category: RpcErrorCategory;
    readonly httpStatus: number | null;
}

export interface RpcCooldownClassification extends RpcErrorClassificationBase {
    readonly action: "cooldown";
    readonly retryAfterMs?: number;
}

export interface RpcExcludeClassification extends RpcErrorClassificationBase {
    readonly action: "exclude";
}

export interface RpcPassThroughClassification extends RpcErrorClassificationBase {
    readonly action: "none";
}

export type RpcErrorClassification =
    | RpcCooldownClassification
    | RpcExcludeClassification
    | RpcPassThroughClassification;

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
    httpStatus: number | null,
    retryAfterMs: number | null = null,
): RpcCooldownClassification {
    const classification = {
        action: "cooldown",
        category,
        httpStatus,
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
    });
}

function passThrough(category: RpcErrorCategory, httpStatus: number | null): RpcPassThroughClassification {
    return Object.freeze({
        action: "none",
        category,
        httpStatus,
    });
}

function classifyJsonRpcError(
    error: NonNullable<RpcTransportResponseError["jsonRpcError"]>,
    httpStatus: number,
    retryAfterMs: number | null,
): RpcErrorClassification {
    const message = error.message ?? "";

    switch (error.code) {
        case -32_602:
            return passThrough("invalid-params", httpStatus);
        case -32_601:
            return passThrough("unsupported-method", httpStatus);
        case 3:
            return passThrough("contract-execution", httpStatus);
        default:
            break;
    }

    if (authorizationCodes.has(error.code)) {
        return exclude("authorization", httpStatus);
    }
    if (jsonRpcLimitSignatures.quotaLimitCodes.includes(error.code)) {
        return cooldown("quota-limit", httpStatus, retryAfterMs);
    }
    if (jsonRpcLimitSignatures.rateLimitCodes.includes(error.code)) {
        return cooldown("rate-limit", httpStatus, retryAfterMs);
    }
    if (contractExecutionPattern.test(message)) {
        return passThrough("contract-execution", httpStatus);
    }
    if (authorizationPattern.test(message)) {
        return exclude("authorization", httpStatus);
    }
    if (jsonRpcLimitSignatures.quotaLimitPattern.test(message)) {
        return cooldown("quota-limit", httpStatus, retryAfterMs);
    }
    if (jsonRpcLimitSignatures.rateLimitPattern.test(message)) {
        return cooldown("rate-limit", httpStatus, retryAfterMs);
    }

    return passThrough("unknown", httpStatus);
}

function classifyHttpResponse(error: RpcTransportResponseError, nowMs: number): RpcErrorClassification {
    const retryAfterMs = parseRetryAfter(error.headers["retry-after"], nowMs);

    switch (error.status) {
        case 401:
        case 403:
            return exclude("authorization", error.status);
        case 402:
            return cooldown("quota-limit", error.status, retryAfterMs);
        case 429:
            return cooldown("rate-limit", error.status, retryAfterMs);
        default:
            break;
    }

    if (error.jsonRpcError !== undefined) {
        const jsonRpcClassification = classifyJsonRpcError(error.jsonRpcError, error.status, retryAfterMs);
        if (jsonRpcClassification.category !== "unknown") {
            return jsonRpcClassification;
        }
    }

    if (Math.trunc(error.status / 100) === 5) {
        return cooldown("http-5xx", error.status, retryAfterMs);
    }

    if (error.invalidResponse) {
        return cooldown("endpoint-data", error.status, retryAfterMs);
    }

    return passThrough("unknown", error.status);
}

export function classifyRpcTransportError(error: unknown, nowMs = Date.now()): RpcErrorClassification {
    if (error instanceof RpcRequestTimeoutError) {
        return cooldown("timeout", null);
    }

    if (error instanceof RpcTransportResponseError) {
        return classifyHttpResponse(error, nowMs);
    }

    return cooldown("network", null);
}
