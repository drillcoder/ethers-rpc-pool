import { describe, expect, it } from "vitest";

import { RpcPoolManager } from "../../src/index.js";
import {
    normalizeManagerConfig,
    validateManagerConfig,
} from "../../src/pool/config.js";
import type { RpcPoolManagerConfig } from "../../src/index.js";

const invalidPositiveSafeIntegers = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
];

const validConfig: RpcPoolManagerConfig = {
    networks: [
        {
            chainId: 1,
            rpcUrls: ["https://rpc.example"],
        },
    ],
    requestTimeoutMs: 1_000,
    operationTimeoutMs: 10_000,
};

function withConfig(
    overrides: Partial<RpcPoolManagerConfig>,
): RpcPoolManagerConfig {
    return {
        ...validConfig,
        ...overrides,
    };
}

describe("validateManagerConfig", () => {
    it("accepts positive safe-integer chain IDs and timeouts", () => {
        expect(() => {
            validateManagerConfig(validConfig);
        }).not.toThrow();
        expect(() => {
            validateManagerConfig({
                networks: [{ chainId: Number.MAX_SAFE_INTEGER, rpcUrls: ["http://rpc.example"] }],
                operationTimeoutMs: Number.MAX_SAFE_INTEGER,
                requestTimeoutMs: 1,
            });
        }).not.toThrow();
    });

    it.each(invalidPositiveSafeIntegers)(
        "rejects invalid chain ID %s",
        (chainId) => {
            const config = withConfig({
                networks: [{ chainId, rpcUrls: ["https://rpc.example"] }],
            });

            expect(() => {
                validateManagerConfig(config);
            }).toThrow(
                new RangeError(
                    "networks[0].chainId must be a positive safe integer",
                ),
            );
        },
    );

    it.each(["requestTimeoutMs", "operationTimeoutMs"] as const)("rejects every invalid %s", (property) => {
        for (const value of invalidPositiveSafeIntegers) {
            const config = withConfig({ [property]: value });

            expect(() => {
                validateManagerConfig(config);
            }).toThrow(
                new RangeError(`${property} must be a positive safe integer`),
            );
        }
    });

    it("rejects duplicate chain IDs", () => {
        const config = withConfig({
            networks: [
                { chainId: 1, rpcUrls: ["https://first.example"] },
                { chainId: 1, rpcUrls: ["https://second.example"] },
            ],
        });

        expect(() => {
            validateManagerConfig(config);
        }).toThrow(new TypeError("networks[1].chainId must be unique"));
    });

    it("rejects an empty RPC URL list", () => {
        const config = withConfig({
            networks: [{ chainId: 1, rpcUrls: [] }],
        });

        expect(() => {
            validateManagerConfig(config);
        }).toThrow(
            new TypeError("networks[0].rpcUrls must not be empty"),
        );
    });

    it("rejects every invalid configuration synchronously through the public constructor", () => {
        const invalidConfigs = [
            withConfig({ requestTimeoutMs: 0 }),
            withConfig({ operationTimeoutMs: 0 }),
            withConfig({ networks: [{ chainId: 0, rpcUrls: ["https://rpc.example"] }] }),
            withConfig({ networks: [{ chainId: 1, rpcUrls: [] }] }),
            withConfig({ networks: [{ chainId: 1, rpcUrls: ["wss://rpc.example"] }] }),
            withConfig({
                networks: [
                    { chainId: 1, rpcUrls: ["https://first.example"] },
                    { chainId: 1, rpcUrls: ["https://second.example"] },
                ],
            }),
        ];

        for (const config of invalidConfigs) {
            expect(() => new RpcPoolManager(config)).toThrow();
        }
    });
});

describe("normalizeManagerConfig", () => {
    it("normalizes and deduplicates equivalent URLs in first-seen order", () => {
        const config = withConfig({
            networks: [
                {
                    chainId: 1,
                    rpcUrls: [
                        "HTTP://FIRST.EXAMPLE:80",
                        "https://SECOND.example:443/rpc",
                        "http://first.example/",
                        "https://second.example/rpc",
                        "https://third.example?token=value#fragment",
                    ],
                },
            ],
        });

        const normalized = normalizeManagerConfig(config);

        expect(normalized.networks[0]?.rpcUrls).toEqual([
            "http://first.example/",
            "https://second.example/rpc",
            "https://third.example/?token=value#fragment",
        ]);
        expect(config.networks[0]?.rpcUrls).toHaveLength(5);
    });

    it("accepts both supported protocols and applies standard URL normalization", () => {
        const normalized = normalizeManagerConfig(withConfig({
            networks: [{
                chainId: 1,
                rpcUrls: [
                    "http://USER:PASS@RPC.EXAMPLE:80/a/../rpc?token=value#fragment",
                    "https://RPC.EXAMPLE:443",
                ],
            }],
        }));

        expect(normalized.networks[0]?.rpcUrls).toEqual([
            "http://USER:PASS@rpc.example/rpc?token=value#fragment",
            "https://rpc.example/",
        ]);
    });

    it.each([
        ["ftp://rpc.example", "must use the HTTP or HTTPS protocol"],
        ["ws://rpc.example", "must use the HTTP or HTTPS protocol"],
        ["rpc.example", "must be a valid HTTP or HTTPS URL"],
        ["/rpc", "must be a valid HTTP or HTTPS URL"],
        ["", "must be a valid HTTP or HTTPS URL"],
    ])("rejects unsupported RPC URL %s", (rpcUrl, message) => {
        const config = withConfig({
            networks: [{ chainId: 1, rpcUrls: [rpcUrl] }],
        });

        expect(() => normalizeManagerConfig(config)).toThrow(
            new TypeError(`networks[0].rpcUrls[0] ${message}`),
        );
    });

    it("reports the location of a malformed URL", () => {
        const config = withConfig({
            networks: [
                { chainId: 1, rpcUrls: ["https://first.example"] },
                { chainId: 2, rpcUrls: ["https://second.example", "not a URL"] },
            ],
        });

        expect(() => {
            normalizeManagerConfig(config);
        }).toThrow(
            new TypeError(
                "networks[1].rpcUrls[1] must be a valid HTTP or HTTPS URL",
            ),
        );
    });
});
