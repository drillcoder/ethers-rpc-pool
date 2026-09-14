import { describe, expect, it, vi } from "vitest";

import { createRetryableRpcClient } from "../../src/pool/retryable-client.js";
import { EndpointJsonRpcProvider } from "../../src/transport/provider.js";

const methodNames = [
    "call",
    "estimateGas",
    "getBalance",
    "getBlock",
    "getBlockNumber",
    "getCode",
    "getFeeData",
    "getLogs",
    "getNetwork",
    "getStorage",
    "getTransaction",
    "getTransactionCount",
    "getTransactionReceipt",
    "getTransactionResult",
    "lookupAddress",
    "resolveName",
    "waitForBlock",
    "waitForTransaction",
] as const;

describe("createRetryableRpcClient", () => {
    it("exposes exactly the standard read, simulation, name-resolution, and wait methods", () => {
        const provider = new EndpointJsonRpcProvider("https://rpc.example", 1, { requestTimeoutMs: 1_000 });
        const client = createRetryableRpcClient(provider);

        expect(Object.keys(client)).toEqual(methodNames);
        expect(Object.values(client).every((value) => typeof value === "function")).toBe(true);
        expect("broadcastTransaction" in client).toBe(false);
        expect("send" in client).toBe(false);
        expect("destroy" in client).toBe(false);
        expect("provider" in client).toBe(false);
        expect("on" in client).toBe(false);
        expect(Object.isFrozen(client)).toBe(true);

        provider.destroy();
    });

    it("delegates calls to the bound endpoint provider", async () => {
        const provider = new EndpointJsonRpcProvider("https://rpc.example", 1, { requestTimeoutMs: 1_000 });
        const getBalance = vi.spyOn(provider, "getBalance").mockResolvedValue(42n);
        const client = createRetryableRpcClient(provider);

        await expect(client.getBalance("vitalik.eth", 123)).resolves.toBe(42n);
        expect(getBalance).toHaveBeenCalledWith("vitalik.eth", 123);

        provider.destroy();
    });
});
