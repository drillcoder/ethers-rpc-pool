# ethers-rpc-pool

<p align="center">
  <a href="https://www.npmjs.com/package/@drillcoder/ethers-rpc-pool"><img alt="npm" src="https://img.shields.io/npm/v/%40drillcoder%2Fethers-rpc-pool?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@drillcoder/ethers-rpc-pool"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40drillcoder%2Fethers-rpc-pool?style=flat-square"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/%40drillcoder%2Fethers-rpc-pool?style=flat-square"></a>
  <a href="https://github.com/drillcoder/ethers-rpc-pool/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/drillcoder/ethers-rpc-pool/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://codecov.io/gh/drillcoder/ethers-rpc-pool"><img alt="test coverage" src="https://codecov.io/gh/drillcoder/ethers-rpc-pool/branch/main/graph/badge.svg"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.x-3178c6?style=flat-square">
  <img alt="ethers" src="https://img.shields.io/badge/ethers-v6-2535a0?style=flat-square">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square">
</p>

🇬🇧 English | [🇷🇺 Русский](README.ru.md)

A resilient JSON-RPC endpoint pool for ethers v6 and Node.js. It selects an endpoint for each operation, tracks
latency and load, retries eligible operations, applies cooldowns after temporary failures, and permanently excludes
endpoints with invalid authorization or chain IDs.

## Installation

```sh
npm install @drillcoder/ethers-rpc-pool ethers
```

Requirements: Node.js 22 or newer, ethers v6, and ESM.

## Creating a pool

```ts runnable
import { RpcPoolManager } from "@drillcoder/ethers-rpc-pool";

const pool = new RpcPoolManager({
    networks: [{
        chainId: 1,
        rpcUrls: ["http://127.0.0.1:8545"],
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

`requestTimeoutMs` limits one HTTP request. `operationTimeoutMs` limits the complete operation, including chain ID
verification, callback execution, retries, cooldown waits, and endpoint switching. An individual operation can set a
different total limit with `{ timeoutMs }`.

`RpcPoolManager` owns its endpoint providers and must be closed when it is no longer needed.

## Retried operations

`executeWithRetry()` is intended for callbacks that may safely run again from the beginning. One endpoint remains
pinned for the duration of each attempt. A retryable endpoint failure starts a new attempt on an eligible endpoint
within the original operation deadline.

```ts
const account = "0x0000000000000000000000000000000000000000";

const state = await pool.executeWithRetry(
    1,
    async (provider) => {
        const [blockNumber, balance, transactionCount] = await Promise.all([
            provider.getBlockNumber(),
            provider.getBalance(account),
            provider.getTransactionCount(account),
        ]);

        return { balance, blockNumber, transactionCount };
    },
    { timeoutMs: 15_000 },
);
```

The callback receives an ethers `JsonRpcProvider` with its complete API, including contracts, signers, events, and
raw JSON-RPC calls:

```ts
const blockHex = await pool.executeWithRetry(
    1,
    async (provider) => await provider.send("eth_blockNumber", []),
);
```

The entire callback is the retry unit. Application side effects performed inside it must therefore be safe to repeat.

RPC retry eligibility follows the exact error object returned by the managed provider. Catching and rethrowing that
same object keeps the endpoint failure eligible for the normal retry policy:

```ts
await pool.executeWithRetry(1, async (provider) => {
    try {
        return await provider.getBlockNumber();
    } catch (error) {
        throw error;
    }
});
```

Throwing a new domain error, even with the RPC error as its `cause`, stops retry and passes the new error through:

```ts
await pool.executeWithRetry(1, async (provider) => {
    try {
        return await provider.getBlockNumber();
    } catch (error) {
        throw new Error("Unable to load the dashboard", { cause: error });
    }
});
```

## Single-attempt operations

`executeOnce()` starts the callback once. Use it for transaction submission and other operations whose result may be
unsafe to reproduce automatically.

```ts
import { Wallet } from "ethers";

const wallet = new Wallet(process.env.PRIVATE_KEY!);

const transaction = await pool.executeOnce(1, async (provider) => {
    const signer = wallet.connect(provider);
    return await signer.sendTransaction({
        to: "0x000000000000000000000000000000000000dEaD",
        value: 1n,
    });
});

