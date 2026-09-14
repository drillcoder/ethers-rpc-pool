import { Block, Log, TransactionReceipt, TransactionResponse } from "ethers";
import type { Provider } from "ethers";

import type { EndpointJsonRpcProvider } from "../transport/provider.js";
import type { RetryableRpcClient } from "./types.js";

export interface RetryableRpcAttempt {
    readonly client: RetryableRpcClient;
    deactivate(): void;
}

export function createRetryableRpcAttempt(provider: EndpointJsonRpcProvider): RetryableRpcAttempt {
    let active = true;

    const assertActive = (): void => {
        if (!active) {
            throw new Error("RPC client attempt is no longer active");
        }
    };
    const protectProvider = <Value>(value: Value): Value => {
        if (
            value instanceof Block
            || value instanceof Log
            || value instanceof TransactionReceipt
            || value instanceof TransactionResponse
        ) {
            Object.defineProperty(value, "provider", { value: guardedProvider });
        }

        return value;
    };
    const client: RetryableRpcClient = {
        call: async (transaction) => {
            assertActive();
            return await provider.call(transaction);
        },
        estimateGas: async (transaction) => {
            assertActive();
            return await provider.estimateGas(transaction);
        },
        getBalance: async (address, blockTag) => {
            assertActive();
            return await provider.getBalance(address, blockTag);
        },
        getBlock: async (blockHashOrBlockTag, prefetchTxs) => {
            assertActive();
            const block = await provider.getBlock(blockHashOrBlockTag, prefetchTxs);
            return block === null ? null : protectProvider(block);
        },
        getBlockNumber: async () => {
            assertActive();
            return await provider.getBlockNumber();
        },
        getCode: async (address, blockTag) => {
            assertActive();
            return await provider.getCode(address, blockTag);
        },
        getFeeData: async () => {
            assertActive();
            return await provider.getFeeData();
        },
        getLogs: async (filter) => {
            assertActive();
            return (await provider.getLogs(filter)).map(protectProvider);
        },
        getNetwork: async () => {
            assertActive();
            return await provider.getNetwork();
        },
        getStorage: async (address, position, blockTag) => {
            assertActive();
            return await provider.getStorage(address, position, blockTag);
        },
        getTransaction: async (hash) => {
            assertActive();
            const transaction = await provider.getTransaction(hash);
            return transaction === null ? null : protectProvider(transaction);
        },
        getTransactionCount: async (address, blockTag) => {
            assertActive();
            return await provider.getTransactionCount(address, blockTag);
        },
        getTransactionReceipt: async (hash) => {
            assertActive();
            const receipt = await provider.getTransactionReceipt(hash);
            return receipt === null ? null : protectProvider(receipt);
        },
        getTransactionResult: async (hash) => {
            assertActive();
            return await provider.getTransactionResult(hash);
        },
        lookupAddress: async (address, coinType) => {
            assertActive();
            return await provider.lookupAddress(address, coinType);
        },
        resolveName: async (ensName, coinType) => {
            assertActive();
            return await provider.resolveName(ensName, coinType);
        },
        waitForBlock: async (blockTag) => {
            assertActive();
            return protectProvider(await provider.waitForBlock(blockTag));
        },
        waitForTransaction: async (hash, confirms, timeout) => {
            assertActive();
            const receipt = await provider.waitForTransaction(hash, confirms, timeout);
            return receipt === null ? null : protectProvider(receipt);
        },
    };

    const guardedProvider: Provider = new Proxy(provider, {
        get: (_target, property, receiver) => {
            const value: unknown = property === "provider" ? receiver : Reflect.get(client, property);
            return value;
        },
        has: (_target, property) => property === "provider" || Reflect.has(client, property),
    });

    return {
        client: Object.freeze(client),
        deactivate: () => {
            active = false;
        },
    };
}
