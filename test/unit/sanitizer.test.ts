import { describe, expect, it } from "vitest";

import { sanitizeEndpointUrl } from "../../src/observability/sanitizer.js";

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
