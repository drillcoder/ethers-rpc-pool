import type { JsonRpcProvider, Provider } from "ethers";

import type * as publicApi from "../../src/index.js";
import type {
    RetryableRpcClient,
    RpcCooldownLoggerEvent,
    RpcEndpointExcludedReason,
    RpcEndpointSnapshot,
    RpcEndpointStatus,
    RpcErrorCategory,
    RpcErrorLoggerEvent,
    RpcExecutionOptions,
    RpcNetworkConfig,
    RpcNetworkSnapshot,
    RpcPoolLogger,
    RpcPoolLoggerEvent,
    RpcPoolManagerConfig,
    RpcPoolSnapshot,
    RpcRecoveryLoggerEvent,
    RpcRequestLoggerEvent,
    RpcResponseLoggerEvent,
    RpcSwitchLoggerEvent,
    SingleAttemptRpcClient,
} from "../../src/index.js";

type Equal<Left, Right> = [Left] extends [Right]
    ? [Right] extends [Left]
        ? true
        : false
    : false;

type Expect<Value extends true> = Value;

type RuntimeExportName =
    | "NoUsableRpcEndpointError"
    | "OperationTimeoutError"
    | "RpcEndpointDataError"
    | "RpcPoolClosedError"
    | "RpcPoolManager"
    | "UnknownNetworkError";

type TypeOnlyExportName =
    | "RetryableRpcClient"
    | "RpcCooldownLoggerEvent"
    | "RpcEndpointExcludedReason"
    | "RpcEndpointSnapshot"
    | "RpcEndpointStatus"
    | "RpcErrorCategory"
    | "RpcErrorLoggerEvent"
    | "RpcExecutionOptions"
    | "RpcNetworkConfig"
    | "RpcNetworkSnapshot"
    | "RpcPoolLogger"
    | "RpcPoolLoggerEvent"
    | "RpcPoolManagerConfig"
    | "RpcPoolSnapshot"
    | "RpcRecoveryLoggerEvent"
    | "RpcRequestLoggerEvent"
    | "RpcResponseLoggerEvent"
    | "RpcSwitchLoggerEvent"
    | "SingleAttemptRpcClient";

type ProviderNonRetryableMember =
    | "addListener"
    | "broadcastTransaction"
    | "destroy"
    | "emit"
    | "listenerCount"
    | "listeners"
    | "off"
    | "on"
    | "once"
    | "provider"
    | "removeAllListeners"
    | "removeListener"
    | "sendTransaction";

type ProviderReadMethod = Exclude<keyof Provider, ProviderNonRetryableMember>;
type ExpectedRetryableRpcClient = Pick<Provider, ProviderReadMethod>;

export type PublicTypeImports = [
    RetryableRpcClient,
    RpcCooldownLoggerEvent,
    RpcEndpointExcludedReason,
    RpcEndpointSnapshot,
    RpcEndpointStatus,
    RpcErrorCategory,
    RpcErrorLoggerEvent,
    RpcExecutionOptions,
    RpcNetworkConfig,
    RpcNetworkSnapshot,
    RpcPoolLogger,
    RpcPoolLoggerEvent,
    RpcPoolManagerConfig,
    RpcPoolSnapshot,
    RpcRecoveryLoggerEvent,
    RpcRequestLoggerEvent,
    RpcResponseLoggerEvent,
    RpcSwitchLoggerEvent,
    SingleAttemptRpcClient,
];

export type RuntimeExportsAreExact = Expect<
    Equal<keyof typeof publicApi, RuntimeExportName>
>;

export type TypeOnlyExportsHaveNoRuntimeValues = Expect<
    Equal<Extract<TypeOnlyExportName, keyof typeof publicApi>, never>
>;

export type RetryableClientMatchesProviderReads = Expect<
    Equal<RetryableRpcClient, ExpectedRetryableRpcClient>
>;

export type SingleAttemptClientMatchesJsonRpcProvider = Expect<
    Equal<SingleAttemptRpcClient, JsonRpcProvider>
>;