console.log(transaction.hash);
```

If a write reaches the RPC server and the response is lost, the returned operation fails while the on-chain result is
unknown. Inspect the chain or application state before deciding whether to submit it again.

## Provider lifetime and listeners

Each endpoint has one shared `JsonRpcProvider` owned by the manager. Completing a callback leaves that provider and
its listeners active. A subscription created in a callback continues polling the same endpoint independently after
the callback finishes. Those background requests use the transport request timeout and observability, but not the
completed operation's group deadline, reservation, pool failover, or callback retry. Remove listeners that your code
adds:

```ts
await pool.executeOnce(1, async (provider) => {
    const listener = (blockNumber: number): void => {
        console.log(blockNumber);
    };

    await provider.on("block", listener);
    try {
        return await provider.getBlockNumber();
    } finally {
        await provider.off("block", listener);
    }
});
```

With `executeWithRetry()`, the entire callback may run again on another endpoint. Avoid registering the same listener
more than once, or clean it up before a retry can occur. `off()` and `removeAllListeners()` stop a subscription after
its last listener is removed; `pool.close()` stops background polling by destroying the endpoint providers.

Calling `destroy()` or changing provider-wide settings affects every user of that endpoint provider. A provider saved
and later used outside an execution callback sends requests directly to its fixed endpoint. Such calls use the
transport request timeout and observability, but do not participate in pool selection, retries, active groups, or an
earlier operation deadline. After `destroy()` or `pool.close()`, a saved provider rejects new network calls locally
with ethers code `UNSUPPORTED_OPERATION`; no HTTP request or pool transport event is produced.

An execution context closes when its attempt finishes. Asynchronous work that inherited that closed context cannot
start another managed HTTP request. This boundary applies to network requests; JavaScript work already started by the
callback continues according to normal JavaScript semantics.

## Endpoint selection

Primary `executeWithRetry()` operations first collect a real latency measurement from every free, eligible endpoint.
No separate warmup request is sent.

After initial measurement, normal selection minimizes:

```text
latencyEwmaMs × (activeGroups + 1)
```

Exact ties use round-robin order. Cooling, excluded, and occupied probe endpoints are filtered before ranking.

Every twentieth primary `executeWithRetry()` reservation is an exploration opportunity. When a free eligible
alternative exists, the pool chooses the endpoint that has gone longest without a reservation. Otherwise it uses the
normal winner and consumes that exploration position. Retries, cooldown waits, initial measurements, and
`executeOnce()` do not advance this counter.

Exploration uses the caller's real operation. It does not create background timers, additional callbacks, or duplicate
HTTP requests. Selection is a routing heuristic and does not guarantee a particular latency, block freshness, or
transaction inclusion time.

## Cancellation and errors

Both execution methods accept an `AbortSignal`:

```ts
const controller = new AbortController();
const operation = pool.executeWithRetry(
    1,
    async (provider) => await provider.getBlockNumber(),
    { signal: controller.signal },
);

controller.abort(new Error("Request cancelled by the caller"));
await operation;
```

The package exports these error classes:

- `UnknownNetworkError` — the requested chain ID is not configured.
- `NoUsableRpcEndpointError` — every endpoint for the network is permanently excluded.
- `OperationTimeoutError` — the total operation deadline expired.
- `RpcPoolClosedError` — an operation was started after the manager closed.
- `RpcEndpointDataError` — application code rejected structurally valid but unusable endpoint data.

An HTTP or JSON-RPC authorization failure permanently excludes that endpoint for the lifetime of the manager.
Temporary transport failures use cooldown and recovery rules. Local callback errors pass through without changing
endpoint health. Ethers errors, including contract `CALL_EXCEPTION` errors and revert data, retain their original
object identity and fields. An endpoint becomes eligible for a single probe after its cooldown; successful initial
measurement or twentieth-selection exploration recovers it. `RpcEndpointDataError` is intentionally different from a
generic domain error: it explicitly reports unusable endpoint data and applies the endpoint-data cooldown policy.

The transport accepts only a single matching JSON-RPC 2.0 response envelope with exactly one own `result` or `error`
field. Empty values such as `null`, `false`, `0`, and `""` are valid results. Invalid JSON, mismatched IDs, ambiguous
envelopes, and malformed errors are endpoint-data failures rather than successful `undefined` results. RPC provenance
belongs only to the exact error emitted by the transport; wrapping it in a new application error creates a new error
without that provenance.

## Snapshot and logger

`getSnapshot()` returns an immutable view of counters, active groups, endpoint status, cooldown deadlines, and latency
EWMA.

```ts
const snapshot = pool.getSnapshot();

for (const network of snapshot.networks) {
    for (const endpoint of network.endpoints) {
        console.log({
            chainId: network.chainId,
            endpointNumber: endpoint.endpointNumber,
            hostname: endpoint.hostname,
            status: endpoint.status,
            latencyEwmaMs: endpoint.latencyEwmaMs,
        });
    }
}
```

The optional logger receives `request`, `response`, `error`, `switch`, `cooldown`, and `recovery` events:

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
```

An endpoint is identified by `(chainId, endpointNumber, hostname)`. `hostname` is exactly
`new URL(rpcUrl).hostname`: it excludes userinfo, port, path, query, and fragment. Subdomains are preserved and may
contain an account identifier or internal name. The pool logger does not include the full URL, request or response
bodies, or external error text. Logger failures do not affect RPC execution.

## Development

- `npm run build` — build ESM JavaScript and TypeScript declarations.
- `npm run typecheck` — type-check source and compile-time API tests.
- `npm run lint` — run ESLint with zero warnings.
- `npm test` — run the Vitest suite.
- `npm run test:coverage` — run tests with 100% coverage thresholds.
- `npm run pack:test` — verify the installed npm tarball and runnable README example.
- `npm run quality` — run the complete quality gate.

The canonical quality gate can run with Docker and requires no Node.js installation or external RPC service on the
host:

```sh
docker build --tag ethers-rpc-pool-quality .
docker run --rm --network none ethers-rpc-pool-quality
```
