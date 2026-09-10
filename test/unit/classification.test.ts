import { describe, expect, it } from "vitest";

import {
  classifyRpcTransportError,
  jsonRpcLimitSignatures,
} from "../../src/transport/classification.js";
import { RpcRequestTimeoutError, RpcTransportResponseError } from "../../src/transport/provider.js";
import type { RpcErrorCategory } from "../../src/observability/types.js";

const noHeaders = Object.freeze({});

function responseError(status: number, code?: number, message?: string): RpcTransportResponseError {
  const jsonRpcError =
    code === undefined
      ? undefined
      : message === undefined
        ? { code }
        : { code, message };

  return new RpcTransportResponseError(status, noHeaders, jsonRpcError);
}

function expectCooldown(
  error: unknown,
  category: RpcErrorCategory,
  baseDelayMs: number,
  maxDelayMs: number,
  httpStatus: number | null,
): void {
  expect(classifyRpcTransportError(error)).toEqual({
    action: "cooldown",
    baseDelayMs,
    category,
    httpStatus,
    maxDelayMs,
    retryable: true,
  });
}

describe("classifyRpcTransportError", () => {
  it("classifies request timeouts with the short cooldown policy", () => {
    expectCooldown(new RpcRequestTimeoutError(500), "timeout", 5_000, 60_000, null);
  });

  it("classifies network failures with the short cooldown policy", () => {
    expectCooldown(new TypeError("fetch failed"), "network", 5_000, 60_000, null);
  });

  it.each([500, 503, 599])(
    "classifies HTTP %s with the short cooldown policy",
    (status) => {
      expectCooldown(responseError(status), "http-5xx", 5_000, 60_000, status);
    },
  );

  it("classifies HTTP 429 as rate limiting", () => {
    expectCooldown(responseError(429), "rate-limit", 30_000, 300_000, 429);
  });

  it("classifies HTTP 402 as quota exhaustion", () => {
    expectCooldown(responseError(402), "quota-limit", 30_000, 300_000, 402);
  });

  it.each([401, 403])(
    "classifies HTTP %s as permanent authorization exclusion",
    (status) => {
      expect(classifyRpcTransportError(responseError(status))).toEqual({
        action: "exclude",
        category: "authorization",
        httpStatus: status,
        retryable: true,
      });
    },
  );

  it.each([
    [401, "credentials rejected"],
    [-32_000, "invalid API key"],
  ])(
    "classifies JSON-RPC authorization code %s and message %s",
    (code, message) => {
      expect(classifyRpcTransportError(responseError(200, code, message))).toEqual({
        action: "exclude",
        category: "authorization",
        httpStatus: 200,
        retryable: true,
      });
    },
  );

  it("prioritizes a recognized JSON-RPC error over a generic HTTP 5xx", () => {
    expect(classifyRpcTransportError(responseError(503, -32_000, "authentication required"))).toEqual({
      action: "exclude",
      category: "authorization",
      httpStatus: 503,
      retryable: true,
    });
  });

  it.each([
    [-32_005, "provider limit", "rate-limit"],
    [429, "provider limit", "rate-limit"],
    [-32_000, "rate limit exceeded", "rate-limit"],
    [-32_000, "too many requests", "rate-limit"],
    [402, "provider limit", "quota-limit"],
    [-32_005, "quota exceeded", "quota-limit"],
    [-32_000, "credits exhausted", "quota-limit"],
    [-32_000, "compute units exhausted", "quota-limit"],
    [-32_000, "monthly capacity limit exceeded", "quota-limit"],
  ] as const)(
    "classifies JSON-RPC limit code %s and message %s as %s",
    (code, message, category) => {
      expectCooldown(responseError(200, code, message), category, 30_000, 300_000, 200);
    },
  );

  it.each([
    [-32_602, "invalid params", "invalid-params"],
    [-32_601, "method not found", "unsupported-method"],
    [3, "execution failed", "contract-execution"],
    [-32_000, "execution reverted", "contract-execution"],
    [-32_000, "limit exceeded", "unknown"],
    [-32_000, "unclassified server error", "unknown"],
  ] as const)(
    "classifies JSON-RPC code %s as %s",
    (code, message, category) => {
      expect(classifyRpcTransportError(responseError(200, code, message))).toEqual({
        action: "none",
        category,
        httpStatus: 200,
        retryable: false,
      });
    },
  );

  it.each([400, 600])(
    "passes through unrecognized HTTP status %s",
    (status) => {
      expect(classifyRpcTransportError(responseError(status))).toEqual({
        action: "none",
        category: "unknown",
        httpStatus: status,
        retryable: false,
      });
    },
  );

  it("treats a missing JSON-RPC message as an unknown pass-through error", () => {
    expect(classifyRpcTransportError(responseError(200, -32_000))).toEqual({
      action: "none",
      category: "unknown",
      httpStatus: 200,
      retryable: false,
    });
  });

  it("exposes an immutable catalog of JSON-RPC limit signatures", () => {
    expect(jsonRpcLimitSignatures.rateLimitCodes).toEqual([-32_005, 429]);
    expect(jsonRpcLimitSignatures.quotaLimitCodes).toEqual([402]);
    expect(Object.isFrozen(jsonRpcLimitSignatures)).toBe(true);
    expect(Object.isFrozen(jsonRpcLimitSignatures.rateLimitCodes)).toBe(true);
    expect(Object.isFrozen(jsonRpcLimitSignatures.quotaLimitCodes)).toBe(true);
  });
});
