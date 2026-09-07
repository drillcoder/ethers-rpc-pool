import { describe, expect, it } from "vitest";

import {
  normalizeManagerConfig,
  validateManagerConfig,
} from "../../src/pool/config.js";
import type { RpcPoolManagerConfig } from "../../src/pool/types.js";

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
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
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

  it.each(["requestTimeoutMs", "operationTimeoutMs"] as const)(
    "rejects an invalid %s",
    (property) => {
      const config = withConfig({ [property]: 0 });

      expect(() => {
        validateManagerConfig(config);
      }).toThrow(
        new RangeError(`${property} must be a positive safe integer`),
      );
    },
  );

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

  it.each(["ftp://rpc.example", "ws://rpc.example", "rpc.example", "/rpc"])(
    "rejects unsupported RPC URL %s",
    (rpcUrl) => {
      const config = withConfig({
        networks: [{ chainId: 1, rpcUrls: [rpcUrl] }],
      });

      expect(() => {
        normalizeManagerConfig(config);
      }).toThrow(TypeError);
    },
  );

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
