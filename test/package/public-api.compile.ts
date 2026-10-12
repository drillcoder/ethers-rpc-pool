import type * as publicApi from "../../src/index.js";
import type {
    RpcBroadcastOptions,
    RpcBroadcastFailure,
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
    | "RpcBroadcastError"
    | "RpcEndpointDataError"
    | "RpcPoolClosedError"
    | "RpcPoolManager"
    | "UnknownNetworkError";

type TypeOnlyExportName =
    | "RpcBroadcastOptions"
    | "RpcBroadcastFailure"
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
    | "RpcSwitchLoggerEvent";

export type PublicTypeImports = [
    RpcBroadcastOptions,
    RpcBroadcastFailure,
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
];

export type RuntimeExportsAreExact = Expect<
    Equal<keyof typeof publicApi, RuntimeExportName>
>;

export type TypeOnlyExportsHaveNoRuntimeValues = Expect<
    Equal<Extract<TypeOnlyExportName, keyof typeof publicApi>, never>
>;

export type BroadcastReturnsHash = Expect<
    Equal<ReturnType<publicApi.RpcPoolManager["broadcastTransaction"]>, Promise<string>>
>;
