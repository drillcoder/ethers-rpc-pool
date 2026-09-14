import { Block, FeeData, Log, Network, Signature, TransactionReceipt, TransactionResponse } from "ethers";
import { describe, expect, it, vi } from "vitest";

import { createRetryableRpcAttempt } from "../../src/pool/retryable-client.js";
import { EndpointJsonRpcProvider } from "../../src/transport/provider.js";

const methodNames = [
    "call", "estimateGas", "getBalance", "getBlock", "getBlockNumber", "getCode", "getFeeData", "getLogs",
    "getNetwork", "getStorage", "getTransaction", "getTransactionCount", "getTransactionReceipt",
    "getTransactionResult", "lookupAddress", "resolveName", "waitForBlock", "waitForTransaction",
] as const;

function createProvider(): EndpointJsonRpcProvider {
    return new EndpointJsonRpcProvider("https://rpc.example", 1, { requestTimeoutMs: 1_000 });
}

const address = "0x0000000000000000000000000000000000000001";
const hash = `0x${"00".repeat(32)}`;

describe("createRetryableRpcAttempt", () => {
    it("exposes exactly the standard read, simulation, name-resolution, and wait methods", () => {
        const provider = createProvider();
        const { client } = createRetryableRpcAttempt(provider);

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

    it("delegates calls while active and rejects them after deactivation", async () => {
        const provider = createProvider();
        const getBalance = vi.spyOn(provider, "getBalance").mockResolvedValue(42n);
        const attempt = createRetryableRpcAttempt(provider);

        await expect(attempt.client.getBalance("vitalik.eth", 123)).resolves.toBe(42n);
        expect(getBalance).toHaveBeenCalledWith("vitalik.eth", 123);

        attempt.deactivate();
        await expect(attempt.client.getBalance("vitalik.eth")).rejects.toThrow(
            "RPC client attempt is no longer active",
        );
        expect(getBalance).toHaveBeenCalledOnce();
        provider.destroy();
    });

    it("guards and delegates every method with a direct result", async () => {
        const provider = createProvider();
        vi.spyOn(provider, "call").mockResolvedValue("0x01");
        vi.spyOn(provider, "estimateGas").mockResolvedValue(1n);
        vi.spyOn(provider, "getBlockNumber").mockResolvedValue(1);
        vi.spyOn(provider, "getCode").mockResolvedValue("0x01");
        vi.spyOn(provider, "getFeeData").mockResolvedValue(new FeeData(1n, 2n, 3n));
        vi.spyOn(provider, "getNetwork").mockResolvedValue(Network.from(1));
        vi.spyOn(provider, "getStorage").mockResolvedValue("0x01");
        vi.spyOn(provider, "getTransactionCount").mockResolvedValue(1);
        vi.spyOn(provider, "getTransactionResult").mockResolvedValue("0x01");
        vi.spyOn(provider, "lookupAddress").mockResolvedValue("vitalik.eth");
        vi.spyOn(provider, "resolveName").mockResolvedValue(address);
        const { client } = createRetryableRpcAttempt(provider);

        await expect(Promise.all([
            client.call({ to: address }),
            client.estimateGas({ to: address }),
            client.getBlockNumber(),
            client.getCode(address, 1),
            client.getFeeData(),
            client.getNetwork(),
            client.getStorage(address, 0, 1),
            client.getTransactionCount(address, 1),
            client.getTransactionResult(hash),
            client.lookupAddress(address, 60),
            client.resolveName("vitalik.eth", 60),
        ])).resolves.toHaveLength(11);

        provider.destroy();
    });

    it("preserves null provider-backed results", async () => {
        const provider = createProvider();
        vi.spyOn(provider, "getBlock").mockResolvedValue(null);
        vi.spyOn(provider, "getTransaction").mockResolvedValue(null);
        vi.spyOn(provider, "getTransactionReceipt").mockResolvedValue(null);
        vi.spyOn(provider, "waitForTransaction").mockResolvedValue(null);
        const { client } = createRetryableRpcAttempt(provider);

        await expect(Promise.all([
            client.getBlock(1),
            client.getTransaction(hash),
            client.getTransactionReceipt(hash),
            client.waitForTransaction(hash),
        ])).resolves.toEqual([null, null, null, null]);

        provider.destroy();
    });

    it("replaces provider references on all provider-backed result types", async () => {
        const provider = createProvider();
        const block = new Block({
            baseFeePerGas: 1n,
            difficulty: 1n,
            extraData: "0x",
            gasLimit: 1n,
            gasUsed: 1n,
            hash,
            miner: address,
            nonce: "0x0000000000000000",
            number: 1,
            parentHash: hash,
            timestamp: 1,
            transactions: [],
        }, provider);
        const log = new Log({
            address,
            blockHash: hash,
            blockNumber: 1,
            data: "0x",
            index: 0,
            removed: false,
            topics: [],
            transactionHash: hash,
            transactionIndex: 0,
        }, provider);
        const transaction = new TransactionResponse({
            accessList: null,
            authorizationList: null,
            blockHash: hash,
            blockNumber: 1,
            chainId: 1n,
            data: "0x",
            from: address,
            gasLimit: 1n,
            gasPrice: 1n,
            hash,
            index: 0,
            maxFeePerGas: null,
            maxPriorityFeePerGas: null,
            nonce: 0,
            signature: Signature.from({ r: hash, s: hash, v: 27 }),
            to: address,
            type: 0,
            value: 0n,
        }, provider);
        const receipt = new TransactionReceipt({
            blockHash: hash,
            blockNumber: 1,
            contractAddress: null,
            cumulativeGasUsed: 1n,
            from: address,
            gasPrice: 1n,
            gasUsed: 1n,
            hash,
            index: 0,
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            root: null,
            status: 1,
            to: address,
            type: 0,
        }, provider);
        vi.spyOn(provider, "getBlock").mockResolvedValue(block);
        vi.spyOn(provider, "getLogs").mockResolvedValue([log]);
        vi.spyOn(provider, "getTransaction").mockResolvedValue(transaction);
        vi.spyOn(provider, "getTransactionReceipt").mockResolvedValue(receipt);
        vi.spyOn(provider, "waitForBlock").mockResolvedValue(block);
        vi.spyOn(provider, "waitForTransaction").mockResolvedValue(receipt);
        const attempt = createRetryableRpcAttempt(provider);

        const results = [
            await attempt.client.getBlock(1),
            ...(await attempt.client.getLogs({})),
            await attempt.client.getTransaction("0x01"),
            await attempt.client.getTransactionReceipt("0x01"),
            await attempt.client.waitForBlock(1),
            await attempt.client.waitForTransaction("0x01"),
        ];
        const nonNullResults = results.filter((result) => result !== null);
        expect(nonNullResults).toHaveLength(6);
        for (const result of nonNullResults) {
            const broadcast: unknown = Reflect.get(result.provider, "broadcastTransaction");
            expect(result.provider).not.toBe(provider);
            expect("broadcastTransaction" in result.provider).toBe(false);
            expect(broadcast).toBeUndefined();
            expect(result.provider.provider).toBe(result.provider);
        }

        attempt.deactivate();
        await expect(block.provider.getBlockNumber()).rejects.toThrow("RPC client attempt is no longer active");
        provider.destroy();
    });
});
