import type { EndpointJsonRpcProvider } from "../transport/provider.js";
import type { RetryableRpcClient } from "./types.js";

export function createRetryableRpcClient(provider: EndpointJsonRpcProvider): RetryableRpcClient {
    return Object.freeze({
        call: provider.call.bind(provider),
        estimateGas: provider.estimateGas.bind(provider),
        getBalance: provider.getBalance.bind(provider),
        getBlock: provider.getBlock.bind(provider),
        getBlockNumber: provider.getBlockNumber.bind(provider),
        getCode: provider.getCode.bind(provider),
        getFeeData: provider.getFeeData.bind(provider),
        getLogs: provider.getLogs.bind(provider),
        getNetwork: provider.getNetwork.bind(provider),
        getStorage: provider.getStorage.bind(provider),
        getTransaction: provider.getTransaction.bind(provider),
        getTransactionCount: provider.getTransactionCount.bind(provider),
        getTransactionReceipt: provider.getTransactionReceipt.bind(provider),
        getTransactionResult: provider.getTransactionResult.bind(provider),
        lookupAddress: provider.lookupAddress.bind(provider),
        resolveName: provider.resolveName.bind(provider),
        waitForBlock: provider.waitForBlock.bind(provider),
        waitForTransaction: provider.waitForTransaction.bind(provider),
    });
}
