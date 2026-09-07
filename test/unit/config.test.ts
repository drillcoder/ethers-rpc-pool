import { describe, expect, it } from "vitest";

import { validateManagerConfig } from "../../src/pool/config.js";
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
