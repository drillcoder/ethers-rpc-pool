import { Block, Log, TransactionReceipt, TransactionResponse } from "ethers";
import type { Provider } from "ethers";

import type { EndpointJsonRpcProvider } from "../transport/provider.js";
import type { RetryableRpcClient } from "./types.js";

export interface RetryableRpcAttempt {
    readonly client: RetryableRpcClient;
    deactivate(): void;
}

export class RetryableRpcCallError extends Error {
    public override readonly name = "RetryableRpcCallError";

    public constructor(cause: unknown) {
        super("Retryable RPC client call failed", { cause });
    }
}

export function createRetryableRpcAttempt(provider: EndpointJsonRpcProvider): RetryableRpcAttempt {
    let active = true;

    const assertActive = (): void => {
        if (!active) {
            throw new Error("RPC client attempt is no longer active");
        }
    };
    const runCall = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
        assertActive();
        try {
            return await operation();
        } catch (cause: unknown) {
            throw new RetryableRpcCallError(cause);
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
            return await runCall(async () => await provider.call(transaction));
        },
        estimateGas: async (transaction) => {
            return await runCall(async () => await provider.estimateGas(transaction));
        },
        getBalance: async (address, blockTag) => {
            return await runCall(async () => await provider.getBalance(address, blockTag));
        },
        getBlock: async (blockHashOrBlockTag, prefetchTxs) => {
            const block = await runCall(async () => await provider.getBlock(blockHashOrBlockTag, prefetchTxs));
            return block === null ? null : protectProvider(block);
        },
        getBlockNumber: async () => {
            return await runCall(async () => await provider.getBlockNumber());
        },
        getCode: async (address, blockTag) => {
            return await runCall(async () => await provider.getCode(address, blockTag));
        },
        getFeeData: async () => {
            return await runCall(async () => await provider.getFeeData());
        },
        getLogs: async (filter) => {
            return (await runCall(async () => await provider.getLogs(filter))).map(protectProvider);
        },
        getNetwork: async () => {
            return await runCall(async () => await provider.getNetwork());
        },
        getStorage: async (address, position, blockTag) => {
            return await runCall(async () => await provider.getStorage(address, position, blockTag));
        },
        getTransaction: async (hash) => {
            const transaction = await runCall(async () => await provider.getTransaction(hash));
            return transaction === null ? null : protectProvider(transaction);
        },
        getTransactionCount: async (address, blockTag) => {
            return await runCall(async () => await provider.getTransactionCount(address, blockTag));
        },
        getTransactionReceipt: async (hash) => {
            const receipt = await runCall(async () => await provider.getTransactionReceipt(hash));
            return receipt === null ? null : protectProvider(receipt);
        },
        getTransactionResult: async (hash) => {
            return await runCall(async () => await provider.getTransactionResult(hash));
        },
        lookupAddress: async (address, coinType) => {
            return await runCall(async () => await provider.lookupAddress(address, coinType));
        },
        resolveName: async (ensName, coinType) => {
            return await runCall(async () => await provider.resolveName(ensName, coinType));
        },
        waitForBlock: async (blockTag) => {
            return protectProvider(await runCall(async () => await provider.waitForBlock(blockTag)));
        },
        waitForTransaction: async (hash, confirms, timeout) => {
            const receipt = await runCall(async () => await provider.waitForTransaction(hash, confirms, timeout));
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
