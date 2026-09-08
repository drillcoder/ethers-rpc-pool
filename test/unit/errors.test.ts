import { describe, expect, it } from "vitest";

import {
  NoUsableRpcEndpointError,
  OperationTimeoutError,
  RpcEndpointDataError,
  RpcPoolClosedError,
  UnknownNetworkError,
} from "../../src/index.js";

describe("public errors", () => {
  it("identifies endpoint data errors with instanceof", () => {
    const cause = new Error("invalid response");
    const error = new RpcEndpointDataError("inconsistent block", { cause });

    expect(error).toBeInstanceOf(RpcEndpointDataError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "RpcEndpointDataError",
      message: "inconsistent block",
      cause,
    });
    expect(new RpcEndpointDataError().message).toBe(
      "RPC endpoint returned invalid data",
    );
  });

  it("identifies unknown-network errors and exposes the chain ID", () => {
    const error = new UnknownNetworkError(137);

    expect(error).toBeInstanceOf(UnknownNetworkError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "UnknownNetworkError",
      message: "Network with chain ID 137 is not configured",
      chainId: 137,
    });
  });

  it("identifies exhausted pools without exposing endpoint URLs", () => {
    const error = new NoUsableRpcEndpointError(10);

    expect(error).toBeInstanceOf(NoUsableRpcEndpointError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "NoUsableRpcEndpointError",
      message: "Network with chain ID 10 has no usable RPC endpoints",
      chainId: 10,
    });
  });

  it("identifies operation timeouts and exposes their context", () => {
    const error = new OperationTimeoutError(1, 30_000);

    expect(error).toBeInstanceOf(OperationTimeoutError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "OperationTimeoutError",
      message: "RPC operation for chain ID 1 timed out after 30000 ms",
      chainId: 1,
      timeoutMs: 30_000,
    });
  });

  it("identifies closed-pool errors", () => {
    const cause = new Error("shutdown");
    const error = new RpcPoolClosedError({ cause });

    expect(error).toBeInstanceOf(RpcPoolClosedError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "RpcPoolClosedError",
      message: "RPC pool manager is closed",
      cause,
    });
  });

  it("keeps error classes distinct", () => {
    const error: Error = new UnknownNetworkError(1);

    expect(error).not.toBeInstanceOf(NoUsableRpcEndpointError);
    expect(error).not.toBeInstanceOf(OperationTimeoutError);
    expect(error).not.toBeInstanceOf(RpcEndpointDataError);
    expect(error).not.toBeInstanceOf(RpcPoolClosedError);
  });
});
