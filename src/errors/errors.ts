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
