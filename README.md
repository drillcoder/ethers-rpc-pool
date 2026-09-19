# ethers-rpc-pool

🇬🇧 English | [🇷🇺 Русский](README.ru.md)

A resilient TypeScript JSON-RPC endpoint pool for ethers v6 and Node.js. It balances concurrent operations,
cools down unhealthy endpoints, excludes invalid credentials or chain IDs, and exposes sanitized diagnostics.

## Installation

```sh
npm install @drillcoder/ethers-rpc-pool ethers
```

Node.js 22 or newer and ethers v6 are required. The package is ESM-only.

## Create and close a pool

`RpcPoolManager` owns its providers and timers. Always close it, preferably in `finally`:

```ts
import { RpcPoolManager } from "@drillcoder/ethers-rpc-pool";

const pool = new RpcPoolManager({
    networks: [{
        chainId: 1,
        rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
    }],
    requestTimeoutMs: 10_000,
    operationTimeoutMs: 30_000,
});

try {
    const blockNumber = await pool.executeWithRetry(1, async (client) => await client.getBlockNumber());
    console.log(blockNumber);
} finally {
    await pool.close();
}
```

When provided, `timeoutMs` becomes the operation's total time limit instead of the manager's `operationTimeoutMs`.
This limit covers endpoint validation, callback execution, retries, and cooldown waits.

## Retryable reads

Use `executeWithRetry()` for a group of read-only requests. One endpoint is pinned for the whole attempt. After a
retryable endpoint failure, the pool can run the callback again on another endpoint within the operation deadline.

```ts
const account = "0x0000000000000000000000000000000000000000";

const state = await pool.executeWithRetry(
    1,
    async (client) => {
        const [blockNumber, balance, transactionCount] = await Promise.all([
            client.getBlockNumber(),
            client.getBalance(account),
            client.getTransactionCount(account),
        ]);
        return { balance, blockNumber, transactionCount };
    },
    { timeoutMs: 15_000 },
);
```

`RetryableRpcClient` exposes the complete standard read, simulation, name-resolution, and wait API supported by the
pool:

- `getNetwork()`, `getBlockNumber()`, `getBlock()`
- `getBalance()`, `getTransactionCount()`, `getCode()`, `getStorage()`
- `getFeeData()`, `getLogs()`
- `getTransaction()`, `getTransactionReceipt()`, `getTransactionResult()`
- `call()`, `estimateGas()`
- `resolveName()`, `lookupAddress()`
- `waitForBlock()`, `waitForTransaction()`

It intentionally has no transaction broadcasting, raw JSON-RPC, subscriptions, or lifecycle methods.

## Single-attempt writes

Use `executeOnce()` for state-changing operations. Its client is compatible with ethers v6 `JsonRpcProvider`,
including `broadcastTransaction()`, raw `send()`, events, and connected signers.

```ts
import { Wallet } from "ethers";

const wallet = new Wallet(process.env.PRIVATE_KEY!);

const transaction = await pool.executeOnce(1, async (client) => {
    const signer = wallet.connect(client);
    return await signer.sendTransaction({
        to: "0x000000000000000000000000000000000000dEaD",
        value: 1n,
    });
});

console.log(transaction.hash);
```

Raw signed transactions can be sent in this mode with `client.broadcastTransaction(signedTransaction)`.

## Errors

Public errors are regular classes, so narrow them with `instanceof`:

```ts
import {
    NoUsableRpcEndpointError,
    OperationTimeoutError,
    RpcEndpointDataError,
    RpcPoolClosedError,
    UnknownNetworkError,
} from "@drillcoder/ethers-rpc-pool";

try {
    await pool.executeWithRetry(1, async (client) => {
        const block = await client.getBlock("latest");
        if (block === null) throw new RpcEndpointDataError("Latest block is missing");
        return block;
    });
} catch (error) {
    if (error instanceof UnknownNetworkError) {
        console.error("The chain is not configured", error.chainId);
    } else if (error instanceof NoUsableRpcEndpointError) {
        console.error("Every endpoint is permanently excluded", error.chainId);
    } else if (error instanceof OperationTimeoutError) {
        console.error("The operation timed out", error.timeoutMs);
    } else if (error instanceof RpcPoolClosedError) {
        console.error("The pool is closed");
    } else {
        throw error;
    }
}
```

