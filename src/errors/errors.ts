export class RpcEndpointDataError extends Error {
    override readonly name = "RpcEndpointDataError";

    constructor(
        message = "RPC endpoint returned invalid data",
        options?: ErrorOptions,
    ) {
        super(message, options);
    }
}

export class UnknownNetworkError extends Error {
    override readonly name = "UnknownNetworkError";
    readonly chainId: number;

    constructor(chainId: number, options?: ErrorOptions) {
        super(`Network with chain ID ${String(chainId)} is not configured`, options);
        this.chainId = chainId;
    }
}

export class NoUsableRpcEndpointError extends Error {
    override readonly name = "NoUsableRpcEndpointError";
    readonly chainId: number;

    constructor(chainId: number, options?: ErrorOptions) {
        super(
            `Network with chain ID ${String(chainId)} has no usable RPC endpoints`,
            options,
        );
        this.chainId = chainId;
    }
}

export class OperationTimeoutError extends Error {
    override readonly name = "OperationTimeoutError";
    readonly chainId: number;
    readonly timeoutMs: number;

    constructor(chainId: number, timeoutMs: number, options?: ErrorOptions) {
        super(
            `RPC operation for chain ID ${String(chainId)} timed out after ${String(timeoutMs)} ms`,
            options,
        );
        this.chainId = chainId;
        this.timeoutMs = timeoutMs;
    }
}

export class RpcPoolClosedError extends Error {
    override readonly name = "RpcPoolClosedError";

    constructor(options?: ErrorOptions) {
        super("RPC pool manager is closed", options);
    }
}

export interface RpcBroadcastFailure {
    readonly endpointNumber: number;
    readonly error: unknown;
    readonly outcome: "not-sent" | "rejected" | "unknown";
}

export class RpcBroadcastError extends Error {
    override readonly name = "RpcBroadcastError";
    readonly chainId: number;
    readonly hash: string;
    readonly failures: readonly RpcBroadcastFailure[];

    constructor(chainId: number, hash: string, failures: readonly RpcBroadcastFailure[]) {
        super(`RPC broadcast for chain ID ${String(chainId)} received no confirmation`);
        this.chainId = chainId;
        this.hash = hash;
        this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
    }
}
