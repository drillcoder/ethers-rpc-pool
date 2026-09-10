import { JsonRpcProvider } from "ethers";
import { describe, expect, it, vi } from "vitest";

import { EndpointJsonRpcProvider } from "../../src/transport/provider.js";
import type { HttpRequest } from "../../src/transport/provider.js";

const rpcUrl = "https://rpc.example/";

function jsonResponse(result: unknown, id: number): Response {
  return Response.json({ id, jsonrpc: "2.0", result });
}

describe("EndpointJsonRpcProvider", () => {
  it("is ethers-compatible and sends one client call as one HTTP request", async () => {
    const request = vi.fn<HttpRequest>(() =>
      Promise.resolve(jsonResponse("0x2a", 1)),
    );
    const provider = new EndpointJsonRpcProvider(rpcUrl, 1, request);

    await expect(provider.getBlockNumber()).resolves.toBe(42);

    expect(provider).toBeInstanceOf(EndpointJsonRpcProvider);
    expect(provider).toBeInstanceOf(JsonRpcProvider);
    expect(provider._getOption("batchMaxCount")).toBe(1);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(rpcUrl);
    expect(request.mock.calls[0]?.[1].body).toContain(
      '"method":"eth_blockNumber"',
    );
    expect(request.mock.calls[0]?.[1].method).toBe("POST");

    provider.destroy();
  });

  it("sends every explicitly supplied payload in its own request without retry", async () => {
    const request = vi
      .fn<HttpRequest>()
      .mockResolvedValueOnce(jsonResponse("0x1", 1))
      .mockResolvedValueOnce(jsonResponse("0x2", 2));
    const provider = new EndpointJsonRpcProvider(rpcUrl, 1, request);

    await expect(
      provider._send([
        { id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
        { id: 2, jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
      ]),
    ).resolves.toEqual([
      { id: 1, jsonrpc: "2.0", result: "0x1" },
      { id: 2, jsonrpc: "2.0", result: "0x2" },
    ]);

    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls) {
      expect(JSON.parse(call[1].body as string)).not.toBeInstanceOf(Array);
    }

    provider.destroy();
  });

  it("does not retry a failed HTTP request", async () => {
    const failure = new Error("connection lost");
    const request = vi.fn<HttpRequest>().mockRejectedValueOnce(failure);
    const provider = new EndpointJsonRpcProvider(rpcUrl, 1, request);

    await expect(
      provider._send({
        id: 1,
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
      }),
    ).rejects.toBe(failure);
    expect(request).toHaveBeenCalledOnce();

    provider.destroy();
  });
});