Throw `RpcEndpointDataError` when an endpoint returned structurally valid but unusable data. The pool will treat that
endpoint as temporarily unhealthy.

## Cancellation

Both execution modes accept an `AbortSignal`. The returned promise rejects with the signal reason when one is set.

```ts
const controller = new AbortController();
const operation = pool.executeWithRetry(
    1,
    async (client) => await client.waitForBlock(20_000),
    { signal: controller.signal },
);

controller.abort(new Error("Request cancelled by the caller"));
await operation;
```

## Important execution semantics

- `executeWithRetry()` retries the entire callback, not only the failed RPC request. Any side effect performed by
  your callback outside the RPC client can therefore happen more than once. Keep the whole callback idempotent.
- Once an `executeOnce()` callback starts, the pool never runs it again. This prevents automatic duplicate writes,
  but does not guarantee exactly-once delivery.
- If a write reaches the RPC server but its response is lost, `executeOnce()` returns an error even though the write
  may have succeeded. Its result is unknown; inspect the chain or application state before deciding whether to retry.
- An endpoint that returns an HTTP or JSON-RPC authorization error remains excluded for the lifetime of the manager.
  Fix the credentials and create a new `RpcPoolManager` to use that endpoint again.
- Cancellation stops pool-managed waits and requests and settles the public promise promptly. It cannot forcibly stop
  synchronous code or other work started by a callback that does not cooperate with cancellation. Such code may keep
  running, but its pool client is deactivated and its eventual settlement is ignored. A blocked JavaScript event loop
  also delays cancellation handling.

## Snapshots, logging, and metrics

`getSnapshot()` returns an immutable view of request counters, categorized errors, active groups, latency EWMA,
cooldowns, and endpoint status. Endpoint identifiers are sanitized.

```ts
const snapshot = pool.getSnapshot();
console.log(snapshot.totalRequests, snapshot.errorsByCategory);

for (const network of snapshot.networks) {
    for (const endpoint of network.endpoints) {
        console.log(network.chainId, endpoint.endpointId, endpoint.status, endpoint.latencyEwmaMs);
    }
}
```

The logger receives `request`, `response`, `error`, `switch`, `cooldown`, and `recovery` events. A small adapter can
turn them into metrics without coupling the pool to a monitoring library:

```ts
import { RpcPoolManager, type RpcPoolLoggerEvent } from "@drillcoder/ethers-rpc-pool";

const counters = new Map<string, number>();
const recordMetric = (event: RpcPoolLoggerEvent): void => {
    const key = event.type === "error" ? `rpc.${event.type}.${event.category}` : `rpc.${event.type}`;
    counters.set(key, (counters.get(key) ?? 0) + 1);
};

const monitoredPool = new RpcPoolManager({
    networks: [{ chainId: 1, rpcUrls: ["https://ethereum-rpc.publicnode.com"] }],
    requestTimeoutMs: 10_000,
    operationTimeoutMs: 30_000,
    logger: recordMetric,
});

try {
    await monitoredPool.executeWithRetry(1, async (client) => await client.getBlockNumber());
} finally {
    await monitoredPool.close();
}
```

Logger failures are isolated from RPC operations. Endpoint IDs and error fields are sanitized before delivery.

## Development scripts

- `npm run build` — compile ESM JavaScript, declarations, declaration maps, and source maps.
- `npm run typecheck` — type-check production code and compile-time API tests without emitting files.
- `npm run lint` — run ESLint with zero warnings allowed.
- `npm run lint:fix` — apply safe ESLint fixes.
- `npm test` — run the hermetic Vitest suite.
- `npm run test:coverage` — run tests and verify 100% coverage for statements, branches, functions, and lines.
- `npm run pack:test` — build, pack, install, and verify the npm artifact in a clean ESM project.
- `npm run quality` — run the complete canonical quality gate.

## Docker quality gate

The complete quality gate requires only Docker on the host. It uses the pinned Node.js and npm versions and needs no
external RPC service:

```sh
docker build --tag ethers-rpc-pool-quality .
docker run --rm ethers-rpc-pool-quality
```

The container runs `npm run quality`: build, type checking, linting, hermetic tests, 100% coverage, and the package
smoke-test.
