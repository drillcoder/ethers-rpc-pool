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

function cooldown(
  category: RpcErrorCategory,
  policy: typeof shortCooldown | typeof longCooldown,
  httpStatus: number | null,
): RpcCooldownClassification {
  return Object.freeze({
    action: "cooldown",
    category,
    httpStatus,
    retryable: true,
    ...policy,
  });
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
): RpcErrorClassification {
  const message = error.message ?? "";

  if (authorizationCodes.has(error.code) || authorizationPattern.test(message)) {
    return exclude("authorization", httpStatus);
  }

    if (
        jsonRpcLimitSignatures.quotaLimitCodes.includes(error.code) ||
        jsonRpcLimitSignatures.quotaLimitPattern.test(message)
    ) {
        return cooldown("quota-limit", longCooldown, httpStatus);
    }

    if (
        jsonRpcLimitSignatures.rateLimitCodes.includes(error.code) ||
        jsonRpcLimitSignatures.rateLimitPattern.test(message)
    ) {
        return cooldown("rate-limit", longCooldown, httpStatus);
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

function classifyHttpResponse(error: RpcTransportResponseError): RpcErrorClassification {
  switch (error.status) {
    case 401:
    case 403:
      return exclude("authorization", error.status);
    case 402:
      return cooldown("quota-limit", longCooldown, error.status);
    case 429:
      return cooldown("rate-limit", longCooldown, error.status);
    default:
      break;
  }

  if (error.jsonRpcError !== undefined) {
    return classifyJsonRpcError(error.jsonRpcError, error.status);
  }

  if (Math.trunc(error.status / 100) === 5) {
    return cooldown("http-5xx", shortCooldown, error.status);
  }

  return passThrough("unknown", error.status);
}

export function classifyRpcTransportError(error: unknown): RpcErrorClassification {
  if (error instanceof RpcRequestTimeoutError) {
    return cooldown("timeout", shortCooldown, null);
  }

  if (error instanceof RpcTransportResponseError) {
    return classifyHttpResponse(error);
  }

  return cooldown("network", shortCooldown, null);
}
