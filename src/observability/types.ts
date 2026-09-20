export type RpcErrorCategory =
    | "authorization"
    | "contract-execution"
    | "endpoint-data"
    | "http-5xx"
    | "network"
    | "quota-limit"
    | "rate-limit"
    | "timeout"
    | "unsupported-method"
    | "invalid-params"
    | "unknown";

export type RpcEndpointStatus =
    | "available"
    | "cooling-down"
    | "probe"
    | "excluded";

export type RpcEndpointExcludedReason =
    | "chain-id-mismatch"
    | "authorization"
    | null;

export interface RpcEndpointSnapshot {
    readonly endpointNumber: number;
    readonly hostname: string;
    readonly status: RpcEndpointStatus;
    readonly excludedReason: RpcEndpointExcludedReason;
    readonly activeGroups: number;
    readonly requestCount: number;
    readonly errorCount: number;
    readonly latencyEwmaMs: number | null;
    readonly cooldownUntil: number | null;
}

export interface RpcNetworkSnapshot {
    readonly chainId: number;
    readonly endpoints: readonly RpcEndpointSnapshot[];
}

export interface RpcPoolSnapshot {
    readonly closed: boolean;
    readonly totalRequests: number;
    readonly totalActiveGroups: number;
    readonly requestsByMethod: Readonly<Record<string, number>>;
    readonly errorsByCategory: Readonly<
        Partial<Record<RpcErrorCategory, number>>
    >;
    readonly networks: readonly RpcNetworkSnapshot[];
}

interface RpcPoolLoggerEventBase {
    readonly timestamp: number;
    readonly chainId: number;
    readonly endpointNumber: number;
    readonly hostname: string;
}

interface RpcTransportLoggerEventBase extends RpcPoolLoggerEventBase {
    readonly method: string;
    readonly startedAt: number;
}

export interface RpcRequestLoggerEvent extends RpcTransportLoggerEventBase {
    readonly type: "request";
}

export interface RpcResponseLoggerEvent extends RpcTransportLoggerEventBase {
    readonly type: "response";
    readonly finishedAt: number;
    readonly durationMs: number;
}

export interface RpcErrorLoggerEvent extends RpcTransportLoggerEventBase {
    readonly type: "error";
    readonly finishedAt: number;
    readonly durationMs: number;
    readonly category: RpcErrorCategory;
    readonly httpStatus?: number;
    readonly retryAfterMs?: number;
}

export interface RpcSwitchLoggerEvent extends RpcPoolLoggerEventBase {
    readonly type: "switch";
    readonly category: RpcErrorCategory;
    readonly nextEndpointNumber: number;
    readonly nextHostname: string;
}

export interface RpcCooldownLoggerEvent extends RpcPoolLoggerEventBase {
    readonly type: "cooldown";
    readonly category: RpcErrorCategory;
    readonly cooldownUntil: number;
}

export interface RpcRecoveryLoggerEvent extends RpcPoolLoggerEventBase {
    readonly type: "recovery";
}

export type RpcPoolLoggerEvent =
    | RpcRequestLoggerEvent
    | RpcResponseLoggerEvent
    | RpcErrorLoggerEvent
    | RpcSwitchLoggerEvent
    | RpcCooldownLoggerEvent
    | RpcRecoveryLoggerEvent;

export type RpcPoolLogger = (
    event: RpcPoolLoggerEvent,
) => void | Promise<void>;
