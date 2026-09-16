import { describe, expect, it } from "vitest";

import { sanitizeEndpointUrl, sanitizeExternalError } from "../../src/observability/sanitizer.js";

describe("sanitizeEndpointUrl", () => {
    it.each([
        [
            "https://user:password@rpc.example/v3/0123456789abcdef0123456789abcdef?apiKey=query-secret#fragment",
            "https://rpc.example/v3/[redacted]",
        ],
        ["https://rpc.example/token/project-id", "https://rpc.example/[redacted]/project-id"],
        ["https://rpc.example/public/rpc", "https://rpc.example/public/rpc"],
        ["not a URL", "[invalid-endpoint]"],
    ])("sanitizes %s", (input, expected) => {
        expect(sanitizeEndpointUrl(input)).toBe(expected);
    });

    it("handles a malformed escaped path without exposing its secret-like segment", () => {
        expect(sanitizeEndpointUrl("https://rpc.example/api%ZZtoken")).toBe("https://rpc.example/[redacted]");
    });
});

describe("sanitizeExternalError", () => {
    it("keeps safe diagnostics while removing URLs and credentials", () => {
        const error = new Error(
            "failed https://user:password@rpc.example/v3/0123456789abcdef0123456789abcdef?token=query-secret "
            + "Authorization: Bearer header-secret apiKey=inline-secret",
        );
        const sanitized = sanitizeExternalError(error);
        const serialized = JSON.stringify(sanitized);

        expect(sanitized).toEqual({
            message: "failed https://rpc.example/v3/[redacted] Authorization=[redacted] apiKey=[redacted]",
            name: "Error",
        });
        expect(serialized).not.toContain("password");
        expect(serialized).not.toContain("query-secret");
        expect(serialized).not.toContain("header-secret");
        expect(serialized).not.toContain("inline-secret");
        expect(Object.isFrozen(sanitized)).toBe(true);
    });

    it("sanitizes non-Error values without copying their properties", () => {
        expect(sanitizeExternalError("token=consumer-secret")).toEqual({
            message: "token=[redacted]",
            name: "Error",
        });
    });
});
